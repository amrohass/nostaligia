// CORS and JSON responses, shared by every Edge Function.
//
// Extracted from request-upload when complete-upload needed the same behaviour. §2 asks
// for every origin and CORS value in one place; two functions with their own copy of an
// allowlist is exactly the drift that rule exists to stop — and the copy that drifts is
// always the one nobody is looking at.

/**
 * Origins come from the environment, never from a constant. A deployed function cannot
 * read config/site.json, so UPLOAD_ALLOWED_ORIGINS carries the list (the generator in
 * scripts/build-site-config.mjs prints the exact value to set).
 *
 * An unset variable yields no CORS headers at all. That fails closed for browsers while
 * leaving curl — which sends no Origin — working, so an endpoint stays testable before
 * the front end exists. It must never fall back to permissive: that variable will be
 * unset on the day someone stands up a new environment and forgets it.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  const allowed = (Deno.env.get("UPLOAD_ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/**
 * Every header the front end is permitted to send to a function.
 *
 * `apikey` is here because the front end sends it, and that is the whole reason this list
 * is a named constant rather than a string literal. It was omitted until 29 Aug 2026, and
 * the failure it caused is worth recording because nothing about it pointed here:
 *
 *   Access to fetch at '…/functions/v1/request-upload' from origin
 *   'https://nostaligia.pages.dev' has been blocked by CORS policy: Request header field
 *   apikey is not allowed by Access-Control-Allow-Headers in preflight response.
 *
 * The browser fails the preflight BEFORE any request reaches the function, so `fetch()`
 * rejects with a bare TypeError, and upload.js's rejection handler maps every TypeError to
 * `up.err.offline` — "لا يوجد اتصال" — which sends whoever is debugging it to look at the
 * network, the origin allowlist, and Turnstile, none of which were wrong. The origin
 * allowlist in particular ANSWERED CORRECTLY throughout: `curl -X OPTIONS` returned a
 * 204 with the right Allow-Origin, because curl does not enforce what it is told. Only a
 * browser fails this, and only on the header line.
 *
 * Two rules for anything added here:
 *   - it must be a header the front end actually sends — scripts/frontend-cors-test.mjs
 *     compares this list against what site/assets/js really puts on a functions/v1 fetch,
 *     in both directions, so a header removed from the client must be removed here too;
 *   - allowing a header grants nothing. This list governs what a browser may SEND, not
 *     what the function trusts. `apikey` carries the anon key, which §6 states plainly is
 *     public by design; authorization carries the caller's own JWT, which PostgREST
 *     verifies independently (see rpc() below).
 */
export const ALLOWED_REQUEST_HEADERS = ["apikey", "authorization", "content-type"];

export function json(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

export function fail(error: string, status: number, req: Request, detail?: unknown) {
  return json(detail === undefined ? { error } : { error, detail }, status, req);
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

/**
 * Calls a PostgREST RPC with the CALLER's token, not a service credential.
 *
 * That is the point rather than a convenience: PostgREST verifies the signature itself
 * and derives auth.uid() from it, so every function reached this way authenticates the
 * caller independently of whatever the Edge gateway did. A function whose only
 * authentication is a platform setting fails open the day someone deploys with
 * --no-verify-jwt.
 */
export async function rpc(name: string, args: unknown, jwt: string): Promise<Response> {
  return await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env("SUPABASE_ANON_KEY"),
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
}

/** The bearer token, or null. Presence only — the signature is PostgREST's business. */
export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

/**
 * Reads a claim from a JWT WITHOUT verifying it.
 *
 * Only safe where the value cannot grant anything on its own. Every caller here either
 * floors the result against the database or hands it straight back to a function that
 * re-derives auth.uid() itself. Treat the return value as attacker-controlled.
 */
export function unverifiedClaim(jwt: string, path: string[]): unknown {
  try {
    const p = jwt.split(".")[1];
    if (!p) return null;
    const pad = p.length % 4 === 0 ? "" : "=".repeat(4 - (p.length % 4));
    let v: unknown = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + pad));
    for (const k of path) {
      if (v === null || typeof v !== "object") return null;
      v = (v as Record<string, unknown>)[k];
    }
    return v ?? null;
  } catch {
    return null;
  }
}

/**
 * The service-role credential to send as a BEARER to PostgREST.
 *
 * Not simply `env("SUPABASE_SERVICE_ROLE_KEY")`, and the reason is a platform change
 * rather than a preference. The hosted runtime now injects the NEW key formats into the
 * reserved names: `SUPABASE_ANON_KEY` arrives as `sb_publishable_…` and
 * `SUPABASE_SERVICE_ROLE_KEY` as `sb_secret_…`. Those are opaque strings, not JWTs, and
 * `rpc()` puts this value in `Authorization: Bearer`, where PostgREST parses a JWT and
 * answers
 *
 *     401 PGRST301 {"message":"Expected 3 parts in JWT; got 1"}
 *
 * Every Db method turns a non-2xx into a throw — deliberately, so a network error can
 * never be mistaken for "no approved posts" — and handler.ts has no try/catch around
 * publish(), so the whole thing surfaced as a bare 500 with no detail. Measured, not
 * inferred: `apikey` accepts the publishable key happily; only the bearer must be a JWT.
 *
 * The obvious fix — set `SUPABASE_SERVICE_ROLE_KEY` to the legacy JWT — is impossible:
 * the CLI refuses the reserved prefix outright ("Env name cannot start with SUPABASE_,
 * skipping"). Hence a second, unreserved name that takes precedence when present.
 *
 * The fallback is kept rather than replaced, so this stays correct on any deployment
 * where the platform still injects a legacy JWT — including the local stack and CI.
 */
export function serviceRoleJwt(): string {
  const explicit = Deno.env.get("SERVICE_ROLE_JWT");
  if (explicit) return explicit;
  return env("SUPABASE_SERVICE_ROLE_KEY");
}
