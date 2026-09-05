// resend-confirmation — send the member another confirmation link (0060, CLAUDE.md §6, §7).
//
// A signed-in member whose address is not confirmed yet asks for the mail again. If every
// gate passes, GoTrue sends its own magic link to the address inside their own token.
//
// ── What this function is FOR, which is not "sending mail" ────
//
// GoTrue can already be asked for a magic link by any browser holding the anon key. This
// exists for the two things that request cannot do on its own:
//
//   1. OUR rate limit, in front of the provider's. The project-wide mail cap is a shared
//      resource — without a per-account limit, one member pressing a button repeatedly
//      spends everybody's. claim_confirmation_send() is that limit and it lives in the
//      database, where §6 says cost ceilings live.
//   2. THE ADDRESS IS NOT ACCEPTED FROM THE CALLER. It is read out of the caller's own
//      token, after the database has verified that token. A function that mailed an
//      address a browser supplied would be an open relay aimed at strangers.
//
// Stated plainly rather than implied: a client that skips this and calls GoTrue directly
// meets the provider's cap and not ours. This bounds the ordinary case — a member pressing
// the button — which is the case that actually happens. The database is what bounds the
// hostile one, by refusing to confirm anybody who did not click a link (0060's amr check).
//
// ── The order of the gates ───────────────────────────────────
//
//   1  shape        cheap, no I/O
//   2  auth         a bearer is present
//   3  our limit    claim_confirmation_send, with the CALLER'S token — this is also what
//                   AUTHENTICATES them: PostgREST verifies the signature and derives
//                   auth.uid() itself, so the gateway's verify_jwt is not the only thing
//                   standing here (the rule _shared/http.ts states)
//   4  the address  read from the token PostgREST has just verified
//   5  GoTrue       one magic link
//
// The Turnstile token is NOT verified here and that is deliberate. A Turnstile token is
// SINGLE-USE: verifying it and then forwarding it would spend it twice and GoTrue would
// refuse the second use. So it is forwarded, and Cloudflare judges it exactly once, on the
// call that actually sends something. Measured 5 Sep 2026 against the live project:
// POST /auth/v1/magiclink with no captcha_token answers
// `400 captcha_failed … (no captcha_token found)`, so the gate is real and it is GoTrue's.

import { bearer, corsHeaders, env, fail, json, rpc, unverifiedClaim } from "../_shared/http.ts";

/** GoTrue refusals worth telling the member apart. Everything else is ours to own. */
function mapGoTrue(status: number, errorCode: string): { key: string; status: number } {
  if (errorCode === "captcha_failed") return { key: "captcha_failed", status: 403 };
  if (status === 429 || errorCode === "over_email_send_rate_limit") {
    // OUR limit and the PROVIDER'S are different sentences on the screen: one is "wait a
    // moment", the other is "this is our limit, not something you did". §9's reset dialog
    // draws the same distinction and it is the one members actually notice.
    return { key: "over_email_send_rate_limit", status: 429 };
  }
  if (status === 422) return { key: "no_such_account", status: 422 };
  return { key: "send_failed", status: 502 };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return fail("method_not_allowed", 405, req);

  // ── 1 · shape ──────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_json", 400, req);
  }

  const turnstileToken = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
  if (!turnstileToken) return fail("turnstile_required", 400, req);

  // ── 2 · auth ───────────────────────────────────────────────
  const jwt = bearer(req);
  if (!jwt) return fail("unauthenticated", 401, req);

  // ── 3 · our limit, which is also the authentication ────────
  const slotRes = await rpc("claim_confirmation_send", {}, jwt);
  if (slotRes.status === 401 || slotRes.status === 403) return fail("unauthenticated", 401, req);
  if (!slotRes.ok) return fail("limit_check_failed", 502, req);

  const slot = await slotRes.json();
  if (slot?.allowed !== true) {
    const reason = slot?.reason ?? "too_soon";
    const status = reason === "unauthenticated"
      ? 401
      : reason === "already_confirmed"
      ? 409
      : 429;
    // retry_after_s is passed through because "wait a little" without a number is a message
    // nobody can act on — the same reasoning request-upload gives for putting the size limit
    // in its too-big refusal.
    return fail(reason, status, req, { retry_after_s: slot?.retry_after_s });
  }

  // ── 4 · the address, from the token the database just verified ──
  //
  // Read AFTER gate 3, never before. On its own `unverifiedClaim` is exactly what its name
  // says; what makes it safe here is that PostgREST has already parsed and signature-checked
  // this same token to answer gate 3. A forged token never reaches this line.
  const email = unverifiedClaim(jwt, ["email"]);
  if (typeof email !== "string" || !email.includes("@")) {
    // An account with no address — an admin-created or anonymous one. Nothing to send to,
    // and saying so is better than reporting a success nobody will receive.
    return fail("no_address", 422, req);
  }

  // ── 5 · GoTrue sends its own link ──────────────────────────
  //
  // create_user:false, because this is a RESEND for an account that exists. Without it a
  // typo'd or stale address would silently create a second account, which is the failure
  // mode a confirmation flow exists to prevent.
  let res: Response;
  try {
    res = await fetch(`${env("SUPABASE_URL")}/auth/v1/magiclink`, {
      method: "POST",
      headers: {
        apikey: env("SUPABASE_ANON_KEY"),
        Authorization: `Bearer ${env("SUPABASE_ANON_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        create_user: false,
        gotrue_meta_security: { captcha_token: turnstileToken },
      }),
    });
  } catch (e) {
    // A provider we cannot reach. The slot above is already spent, deliberately — see
    // claim_confirmation_send's own comment: the cheap failure is one member waiting a
    // minute, the expensive one is a retry loop against a paid mail API.
    console.error("resend-confirmation: mailer unreachable", { error: String(e) });
    return fail("send_failed", 502, req);
  }

  if (!res.ok) {
    let errorCode = "";
    try {
      errorCode = String((await res.json())?.error_code ?? "");
    } catch { /* not JSON; the status is enough */ }
    // Logged with the code, never returned with it: which of GoTrue's refusals happened is
    // an operator's question, and 1 Sep's Turnstile drift is the case for having somewhere
    // to look. The member gets the one of five sentences that tells them what to do.
    console.error("resend-confirmation: mailer refused", { status: res.status, errorCode });
    const mapped = mapGoTrue(res.status, errorCode);
    return fail(mapped.key, mapped.status, req);
  }

  // No body worth returning. Whether an address has an account is not something this answers
  // — §7's reason, and the same one the reset dialog gives for saying the identical thing to
  // a member and to a stranger.
  return json({ sent: true }, 200, req);
}
