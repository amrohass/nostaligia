// Generate `site/_headers` and `site/assets/js/config.js` from config/site.json.
//
// CLAUDE.md section 2 asks for every origin/CSP/CORS value in one config module so that
// pointing at a real domain is a one-file change. Two files have to carry those values at
// runtime -- a static `_headers` that Cloudflare Pages reads, and a JS module the browser
// reads -- and hand-keeping them in step with a third is how they drift.
//
// So neither is written by hand. CI runs this with --check and fails on any diff, which
// makes "one-file change" a property of the repository rather than a note in a README.
//
//     node scripts/build-site-config.mjs           # write
//     node scripts/build-site-config.mjs --check   # verify, exit 1 on drift (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertAnonKey } from './lib/anon-key.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');
const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));

const GENERATED = 'GENERATED FROM config/site.json BY scripts/build-site-config.mjs -- DO NOT EDIT';

// @token -> https://<domain>. An unknown token is a hard error rather than a silently
// empty source: a CSP directive that quietly loses a source fails open at runtime and
// nowhere else.
function resolve(src) {
  if (!src.startsWith('@')) return src;
  const name = src.slice(1);
  const host = cfg.domains[name];
  if (!host) throw new Error(`csp references @${name}, which is not in domains`);
  return `https://${host}`;
}

const policy = Object.entries(cfg.csp)
  .map(([directive, sources]) => [directive, ...sources.map(resolve)].join(' '))
  .join('; ');

// Fail loudly rather than emit a policy that section 6 forbids. This is the assertion that
// survives someone "temporarily" loosening the config to get a page working.
for (const banned of ["'unsafe-inline'", "'unsafe-eval'"]) {
  if (policy.includes(banned)) throw new Error(`CSP contains ${banned} — forbidden by CLAUDE.md section 6`);
}

// The Turnstile SITE key is public; the SECRET key is the capability-bearing half and must
// never reach the client. Nothing stops someone adding it to config/site.json next to its
// sibling and assuming the generator will do something sensible — the generator would
// happily inline it into assets/js/config.js and serve it to every visitor. This refuses.
// gitleaks would also catch it on commit; this catches it one step earlier, at the point
// where the mistake is actually made.
for (const key of Object.keys(cfg.turnstile ?? {})) {
  if (/secret|private/i.test(key)) {
    throw new Error(
      `config/site.json: turnstile.${key} looks like a secret. The Turnstile secret key ` +
      `belongs in GitHub Actions secrets and the Edge Function environment, never in this ` +
      `repository and never in a generated client file (CLAUDE.md section 6).`
    );
  }
}

// ── The Supabase anon key ───────────────────────────────────────────────────
// The one Supabase credential section 6 permits in the client. The check that it is
// actually that one lives in scripts/lib/anon-key.mjs, where it can be tested against a
// service_role token directly — see scripts/frontend-auth-test.mjs.
//
// Empty is a legitimate state: the hosted key has not been pasted in yet. The client throws
// a named error in that case rather than sending requests that 401 for no visible reason.
const anonKey = (cfg.supabase?.anon_key ?? '').trim();
if (anonKey) assertAnonKey(anonKey, 'config/site.json: supabase.anon_key');

// ── Edge Function CORS ──────────────────────────────────────────────────────
// request-upload allowlists origins from UPLOAD_ALLOWED_ORIGINS, because a deployed
// function cannot read this repository. The list still lives in config/site.json (section 2)
// and is deployed from here, so the value is built and CHECKED here even though the only
// output is a line for a human to run.
//
// Each rule below exists because the failure it prevents is silent: a wildcard, a
// PLACEHOLDER that matches no real browser, a trailing slash or a path (neither of which
// appears in an Origin header, so the entry can never match), or a plain-http origin that
// is not localhost. In every case CORS simply stops working, or stops protecting, with no
// error anywhere.
const uploadOrigins = cfg.function_cors?.upload_allowed_origins ?? [];
if (uploadOrigins.length === 0) {
  throw new Error('config/site.json: function_cors.upload_allowed_origins is empty — request-upload would refuse every browser');
}
for (const origin of uploadOrigins) {
  if (origin === '*' || origin.includes('*')) {
    throw new Error(`function_cors: "${origin}" — a wildcard CORS origin is never correct for an authenticated endpoint`);
  }
  if (origin.includes('PLACEHOLDER')) {
    throw new Error(`function_cors: "${origin}" — no browser sends a placeholder Origin; add the real one or leave it out`);
  }
  let u;
  try { u = new URL(origin); } catch { throw new Error(`function_cors: "${origin}" is not a URL`); }
  if (u.origin !== origin) {
    throw new Error(`function_cors: "${origin}" is not a bare origin (got "${u.origin}") — an Origin header carries no path, so this could never match`);
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(`function_cors: "${origin}" is plain http and is not localhost`);
  }
}
const uploadOriginsValue = uploadOrigins.join(',');

