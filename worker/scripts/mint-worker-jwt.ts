// Mints the token the worker authenticates with.
//
//     SUPABASE_JWT_SECRET='…' deno run --allow-env worker/scripts/mint-worker-jwt.ts
//
// The secret comes from Supabase → Project Settings → API → JWT Secret, and it is passed in
// the ENVIRONMENT, never as an argument: an argument is visible in `ps` to every process on
// the machine and lands in shell history verbatim.
//
// ── What this hands out, and what it deliberately does not ───
//
// The output is a token asserting `role: media_worker`. Migration 0026 gave that role no
// table grants at all and EXECUTE on exactly complete_ingest and fail_ingest, so a leaked
// token can mark ingests complete or failed for object keys it already knows — and nothing
// else. It cannot read a post, approve anything, or reach another table.
//
// The SIGNING SECRET stays here, on the machine that runs this, and never reaches Cloud Run.
// That is the whole point of minting out of band: the worker holds a token it cannot renew
// or re-scope, not the means to mint `service_role`.
//
// Nothing is written to disk. The token is printed once; paste it into Secret Manager.

const secret = Deno.env.get("SUPABASE_JWT_SECRET");
if (!secret) {
  console.error(
    "SUPABASE_JWT_SECRET is not set.\n" +
      "  Supabase → Project Settings → API → JWT Secret\n" +
      "  Pass it in the environment, not as an argument.",
  );
  Deno.exit(2);
}

// One year. Long enough not to be a weekly chore, short enough that a token leaked and
// never noticed does not outlive the project. Rotation is: run this again, set the secret,
// redeploy — the worker reads it at startup.
const YEARS = 1;
const now = Math.floor(Date.now() / 1000);
const payload = {
  role: "media_worker",
  iss: "supabase",
  iat: now,
  exp: now + YEARS * 365 * 24 * 60 * 60,
};

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const encode = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));

console.log(`${signingInput}.${b64url(new Uint8Array(sig))}`);
console.error(
  `\n  role  media_worker\n` +
    `  exp   ${new Date(payload.exp * 1000).toISOString()}\n` +
    `\n  Set it as MEDIA_WORKER_JWT. Do not commit it, and do not paste it into a file\n` +
    `  in this repository — gitleaks and the pre-commit hook will stop you, but the\n` +
    `  reason not to is that it would then be in the history forever.\n`,
);
