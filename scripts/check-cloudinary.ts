#!/usr/bin/env tsx
/**
 * Cloudinary diagnostics — no uploads, no secrets in logs.
 * Run with: `npm run cloudinary:check`
 *
 * Prints presence of each required env var and pings the Cloudinary API to
 * confirm the credentials authenticate. Failure is non-zero exit.
 */
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { cloudinaryEnvStatus, getCloudinary } from "@/lib/cloudinary/client";

async function main() {
  console.log("Cloudinary diagnostics — no uploads will be performed.\n");
  const loaded = await loadEnvLocalIfPresent();
  if (loaded) console.log("✓ Loaded .env.local");

  const status = cloudinaryEnvStatus();
  const ok = (b: boolean) => (b ? "yes" : "NO");
  console.log(`  Cloud name present:   ${ok(status.cloud_name_present)} (${status.cloud_name_value ?? "—"})`);
  console.log(`  API key present:      ${ok(status.api_key_present)}`);
  console.log(`  API secret present:   ${ok(status.api_secret_present)}`);

  if (!status.cloud_name_present || !status.api_key_present || !status.api_secret_present) {
    console.error("\n✗ One or more Cloudinary env vars are missing. Add them to .env.local:");
    console.error("    CLOUDINARY_CLOUD_NAME=...");
    console.error("    CLOUDINARY_API_KEY=...");
    console.error("    CLOUDINARY_API_SECRET=...");
    process.exit(2);
  }

  // Ping the API to verify auth. cloudinary.api.ping() returns { status: "ok" }
  // on success; throws on auth failure or network error.
  try {
    const cloudinary = getCloudinary();
    const result = await cloudinary.api.ping();
    if (result?.status === "ok") {
      console.log("\n✓ Cloudinary connection: ok");
    } else {
      console.log(`\n· Cloudinary connection: ${JSON.stringify(result)}`);
    }
  } catch (err) {
    console.error("\n✗ Cloudinary connection failed:");
    console.error("  ", redact((err as Error).message));
    process.exit(3);
  }
}

// Strip api_key/api_secret/signature query params from any error message.
function redact(msg: string): string {
  return msg
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/api_secret=[^&\s)]*/gi, "api_secret=[redacted]")
    .replace(/signature=[^&\s)]*/gi, "signature=[redacted]");
}

main().catch((err) => {
  console.error("cloudinary:check failed:", redact((err as Error).message));
  process.exit(1);
});
