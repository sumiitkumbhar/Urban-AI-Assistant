import { createClient } from "@supabase/supabase-js";

// Constructed lazily (on first use inside a request), not at module load.
// Next.js's build step ("Collecting page data") imports every API route
// module to statically analyze it, even when no request is being made -
// so an eager `const supabase = createClient(...)` at module scope made
// `npm run build` require live Supabase credentials just to compile, in
// every environment, forever. Deferring this to request time lets the
// app build without secrets and fail with a clear error only if a
// request actually comes in unconfigured.
//
// Typed as `any` deliberately: ReturnType<typeof createClient> resolves
// its generic differently and collapses `.rpc()`'s argument type to
// `undefined` for callers that don't supply a Database generic (none of
// them do here), so it's avoided rather than fought.
let _supabase: any = null;

export function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}
