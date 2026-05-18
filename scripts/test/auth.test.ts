/* eslint-disable no-console */
import { test, runTests, assert, assertEqual } from "./harness";
import { roleAtLeast, parseRole } from "@/lib/auth/roles";

test("role hierarchy: admin > editor > viewer", () => {
  assert(roleAtLeast("admin", "viewer"));
  assert(roleAtLeast("admin", "editor"));
  assert(roleAtLeast("admin", "admin"));
  assert(roleAtLeast("editor", "viewer"));
  assert(roleAtLeast("editor", "editor"));
  assert(!roleAtLeast("editor", "admin"));
  assert(roleAtLeast("viewer", "viewer"));
  assert(!roleAtLeast("viewer", "editor"));
  assert(!roleAtLeast("viewer", "admin"));
});

test("role hierarchy: null actual is never sufficient", () => {
  assert(!roleAtLeast(null, "viewer"));
  assert(!roleAtLeast(null, "editor"));
  assert(!roleAtLeast(null, "admin"));
});

test("parseRole rejects unknown values", () => {
  assertEqual(parseRole("admin"), "admin");
  assertEqual(parseRole("editor"), "editor");
  assertEqual(parseRole("viewer"), "viewer");
  assertEqual(parseRole("superuser"), null);
  assertEqual(parseRole(42), null);
  assertEqual(parseRole(null), null);
});

// process.env is a special object; node treats unknown props as strings,
// but TS marks NODE_ENV readonly. setEnv() casts through to mutate.
function setEnv(key: string, value: string | undefined) {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

test("refuseInProduction blocks in NODE_ENV=production without flag", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevFlag = process.env.ALLOW_LOCAL_FS_WRITES;
  try {
    setEnv("NODE_ENV", "production");
    setEnv("ALLOW_LOCAL_FS_WRITES", undefined);
    const { refuseInProduction } = await import("@/lib/auth/guard");
    const r = refuseInProduction();
    assert(r !== null, "expected NextResponse with 404");
    assertEqual(r!.status, 404);
  } finally {
    setEnv("NODE_ENV", prevEnv);
    setEnv("ALLOW_LOCAL_FS_WRITES", prevFlag);
  }
});

test("refuseInProduction respects ALLOW_LOCAL_FS_WRITES=true", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevFlag = process.env.ALLOW_LOCAL_FS_WRITES;
  try {
    setEnv("NODE_ENV", "production");
    setEnv("ALLOW_LOCAL_FS_WRITES", "true");
    const { refuseInProduction } = await import("@/lib/auth/guard");
    const r = refuseInProduction();
    assert(r === null, "expected null (not blocked)");
  } finally {
    setEnv("NODE_ENV", prevEnv);
    setEnv("ALLOW_LOCAL_FS_WRITES", prevFlag);
  }
});

test("rate limiter blocks when bucket exceeds max", async () => {
  const { enforceRateLimit, _resetRateLimits } = await import("@/lib/auth/rateLimit");
  _resetRateLimits();
  const req = new Request("http://t/x", { headers: { "x-forwarded-for": "10.0.0.1" } });
  const session = { user_id: "u1", email: "u@t", role: "editor" as const };
  for (let i = 0; i < 5; i++) {
    const r = enforceRateLimit(req, { windowMs: 60_000, max: 5, scope: "tt" }, session);
    assert(r === null, `iter ${i} should not be rate limited`);
  }
  const sixth = enforceRateLimit(req, { windowMs: 60_000, max: 5, scope: "tt" }, session);
  assert(sixth !== null, "sixth call should be rate limited");
  assertEqual(sixth!.status, 429);
  _resetRateLimits();
});

runTests();