// -- The read path ----------------------------------------------------------
// Section 2: "Browser -> CDN -> manifest.json -> active release". `base` names the origin
// that whole path hangs off, as a token rather than a hostname, so pointing the archive at
// a different host stays the same one-file change as everything else here.
//
// "self" resolves to the empty string, which makes every archive fetch same-origin and
// relative. That is a real deployment -- site/_headers already writes cache rules for /v/*
// and /manifest.json -- not a development fallback. There is deliberately no inference from
// a missing value and no localhost special case, for the reason r2Endpoint() gives: a read
// path that silently falls back is one that reports success while reading a different
// archive.
const readBase = cfg.read_path?.base;
if (typeof readBase !== 'string' || !readBase) {
  throw new Error('config/site.json: read_path.base is required — the front end has nowhere to read the archive from');
}
const archiveBase = readBase === 'self' ? '' : resolve(readBase);

// The directive that has to admit it. A read path the CSP blocks renders a blank archive,
// and the only symptom is a console the visitor does not have open.
if (archiveBase) {
  const connect = (cfg.csp['connect-src'] ?? []).map(resolve);
  if (!connect.includes(archiveBase)) {
    throw new Error(
      `config/site.json: read_path.base resolves to ${archiveBase}, which connect-src does not allow`);
  }
}

// -- The basemap ------------------------------------------------------------
// Section 2: "PMTiles (Palestine extract) on R2." A path relative to read_path.base, so the
// archive and the basemap move together and neither carries a hostname.
//
// Empty is legal and means "not provisioned": /map falls back to the list, which is M4's own
// stated tile-failure fallback. What is NOT legal is a value that looks configured and is
// not -- an absolute URL (which would put a hostname outside this file) or a path escaping
// the read path.
const basemapPath = (cfg.basemap?.path ?? '').trim();
if (basemapPath) {
  if (/^[a-z]+:/i.test(basemapPath) || basemapPath.startsWith('//')) {
    throw new Error(
      `basemap.path: "${basemapPath}" is a URL — it must be a path under read_path.base, so the origin stays in this file`);
  }
  if (basemapPath.includes('..')) {
    throw new Error(`basemap.path: "${basemapPath}" escapes the read path`);
  }
  if (!basemapPath.endsWith('.pmtiles')) {
    throw new Error(`basemap.path: "${basemapPath}" is not a .pmtiles archive`);
  }
}
const basemapUrl = basemapPath
  ? `${archiveBase}/${basemapPath.replace(/^\//, '')}`
  : '';
const basemapAttribution = (cfg.basemap?.attribution ?? '').trim();
if (basemapPath && !basemapAttribution) {
  throw new Error('basemap.attribution is empty — an OpenStreetMap-derived extract must display its credit');
}

// -- The publisher's view of the site ---------------------------------------
// Not a CORS origin -- a canonical URL. Same rules for the same reasons as the loop above,
// minus the localhost exemption: a prerendered page whose og:url is http://localhost is a
// page nobody can share, which is the entire point of prerendering it.
const siteOrigin = (cfg.function_env?.site_origin ?? '').trim();
if (!siteOrigin) {
  throw new Error('config/site.json: function_env.site_origin is empty — prerendered item pages would carry no canonical URL');
}
if (siteOrigin.includes('PLACEHOLDER')) {
  throw new Error(`function_env: "${siteOrigin}" — no crawler resolves a placeholder; use the staging origin until production exists`);
}
{
  let u;
  try { u = new URL(siteOrigin); } catch { throw new Error(`function_env: "${siteOrigin}" is not a URL`); }
  if (u.origin !== siteOrigin) {
    throw new Error(`function_env: "${siteOrigin}" is not a bare origin (got "${u.origin}")`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`function_env: "${siteOrigin}" is not https — og:url and the canonical link must be`);
  }
}

// ── _headers ────────────────────────────────────────────────────────────────
// Cloudflare Pages format: a path pattern, then indented `Name: value` lines. `/*` matches
// every route, which is what a security header set should do -- an exception carved out
// per-path is an exception someone forgets to close.
const headerLines = Object.entries(cfg.headers).map(([k, v]) => `  ${k}: ${v}`);
const headers = [
  `# ${GENERATED}`,
  '#',
  '# Cloudflare Pages reads this file. GitHub Pages IGNORES it completely, so none of these',
  '# headers apply while the site is served from GitHub Pages -- see the README.',
  '',
  '/*',
  `  Content-Security-Policy: ${policy}`,
  ...headerLines,
  '',
  '# Generated release shards and media are immutable and content-addressed by path (M2).',
  '/v/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '# The pointer the whole read path hangs off. Short TTL so a rollback is visible fast.',
  '/manifest.json',
  '  Cache-Control: public, max-age=30, must-revalidate',
  '',
  '# Takedown must never wait for a publish cycle (section 8).',
  '/redactions.json',
  '  Cache-Control: public, max-age=30, must-revalidate',
  ''
].join('\n');

