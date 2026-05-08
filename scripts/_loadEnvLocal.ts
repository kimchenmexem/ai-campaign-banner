import { promises as fs } from "node:fs";
import path from "node:path";

// Load .env.local into process.env if present. Uses Node 20.12+'s
// process.loadEnvFile when available; otherwise parses KEY=VALUE manually.
// No-op when .env.local is missing.
export async function loadEnvLocalIfPresent(cwd: string = process.cwd()): Promise<boolean> {
  const filePath = path.join(cwd, ".env.local");
  try {
    await fs.access(filePath);
  } catch {
    return false;
  }
  const lf = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof lf === "function") {
    try {
      lf(filePath);
      return true;
    } catch {
      // fall through to manual parse
    }
  }
  const raw = await fs.readFile(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}
