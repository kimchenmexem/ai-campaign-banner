// No-op stub used only by `tsx` test runs (via tsconfig.test.json). The real
// `server-only` package throws to keep server-only modules out of client
// bundles; in unit tests there are no bundles, so we substitute this stub.
export {};
