import "server-only";
import sharp from "sharp";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Image upload validator. Replaces the extension-only check that previously
// gated /api/midjourney/uploads and /api/upload-asset.
//
// Layers, in order:
//   1. Size limit  (UPLOAD_MAX_BYTES env, default 8 MB)
//   2. Declared MIME type  (must be in the allowlist)
//   3. Magic-byte sniff  (resists clients renaming .exe → .png)
//   4. Sharp decode + re-encode  (rejects malformed images and strips EXIF)
//   5. Content hash  (sha-256 of the canonical bytes — collision-safe names)
//
// Pluggable scanner hook for malware/content scanning. In production, if
// UPLOAD_REQUIRE_SCANNER=true and no scanner is configured, every upload is
// rejected — fail-closed.
// ─────────────────────────────────────────────────────────────────────────────

export type AllowedMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp";

const MIME_TO_EXT: Record<AllowedMime, "png" | "jpg" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// Magic-byte signatures — first N bytes must match one of these for the
// declared MIME to be accepted.
const SIGNATURES: { mime: AllowedMime; prefix: number[] }[] = [
  { mime: "image/png", prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", prefix: [0xff, 0xd8, 0xff] },
  // WebP: "RIFF....WEBP". We check the RIFF prefix and the "WEBP" marker at
  // offset 8.
  { mime: "image/webp", prefix: [0x52, 0x49, 0x46, 0x46] },
];

export interface ValidatedImage {
  bytes: Buffer;
  mime: AllowedMime;
  ext: "png" | "jpg" | "webp";
  width: number;
  height: number;
  size_bytes: number;
  sha256: string;
  // Sanitized basename derived from sha256 — safe to use as a filename without
  // sanitizing further. Always lowercase hex + extension.
  safe_filename: string;
}

export interface ValidateOptions {
  // Maximum bytes; default UPLOAD_MAX_BYTES env or 8 MB.
  maxBytes?: number;
  // Optional override of accepted MIME types.
  allowedMimes?: readonly AllowedMime[];
  // Maximum pixel dimension (width or height). Default 6000.
  maxPixels?: number;
}

export class UploadValidationError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 415) {
    super(message);
    this.name = "UploadValidationError";
    this.code = code;
    this.status = status;
  }
}

function defaultMaxBytes(): number {
  const raw = process.env.UPLOAD_MAX_BYTES;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 8 * 1024 * 1024;
}

