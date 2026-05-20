import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
// AssetStorage abstraction.
//
// Two implementations:
//   - LocalAssetStorage   — writes to `public/<rootDir>/...` so the dev
//                            server can serve the files directly. Refuses
//                            to run in production unless explicitly opted in
//                            with ALLOW_LOCAL_FS_WRITES=true.
//   - SupabaseAssetStorage — uses Supabase Storage. Returns time-limited
//                            signed URLs so callers can render the file
//                            without making the bucket public.
//
// `getAssetStorage()` returns the right implementation based on env. The
// returned API exposes:
//   put(key, bytes, contentType) → { key, public_url?, signed_url? }
//   delete(key) → void
//   signedUrl(key, ttlSec) → string
// ─────────────────────────────────────────────────────────────────────────────

export interface PutResult {
  key: string;
  // Set when the file is exposed via a CDN / public path (local-dev only).
  public_url: string | null;
  // Set when the file is private and the caller needs a short-lived URL.
  signed_url: string | null;
  bytes: number;
  content_type: string;
}

export interface AssetStorage {
  readonly kind: "local" | "supabase";
  put(
    key: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<PutResult>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSec?: number): Promise<string>;
}

// ─── Local FS implementation (dev only) ─────────────────────────────────────
class LocalAssetStorage implements AssetStorage {
  readonly kind = "local" as const;
  constructor(
    private readonly cwd: string,
    private readonly publicSubdir: string,
  ) {}

  private absPath(key: string): string {
    const safe = sanitizeKey(key);
    return path.join(this.cwd, "public", this.publicSubdir, safe);
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<PutResult> {
    const abs = this.absPath(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    return {
      key,
      public_url: `/${this.publicSubdir}/${sanitizeKey(key)}`,
      signed_url: null,
      bytes: bytes.length,
      content_type: contentType,
    };
  }
  async delete(key: string): Promise<void> {
    const abs = this.absPath(key);
    try {
      await fs.unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  async signedUrl(key: string): Promise<string> {
    return `/${this.publicSubdir}/${sanitizeKey(key)}`;
  }
}

// ─── Supabase Storage implementation (production) ───────────────────────────
class SupabaseAssetStorage implements AssetStorage {
  readonly kind = "supabase" as const;
  private client: ReturnType<typeof createClient>;
  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string,
  ) {
    this.client = createClient(this.url, this.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<PutResult> {
    const safe = sanitizeKey(key);
    const { error } = await this.client.storage.from(this.bucket).upload(
      safe,
      bytes,
      {
        contentType,
        upsert: true,
      },
    );
    if (error) throw new Error(`supabase storage put failed: ${error.message}`);
    return {
      key: safe,
      public_url: null,
      signed_url: await this.signedUrl(safe),
      bytes: bytes.length,
      content_type: contentType,
    };
  }
  async delete(key: string): Promise<void> {
    const safe = sanitizeKey(key);
    const { error } = await this.client.storage.from(this.bucket).remove([safe]);
    if (error) throw new Error(`supabase storage delete failed: ${error.message}`);
  }
  async signedUrl(key: string, ttlSec = 3600): Promise<string> {
    const safe = sanitizeKey(key);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(safe, ttlSec);
    if (error || !data) {
      throw new Error(
        `supabase storage signed url failed: ${error?.message ?? "unknown"}`,
      );
    }
    return data.signedUrl;
  }
}

// Object keys can come from request bodies; defend against traversal here.
function sanitizeKey(key: string): string {
  // Drop leading slashes, collapse repeats, refuse "..".
  const cleaned = key
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..")
    .join("/");
  if (cleaned === "") throw new Error("invalid empty key");
  if (!/^[A-Za-z0-9._\-/]+$/.test(cleaned)) {
    throw new Error(`invalid characters in key: ${key}`);
  }
  return cleaned;
}

// ─── Factory ────────────────────────────────────────────────────────────────
interface FactoryEnv {
  NODE_ENV?: string;
  STORAGE_DRIVER?: string;
  ALLOW_LOCAL_FS_WRITES?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  STORAGE_BUCKET_UPLOADS?: string;
  STORAGE_BUCKET_GENERATED?: string;
  STORAGE_BUCKET_EXPORTS?: string;
}

type Bucket = "uploads" | "generated" | "exports";

function bucketFor(env: FactoryEnv, bucket: Bucket): string {
  if (bucket === "uploads") return env.STORAGE_BUCKET_UPLOADS ?? "campaign-uploads";
  if (bucket === "generated") return env.STORAGE_BUCKET_GENERATED ?? "campaign-generated";
  return env.STORAGE_BUCKET_EXPORTS ?? "campaign-exports";
}

function publicDirFor(bucket: Bucket): string {
  if (bucket === "uploads") return "midjourney-uploads";
  if (bucket === "generated") return "generated-assets";
  return "campaign-exports";
}

export function getAssetStorage(bucket: Bucket = "uploads"): AssetStorage {
  const env = process.env as FactoryEnv;
  const driver = (env.STORAGE_DRIVER ?? "").toLowerCase();

  if (driver === "supabase" || env.NODE_ENV === "production") {
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "AssetStorage: Supabase storage requested but NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.",
      );
    }
    return new SupabaseAssetStorage(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      bucketFor(env, bucket),
    );
  }

  // Local fallback. Fail-closed in production unless explicitly opted in.
  if (env.NODE_ENV === "production" && env.ALLOW_LOCAL_FS_WRITES !== "true") {
    throw new Error(
      "AssetStorage: refusing to use local filesystem storage in production. Set STORAGE_DRIVER=supabase or (only for emergencies) ALLOW_LOCAL_FS_WRITES=true.",
    );
  }
  return new LocalAssetStorage(process.cwd(), publicDirFor(bucket));
}
