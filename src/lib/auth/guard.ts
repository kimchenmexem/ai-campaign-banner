import "server-only";
import { NextResponse } from "next/server";
import { roleAtLeast, type Role } from "@/lib/auth/roles";
import { getServerSession, type AuthSession } from "@/lib/auth/session";

// ─────────────────────────────────────────────────────────────────────────────
// Route-handler guard. Pattern at the top of every protected route:
//
//   export async function POST(request: Request) {
//     const auth = await requireRole(request, "editor");
//     if (auth instanceof NextResponse) return auth;
//     // …auth.user_id / auth.role are guaranteed beyond this point
//   }
//
// Returns either an `AuthSession` (caller proceeds) or a `NextResponse` with
// the right status (401 unauthenticated, 403 wrong role, 503 misconfigured).
// ─────────────────────────────────────────────────────────────────────────────

export async function requireRole(
  request: Request,
  required: Role,
): Promise<AuthSession | NextResponse> {
  const session = await getServerSession(request);
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  if (!roleAtLeast(session.role, required)) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden",
        required_role: required,
        actual_role: session.role,
      },
      { status: 403 },
    );
  }
  return session;
}

// Dev-only routes (anything that mutates the repo's `data/` or `public/`
// directories). Refuses with 404 in production unless the explicit
// ALLOW_LOCAL_FS_WRITES=true flag is set. The flag is documented as for
// emergency local-prod testing only.
export function refuseInProduction(): NextResponse | null {
  if (process.env.NODE_ENV !== "production") return null;
  if (process.env.ALLOW_LOCAL_FS_WRITES === "true") return null;
  return NextResponse.json(
    { ok: false, error: "not_available_in_production" },
    { status: 404 },
  );
}
