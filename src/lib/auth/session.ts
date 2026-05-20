import "server-only";
import { createClient } from "@supabase/supabase-js";
import { parseRole, type Role } from "@/lib/auth/roles";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side session resolution.
//
// Two transports are accepted:
//   1. `Authorization: Bearer <jwt>` — Supabase access token. Standard SPA /
//      mobile pattern.
//   2. `sb-access-token` cookie — set by the Supabase JS client when the
//      browser logs in. Validates the JWT via the Supabase Auth API.
//
// Roles are derived from `app_metadata.roles[0]` first (service-role writes
// only), then a `user_roles` table lookup, then the env-var fallback so a
// freshly-installed instance can still admin itself.
//
// Returns `null` when no valid session is present. Never throws on missing
// headers — callers decide whether the lack of session is an error.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthSession {
  user_id: string;
  email: string | null;
  role: Role;
}

function readEmail(role: Role, email: string | null): boolean {
  if (!email) return false;
  const key =
    role === "admin"
      ? "AUTH_ADMIN_EMAILS"
      : role === "editor"
        ? "AUTH_EDITOR_EMAILS"
        : "AUTH_VIEWER_EMAILS";
  const raw = process.env[key] ?? "";
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

function readBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  // Fallback to Supabase JS client cookie. Supabase persists the access
  // token in `sb-<ref>-auth-token` JSON; readers also commonly set a
  // plain `sb-access-token` cookie. Accept either.
  const cookieHeader = req.headers.get("cookie") ?? "";
  if (!cookieHeader) return null;
  const direct = /(?:^|;\s*)sb-access-token=([^;]+)/.exec(cookieHeader);
  if (direct) return decodeURIComponent(direct[1]);
  // Supabase v2 cookie: a JSON array starting with [access_token, refresh_token].
  const json = /(?:^|;\s*)sb-[^=]+-auth-token=([^;]+)/.exec(cookieHeader);
  if (json) {
    try {
      const parsed = JSON.parse(decodeURIComponent(json[1]));
      if (Array.isArray(parsed) && typeof parsed[0] === "string") {
        return parsed[0];
      }
      if (parsed && typeof parsed === "object" && typeof parsed.access_token === "string") {
        return parsed.access_token;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function authEnabled(): boolean {
  // Auth is required by default. Setting AUTH_DISABLED=true (only honored
  // when NODE_ENV !== "production") lets a developer run locally without
  // wiring Supabase Auth. Never honored in production.
  if (process.env.NODE_ENV === "production") return true;
  return process.env.AUTH_DISABLED !== "true";
}

async function fetchRoleFromTable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any,
  userId: string,
): Promise<Role | null> {
  try {
    const { data, error } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return null;
    if (!data) return null;
    return parseRole((data as { role: unknown }).role);
  } catch {
    return null;
  }
}

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getServerSession(req: Request): Promise<AuthSession | null> {
  // Local-dev escape hatch — only when AUTH_DISABLED=true AND not production.
  if (!authEnabled()) {
    return {
      user_id: "local-dev",
      email: "dev@local",
      role: "admin",
    };
  }

  const token = readBearerToken(req);
  if (!token) return null;

  const service = createServiceClient();
  if (!service) return null;

  // Validate the JWT against Supabase Auth. `getUser(token)` makes a
  // server-to-server call so a forged-but-well-formed JWT is rejected.
  const { data, error } = await service.auth.getUser(token);
  if (error || !data?.user) return null;

  const user = data.user;
  // 1. app_metadata roles (service-role writes only — trustworthy)
  const meta = (user.app_metadata ?? {}) as { roles?: unknown; role?: unknown };
  let role: Role | null = null;
  if (Array.isArray(meta.roles)) {
    for (const candidate of meta.roles) {
      const r = parseRole(candidate);
      if (r) {
        role = role && roleHigher(role, r) ? role : r;
      }
    }
  }
  if (!role) role = parseRole(meta.role);

  // 2. user_roles table fallback
  if (!role) {
    role = await fetchRoleFromTable(service, user.id);
  }

  // 3. env-var allowlist fallback (dev / bootstrap)
  if (!role) {
    if (readEmail("admin", user.email ?? null)) role = "admin";
    else if (readEmail("editor", user.email ?? null)) role = "editor";
    else if (readEmail("viewer", user.email ?? null)) role = "viewer";
  }

  if (!role) return null;

  return {
    user_id: user.id,
    email: user.email ?? null,
    role,
  };
}

function roleHigher(a: Role, b: Role): boolean {
  const order: Role[] = ["viewer", "editor", "admin"];
  return order.indexOf(a) >= order.indexOf(b);
}
