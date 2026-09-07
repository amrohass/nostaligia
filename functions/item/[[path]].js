/* GENERATED FROM config/site.json BY scripts/build-site-config.mjs -- DO NOT EDIT
   Edit config/site.json and re-run the generator. */

/* The archive origin the prerendered pages are written to (read_path.base). */
const ARCHIVE = "https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev";

/* section 6: every response this returns carries the same policy the static site does.
   site/_headers is the asset server's and does not reach a Function's response. */
const SECURITY = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; font-src 'self'; frame-src https://challenges.cloudflare.com; img-src 'self' data: blob: https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev; media-src 'self' blob: https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev; connect-src 'self' https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev https://pjqvtmhizbnimqyxjbyq.supabase.co https://1dca8f581a2c818cf5c84c17110a59f0.r2.cloudflarestorage.com; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=(), microphone=(self)",
};

/* A post id and nothing else. The path segment is interpolated into an upstream URL, so it
   is matched against the uuid shape rather than sanitised -- "reject what is not a uuid" has
   no encoding subtleties, while "strip the dangerous parts" has years of them. Anything else
   falls through to the SPA, which is what every /item URL did before this existed. */
const ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function onRequest(context) {
  const { request, next } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  if (!ARCHIVE) return next();

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);   // ['item', '<id>']
  if (parts.length !== 2 || parts[0] !== 'item' || !ID.test(parts[1])) return next();

  let upstream;
  try {
    upstream = await fetch(ARCHIVE + '/item/' + parts[1].toLowerCase() + '/index.html', {
      method: 'GET',
      headers: { Accept: 'text/html' },
      redirect: 'follow',
    });
  } catch {
    /* The archive is unreachable. The SPA reads the same item from its shards and renders it
       correctly for a person; only the crawler's preview is lost. Falling through is the
       degraded-but-working answer, and it is the behaviour that was there before. */
    return next();
  }

  /* section 2, and it is the reason the page is DELETED on takedown rather than replaced
     with a tombstone: "a link to an item the archive no longer has answers 404 from R2
     rather than reaching the SPA". Falling through here would put a taken-down item back in
     front of whoever still has the link. */
  if (upstream.status === 404) {
    return new Response('Not found', {
      status: 404,
      headers: { ...SECURITY, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (!upstream.ok) return next();

  const headers = new Headers(SECURITY);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  /* section 2(a): these pages are rewritten in place on every publish, so they carry a short
     TTL rather than the release tree's year. Taken from upstream so the publisher stays the
     one place that decides it. */
  const cache = upstream.headers.get('Cache-Control');
  if (cache) headers.set('Cache-Control', cache);

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: 200,
    headers,
  });
}
