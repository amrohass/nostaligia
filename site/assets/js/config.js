/* GENERATED FROM config/site.json BY scripts/build-site-config.mjs -- DO NOT EDIT
   Edit config/site.json and re-run the generator. */

(function (global) {
  'use strict';

  global.CONFIG = Object.freeze({
    // PLACEHOLDER_* until the production host and domain are provisioned. Nothing else in
    // the repository may contain a hostname -- that is what makes this a one-file change.
    domains: Object.freeze({
          "site": "PLACEHOLDER_DOMAIN",
          "cdn": "pub-18aab56b95304deb89be2ad31e43b413.r2.dev",
          "supabase": "pjqvtmhizbnimqyxjbyq.supabase.co",
          "turnstile": "challenges.cloudflare.com",
          "r2_s3": "1dca8f581a2c818cf5c84c17110a59f0.r2.cloudflarestorage.com"
    }),

    origins: Object.freeze({
      site: 'https://PLACEHOLDER_DOMAIN',
      cdn: 'https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev',
      supabase: 'https://pjqvtmhizbnimqyxjbyq.supabase.co',
      turnstile: 'https://challenges.cloudflare.com',
      r2_s3: 'https://1dca8f581a2c818cf5c84c17110a59f0.r2.cloudflarestorage.com'
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
      anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBqcXZ0bWhpemJuaW1xeXhqYnlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzOTI4NzQsImV4cCI6MjEwMTk2ODg3NH0.8We3RtASkqLErr3tcN6sj1teN0bUFA6RMQO-WKG6gY4"
    }),

    // Where the read path begins (section 2). An empty string means same origin -- see
    // read_path in config/site.json. archive.js joins paths onto this, and nothing else in
    // the front end knows where the archive lives.
    archiveBase: "https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev",

    // M4's basemap: one PMTiles archive under the read path, or "" when none is
    // provisioned. public.js loads the map module only when this has a value, so an empty
    // string renders /map as the list -- section 10's own tile-failure fallback, reached
    // deliberately rather than by an error.
    basemap: Object.freeze({
      url: "https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev/basemap/palestine-20260828.pmtiles",
      attribution: "© OpenStreetMap contributors"
    }),

    // The exact policy served by _headers. Exposed so a page can assert at runtime that the
    // policy it is running under is the one this repository generated, rather than assuming.
    csp: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; font-src 'self'; frame-src https://challenges.cloudflare.com; img-src 'self' data: blob: https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev; media-src 'self' blob: https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev; connect-src 'self' https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev https://pjqvtmhizbnimqyxjbyq.supabase.co https://1dca8f581a2c818cf5c84c17110a59f0.r2.cloudflarestorage.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests"
  });
})(window);
