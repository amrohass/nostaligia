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
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

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