function sniffMime(buf: Buffer): AllowedMime | null {
  for (const sig of SIGNATURES) {
    if (buf.length < sig.prefix.length) continue;
    let match = true;
    for (let i = 0; i < sig.prefix.length; i++) {
      if (buf[i] !== sig.prefix[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (sig.mime === "image/webp") {
      // Confirm "WEBP" at offset 8
      if (
        buf.length >= 12 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      ) {
        return "image/webp";
      }
      continue;
    }
    return sig.mime;
  }
  return null;
}

export async function validateImageUpload(
  file: File,
  opts: ValidateOptions = {},
): Promise<ValidatedImage> {
  const allowed = opts.allowedMimes ?? (Object.keys(MIME_TO_EXT) as AllowedMime[]);
  const maxBytes = opts.maxBytes ?? defaultMaxBytes();
  const maxPixels = opts.maxPixels ?? 6000;

  if (file.size <= 0) {
    throw new UploadValidationError("empty_file", "Uploaded file is empty", 400);
  }
  if (file.size > maxBytes) {
    throw new UploadValidationError(
      "file_too_large",
      `File ${file.size} bytes exceeds limit ${maxBytes} bytes`,
      413,
    );
  }

  const declaredMime = (file.type ?? "").toLowerCase();
  if (!allowed.includes(declaredMime as AllowedMime)) {
    throw new UploadValidationError(
      "unsupported_mime",
      `Declared MIME "${declaredMime}" not in allowlist (${allowed.join(", ")})`,
      415,
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length !== file.size) {
    throw new UploadValidationError(
      "size_mismatch",
      "Stream byte count did not match File.size",
      400,
    );
  }
  // Re-check after read, in case content-length lied.
  if (buf.length > maxBytes) {
    throw new UploadValidationError(
      "file_too_large",
      `File ${buf.length} bytes exceeds limit ${maxBytes} bytes`,
      413,
    );
  }

  const sniffed = sniffMime(buf);
  if (!sniffed) {
    throw new UploadValidationError(
      "unknown_image_signature",
      "Could not sniff image signature from leading bytes",
      415,
    );
  }
  if (sniffed !== declaredMime) {
    throw new UploadValidationError(
      "mime_mismatch",
      `Declared "${declaredMime}" but bytes look like "${sniffed}"`,
      415,
    );
  }

  // Decode via sharp — this rejects malformed payloads (zip bomb, jpeg of
  // death, malformed PNG chunks) before we touch the filesystem.
  let metadata: sharp.Metadata;
  let canonical: Buffer;
  try {
    const pipeline = sharp(buf, { failOn: "warning" });
    metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Sharp did not report width/height");
    }
    if (metadata.width > maxPixels || metadata.height > maxPixels) {
      throw new UploadValidationError(
        "dimensions_too_large",
        `Image ${metadata.width}x${metadata.height} exceeds max pixel dimension ${maxPixels}`,
        413,
      );
    }
    // Re-encode to strip EXIF/XMP and drop any embedded ICC profile risk.
    // Re-encode preserves visual content but eliminates the metadata vector.
    if (sniffed === "image/png") {
      canonical = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else if (sniffed === "image/jpeg") {
      canonical = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    } else {
      canonical = await pipeline.webp({ quality: 92 }).toBuffer();
    }
  } catch (err) {
    if (err instanceof UploadValidationError) throw err;
    throw new UploadValidationError(
      "decode_failed",
      `Image decode failed: ${(err as Error).message}`,
      415,
    );
  }

  // Optional content scanner. Hook is via an env-named module so we don't
  // import a hard dependency. The scanner module must default-export
  // `scan(buffer): Promise<{ clean: boolean, signature?: string }>`.
  const scannerPath = process.env.UPLOAD_SCANNER_MODULE;
  const requireScanner = process.env.UPLOAD_REQUIRE_SCANNER === "true";
  if (scannerPath) {
    type Scanner = (b: Buffer) => Promise<{ clean: boolean; signature?: string }>;
    try {
      const mod = (await import(/* webpackIgnore: true */ scannerPath)) as {
        default?: Scanner;
        scan?: Scanner;
      };
      const scan: Scanner | undefined = mod.scan ?? mod.default;
      if (!scan) {
        throw new Error("scanner module exports neither `scan` nor default");
      }
      const result = await scan(canonical);
      if (!result.clean) {
        throw new UploadValidationError(
          "scanner_rejected",
          `Content scanner rejected upload${
            result.signature ? ` (${result.signature})` : ""
          }`,
          422,
        );
      }
    } catch (err) {
      if (err instanceof UploadValidationError) throw err;
      throw new UploadValidationError(
        "scanner_error",
        `Content scanner failed: ${(err as Error).message}`,
        500,
      );
    }
  } else if (requireScanner) {
    throw new UploadValidationError(
      "scanner_required",
      "UPLOAD_REQUIRE_SCANNER=true but UPLOAD_SCANNER_MODULE is not configured",
      503,
    );
  }

  const sha256 = crypto.createHash("sha256").update(canonical).digest("hex");
  const ext = MIME_TO_EXT[sniffed];
  return {
    bytes: canonical,
    mime: sniffed,
    ext,
    width: metadata.width!,
    height: metadata.height!,
    size_bytes: canonical.length,
    sha256,
    safe_filename: `${sha256}.${ext}`,
  };
}
