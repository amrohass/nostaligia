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
          "supabase": "pjqvtmhizbnimqyxjbyq.supabase.co"
    }),

    origins: Object.freeze({
      site: 'https://PLACEHOLDER_DOMAIN',
      cdn: 'https://PLACEHOLDER_CDN_DOMAIN',
      supabase: 'https://pjqvtmhizbnimqyxjbyq.supabase.co'
    }),

    // The exact policy served by _headers. Exposed so a page can assert at runtime that the
    // policy it is running under is the one this repository generated, rather than assuming.
    csp: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob: https://PLACEHOLDER_CDN_DOMAIN; media-src 'self' blob: https://PLACEHOLDER_CDN_DOMAIN; connect-src 'self' https://PLACEHOLDER_CDN_DOMAIN https://pjqvtmhizbnimqyxjbyq.supabase.co; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests"
  });
})(window);
