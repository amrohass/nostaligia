// Is this token safe to inline into a file served to every visitor?
//
// CLAUDE.md §6 permits exactly one Supabase credential in the client — "The Supabase anon
// key is designed to be public and is not the concern; the service-role key, any
// third-party API key, and any admin credential are."
//
// Which makes `supabase.anon_key` in config/site.json the most dangerous field in this
// repository. Not because the anon key is sensitive, but because it is the box a
// service_role key gets pasted into by someone copying from the same dashboard page. That
// is the ~24,000% billing incident, re-run.
//
// ── Why this decodes rather than pattern-matches ─────────────
//
// .gitleaks.toml needs three base64 markers per role because a JWT payload is base64url of
// JSON and the encoding of `"role":"service_role"` shifts with its byte offset — the file
// documents that reasoning at length, and had to verify all six markers against generated
// tokens at every alignment. A scanner reading raw text has no choice. This does: the
// payload is right there, and parsing it cannot be fooled by alignment, by claim order, or
// by a role name nobody has thought of yet.
//
// Lives in its own module so it can be tested directly. A build-time guard that has never
// been shown to refuse anything is a guard nobody knows is wired up.

/**
 * Throws unless `token` is a JWT whose role claim is exactly "anon".
 *
 * @param {string} token
 * @param {string} where  what to name in the error — the field being validated
 */
export function assertAnonKey(token, where = 'supabase.anon_key') {
  let role;
  try {
    const payload = String(token).split('.')[1];
    if (!payload) throw new Error('not a three-segment JWT');
    role = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role;
  } catch (e) {
    throw new Error(
      `${where} is not a readable JWT (${e.message}). ` +
      `Paste the anon/public key from Project Settings → API.`,
    );
  }

  // Not `!== 'service_role'`. An allowlist of one, because the failure mode being guarded
  // against is a key type nobody here has heard of — a denylist only refuses the roles
  // somebody remembered to name.
  if (role !== 'anon') {
    throw new Error(
      `${where} carries role "${role}", not "anon". A ${role} key in this field is inlined ` +
      `into assets/js/config.js and served to every visitor — this is the shape of the ` +
      `incident CLAUDE.md §6 was written after. Rotate that key NOW if it has been ` +
      `committed, then paste the anon key instead.`,
    );
  }
}
