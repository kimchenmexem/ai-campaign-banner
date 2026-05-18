// ─────────────────────────────────────────────────────────────────────────────
// Role model for the campaign system.
//
// Three roles, hierarchical: admin > editor > viewer.
//
//   admin   — full access, can cancel jobs and force-delete in-use assets
//   editor  — create / update / render / export / upload
//   viewer  — read-only (list campaigns, fetch job status, download artifacts)
//
// Roles are read server-side from one of (first match wins):
//   1. `app_metadata.roles: string[]` on the Supabase user (the trustworthy
//      path — service-role writes only, never editable by the user).
//   2. `user_roles` table keyed by `user_id`, if present (managed in SQL).
//   3. A static map from `AUTH_ADMIN_EMAILS` / `AUTH_EDITOR_EMAILS` env vars
//      so a fresh dev environment can grant access without provisioning DB
//      rows. This path is only consulted when 1 and 2 produce no role.
//
// Never trust `user_metadata` — that is user-editable on the client.
// ─────────────────────────────────────────────────────────────────────────────

export type Role = "admin" | "editor" | "viewer";

export const ROLE_ORDER: Role[] = ["viewer", "editor", "admin"];

export function roleAtLeast(actual: Role | null, required: Role): boolean {
  if (!actual) return false;
  return ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(required);
}

export function parseRole(raw: unknown): Role | null {
  if (raw !== "admin" && raw !== "editor" && raw !== "viewer") return null;
  return raw;
}
