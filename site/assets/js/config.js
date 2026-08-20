/* GENERATED FROM config/site.json BY scripts/build-site-config.mjs -- DO NOT EDIT
   Edit config/site.json and re-run the generator. */

(function (global) {
  'use strict';

  global.CONFIG = Object.freeze({
    // PLACEHOLDER_* until the production host and domain are provisioned. Nothing else in
    // the repository may contain a hostname -- that is what makes this a one-file change.
    domains: Object.freeze({
          "site": "PLACEHOLDER_DOMAIN",
          "cdn": "PLACEHOLDER_CDN_DOMAIN",
          "supabase": "pjqvtmhizbnimqyxjbyq.supabase.co",
          "turnstile": "challenges.cloudflare.com"
    }),

    origins: Object.freeze({
      site: 'https://PLACEHOLDER_DOMAIN',
      cdn: 'https://PLACEHOLDER_CDN_DOMAIN',
      supabase: 'https://pjqvtmhizbnimqyxjbyq.supabase.co',
      turnstile: 'https://challenges.cloudflare.com'
    }),

    // Cloudflare Turnstile. The site key is public by construction — it ships in the
    // markup for every visitor to read — so it belongs here alongside the origins.
    // Mapped site_key -> siteKey explicitly rather than by a generic case transformer:
    // config/site.json is snake_case throughout (known_violations, removed_by) and JS
    // reads camelCase, and one visible line of translation is easier to trust than a
    // rule that silently renames whatever it is handed.
    //
    // The SECRET key is not here and must never be. It never enters this repository:
    // GitHub Actions secrets and the Edge Function environment only (CLAUDE.md §6).
    turnstile: Object.freeze({
      siteKey: "0x4AAAAAAENYWuxg_BTOj47Q"
    }),

    // The anon key — public by construction, and the ONLY Supabase credential permitted
    // here (§6). The generator decodes it and refuses any token whose role is not "anon",
    // so a service_role key pasted into config/site.json fails the build rather than
    // reaching a visitor. Empty until the hosted key is filled in; auth.js throws a named
    // error in that state rather than sending requests that 401 for no visible reason.
    supabase: Object.freeze({
      anonKey: ""
    }),

    // Where the read path begins (section 2). An empty string means same origin -- see
    // read_path in config/site.json. archive.js joins paths onto this, and nothing else in
    // the front end knows where the archive lives.
    archiveBase: "https://PLACEHOLDER_CDN_DOMAIN",

    // The exact policy served by _headers. Exposed so a page can assert at runtime that the
    // policy it is running under is the one this repository generated, rather than assuming.
    csp: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; font-src 'self'; frame-src https://challenges.cloudflare.com; img-src 'self' data: blob: https://PLACEHOLDER_CDN_DOMAIN; media-src 'self' blob: https://PLACEHOLDER_CDN_DOMAIN; connect-src 'self' https://PLACEHOLDER_CDN_DOMAIN https://pjqvtmhizbnimqyxjbyq.supabase.co; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests"
  });
})(window);