// ── site/assets/js/config.js ────────────────────────────────────────────────
// Same IIFE-on-window shape as i18n.js / store.js / ui.js. No build step, no modules.
const js = `/* ${GENERATED}
   Edit config/site.json and re-run the generator. */

(function (global) {
  'use strict';

  global.CONFIG = Object.freeze({
    // PLACEHOLDER_* until the production host and domain are provisioned. Nothing else in
    // the repository may contain a hostname -- that is what makes this a one-file change.
    domains: Object.freeze(${JSON.stringify(cfg.domains, null, 6).replace(/\n/g, '\n    ')}),

    origins: Object.freeze({
${Object.entries(cfg.domains).map(([k, v]) => `      ${k}: 'https://${v}'`).join(',\n')}
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
      siteKey: ${JSON.stringify(cfg.turnstile.site_key)}
    }),

    // The anon key — public by construction, and the ONLY Supabase credential permitted
    // here (§6). The generator decodes it and refuses any token whose role is not "anon",
    // so a service_role key pasted into config/site.json fails the build rather than
    // reaching a visitor. Empty until the hosted key is filled in; auth.js throws a named
    // error in that state rather than sending requests that 401 for no visible reason.
    supabase: Object.freeze({
      anonKey: ${JSON.stringify(anonKey)}
    }),

    // Where the read path begins (section 2). An empty string means same origin -- see
    // read_path in config/site.json. archive.js joins paths onto this, and nothing else in
    // the front end knows where the archive lives.
    archiveBase: ${JSON.stringify(archiveBase)},

    // M4's basemap: one PMTiles archive under the read path, or "" when none is
    // provisioned. public.js loads the map module only when this has a value, so an empty
    // string renders /map as the list -- section 10's own tile-failure fallback, reached
    // deliberately rather than by an error.
    basemap: Object.freeze({
      url: ${JSON.stringify(basemapUrl)},
      attribution: ${JSON.stringify(basemapAttribution)}
    }),

    // The exact policy served by _headers. Exposed so a page can assert at runtime that the
    // policy it is running under is the one this repository generated, rather than assuming.
    csp: ${JSON.stringify(policy)}
  });
})(window);
`;

// Both targets live inside site/, the Cloudflare Pages output directory declared in
// wrangler.toml. `_headers` is only applied at the ROOT of that directory — written to
// the repository root instead, it is a correct, tested, committed file that no longer
// reaches a single visitor.
// -- site/_redirects --------------------------------------------------------
// CLAUDE.md section 2 moves routing to the History API, which means /item/<id>, /map and
// /u/<handle> are real paths a browser REQUESTS -- not fragments the server never sees.
// Without this, every one of them is a 404 from Cloudflare Pages on first load and on every
// refresh, and the site works only for someone who arrives at the root and never reloads.
//
// 200, not 302: the address bar has to keep the path, because the path IS the route.
//
// Static files still win -- Pages matches the filesystem before it reads this file -- so
// /assets/*, /_headers, and anything the deployment routes to R2 are unaffected.
const redirects = [
  `# ${GENERATED}`,
  '#',
  '# History API routing (CLAUDE.md section 2). Every unmatched path serves the SPA shell',
  '# with a 200, so the browser keeps the URL it asked for.',
  '',
  '/*  /index.html  200',
  ''
].join('\n');

const outputs = [
  ['site/_headers', headers],
  ['site/_redirects', redirects],
  ['site/assets/js/config.js', js]
];

let drifted = false;
for (const [rel, content] of outputs) {
  const path = join(root, rel);
  let current = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* not yet generated */ }
  if (current === content) { console.log(`unchanged  ${rel}`); continue; }
  if (check) {
    console.error(`::error::${rel} is out of date — run: node scripts/build-site-config.mjs`);
    drifted = true;
    continue;
  }
  writeFileSync(path, content);
  console.log(`wrote      ${rel}`);
}

if (check && drifted) process.exit(1);
if (check) console.log(`\nall ${outputs.length} generated files match config/site.json`);

// Not a generated file, so not drift-checkable: the hosted secret is outside this
// repository and nothing here can read it back. Printing it on every run is the whole
// mitigation — the value is in front of you at the moment you change the origins.
console.log(`\nEdge Function CORS — set this whenever the list above changes:\n` +
  `  npx supabase secrets set UPLOAD_ALLOWED_ORIGINS="${uploadOriginsValue}"`);

// Same seam, same mitigation. The publisher reads SITE_ORIGIN to write og:url and the
// canonical link into every prerendered item page; get it wrong and every shared link names
// a host that is not this one, which is invisible from inside the repository.
console.log(`\nThe publisher's canonical origin — set this whenever site_origin changes:\n` +
  `  npx supabase secrets set SITE_ORIGIN="${siteOrigin}"`);
