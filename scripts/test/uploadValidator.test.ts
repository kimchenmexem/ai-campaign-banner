/* eslint-disable no-console */
import { test, runTests, assert, assertEqual } from "./harness";
import sharp from "sharp";
import {
  UploadValidationError,
  validateImageUpload,
} from "@/lib/uploads/validateImageUpload";

function fileFromBuffer(buf: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(buf)], name, { type });
}

async function pngBuffer(w = 32, h = 32): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 0, g: 128, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function jpegBuffer(w = 32, h = 32): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 200, g: 50, b: 50 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function webpBuffer(w = 32, h = 32): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 30, g: 80, b: 200 },
    },
  })
    .webp({ quality: 80 })
    .toBuffer();
}

test("accepts valid PNG", async () => {
  const buf = await pngBuffer();
  const v = await validateImageUpload(fileFromBuffer(buf, "x.png", "image/png"));
  assertEqual(v.mime, "image/png");
  assert(v.width === 32 && v.height === 32);
  assert(v.sha256.length === 64);
});

test("accepts valid JPEG", async () => {
  const buf = await jpegBuffer();
  const v = await validateImageUpload(fileFromBuffer(buf, "x.jpg", "image/jpeg"));
  assertEqual(v.mime, "image/jpeg");
});

test("accepts valid WebP", async () => {
  const buf = await webpBuffer();
  const v = await validateImageUpload(fileFromBuffer(buf, "x.webp", "image/webp"));
  assertEqual(v.mime, "image/webp");
});

test("rejects on size limit", async () => {
  const buf = await pngBuffer(2000, 2000);
  try {
    await validateImageUpload(fileFromBuffer(buf, "x.png", "image/png"), {
      maxBytes: 1000,
    });
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof UploadValidationError);
    assertEqual((err as UploadValidationError).code, "file_too_large");
    assertEqual((err as UploadValidationError).status, 413);
  }
});

test("rejects wrong MIME declaration vs magic bytes", async () => {
  const buf = await pngBuffer();
  try {
    // PNG bytes but client says JPEG
    await validateImageUpload(fileFromBuffer(buf, "x.jpg", "image/jpeg"));
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof UploadValidationError);
    assertEqual((err as UploadValidationError).code, "mime_mismatch");
  }
});

test("rejects unknown MIME declaration", async () => {
  const buf = await pngBuffer();
  try {
    await validateImageUpload(fileFromBuffer(buf, "x.gif", "image/gif"));
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof UploadValidationError);
    assertEqual((err as UploadValidationError).code, "unsupported_mime");
  }
});

test("rejects malformed image bytes", async () => {
  const garbage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
  try {
    await validateImageUpload(fileFromBuffer(garbage, "x.png", "image/png"));
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof UploadValidationError);
    assert(
      (err as UploadValidationError).code === "decode_failed" ||
        (err as UploadValidationError).code === "unknown_image_signature",
    );
  }
});

test("rejects empty file", async () => {
  try {
    await validateImageUpload(new File([], "x.png", { type: "image/png" }));
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof UploadValidationError);
    assertEqual((err as UploadValidationError).code, "empty_file");
  }
});

runTests();
