import { v2 as cloudinary, type ConfigOptions } from "cloudinary";

// ─────────────────────────────────────────────────────────────────────────────
// Cloudinary client.
//
// Lazy-configured: getCloudinary() throws if any of the three required env
// vars (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)
// are missing, so the app boots fine with empty .env.local but any caller
// fails fast.
//
// Never log the API secret. `cloudinaryEnvStatus()` returns presence-only
// booleans for the diagnostics script, plus the cloud name (which is public-
// safe and useful in logs).
// ─────────────────────────────────────────────────────────────────────────────

let configured = false;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function getCloudinary(): typeof cloudinary {
  if (!configured) {
    const cfg: ConfigOptions = {
      cloud_name: requireEnv("CLOUDINARY_CLOUD_NAME"),
      api_key: requireEnv("CLOUDINARY_API_KEY"),
      api_secret: requireEnv("CLOUDINARY_API_SECRET"),
      secure: true,
    };
    cloudinary.config(cfg);
    configured = true;
  }
  return cloudinary;
}

export interface CloudinaryEnvStatus {
  cloud_name_present: boolean;
  api_key_present: boolean;
  api_secret_present: boolean;
  cloud_name_value: string | null; // Public-safe; OK to log.
}

/**
 * Snapshot of which env vars the Cloudinary client would consume. Returns
 * only presence flags + the cloud name (which is not sensitive). The API key
 * and secret are never returned.
 */
export function cloudinaryEnvStatus(): CloudinaryEnvStatus {
  const cn = process.env.CLOUDINARY_CLOUD_NAME;
  return {
    cloud_name_present: !!cn,
    api_key_present: !!process.env.CLOUDINARY_API_KEY,
    api_secret_present: !!process.env.CLOUDINARY_API_SECRET,
    cloud_name_value: cn ?? null,
  };
}
