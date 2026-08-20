/* One item, as HTML, for something that will never run JavaScript.
 *
 * §9: "The publish step emits item/{id}/index.html with full OG/Twitter tags and the content
 * in HTML. A diaspora archive spreads on WhatsApp — a blank preview card is a growth
 * failure, not a polish issue."
 *
 * ── Who reads this file ──────────────────────────────────────
 *
 * Not a person, mostly. WhatsApp, Signal, Telegram, Facebook and Twitter each fetch a pasted
 * URL once, with no JavaScript, a short timeout, and no second request — so whatever the
 * SPA would have rendered a moment later does not exist as far as they are concerned. The
 * tags below are the entire preview card, and they are read verbatim.
 *
 * It IS also read by people, in two cases worth building for: a reader whose connection
 * dropped the bundle, and a search crawler. Both get the title, the story and the picture
 * from the markup, which is why the body is real content rather than an empty shell with
 * meta tags bolted on.
 *
 * ── Input is the PUBLIC shape, deliberately ──────────────────
 *
 * This module takes publicPost()'s output, not a SourcePost. It therefore CANNOT emit a
 * field the shard does not already publish: the raw coordinate, created_by, the exact
 * timestamp, the consent record and the archival master are not merely unused here, they are
 * unreachable. shards.ts's allowlist is the gate, and prerendering sits behind it rather than
 * beside it — otherwise §7's most consequential rule would need enforcing twice, in two
 * files, one of which is about HTML.
 *
 * ── Escaping ─────────────────────────────────────────────────
 *
 * Every interpolation goes through esc() or attr(). Not "every one that looked risky" —
 * every one, including the id, which is a uuid the database generated. A rule with an
 * exemption for values believed safe is a rule that gets a second exemption later, from
 * someone who believed differently.
 *
 * §6's XSS rule is written for the browser ("textContent only, or DOMPurify") and this is a
 * string builder, so it cannot use that mechanism. The equivalent is that no caller can hand
 * this module a string that becomes markup: esc() neutralises the five characters that could
 * leave a text node or an attribute, and there is no path that skips it.
 *
 * ── Bidi ─────────────────────────────────────────────────────
 *
 * §6: "Render user strings in <bdi>." Every user-authored string below is wrapped, which is
 * the render half of the rule 0045 implements on ingest. Both halves are needed and neither
 * substitutes: 0045 removes the OVERRIDE controls, <bdi> isolates the string's own natural
 * direction so an Arabic title cannot reorder the Latin sentence it sits inside — a thing
 * that happens with no special characters at all, simply because the two scripts run
 * opposite ways.
 *
 * Meta tags cannot carry <bdi>; an attribute has no markup. The og:title of an Arabic item
 * is Arabic and the consumer applies its own bidi algorithm, which is the best available
 * outcome and is why the tags are built from one language rather than concatenating both.
 */

import type { publicPost } from "./shards.ts";

/** Exactly the shape publicPost() returns — see the header. */
export type PublicPost = ReturnType<typeof publicPost>;

export interface PrerenderConfig {
  /** SITE_ORIGIN. Where a shared link points: og:url, the canonical link, every href. */
  siteOrigin: string;
  /** CDN_ORIGIN, or "" when no CDN is configured — then no og:image is emitted at all. */
  cdnOrigin: string;
}

/* ── Escaping ──────────────────────────────────────────────── */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Text and attribute content, both.
 *
 * One function rather than a text escaper and an attribute escaper, because the union of
 * the two rules is small and the failure mode of picking the wrong one is an injection.
 * `'` is escaped even though every attribute below is double-quoted — for the same reason.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** A user string, isolated. §6's render half. */
function bdi(value: unknown): string {
  const text = esc(value);
  return text ? `<bdi>${text}</bdi>` : "";
}

/* ── Language ──────────────────────────────────────────────── */

/**
 * Which language this item's page is IN.
 *
 * The archive is Arabic-first (§9) and most items will carry Arabic. Some will not — a
 * contributor writes in whichever language they think in, and the share sheet fills only the
 * side matching the interface they were using. A page whose <html lang="ar" dir="rtl">
 * contains nothing but English renders right-aligned English, which is wrong in a way a
 * reader notices immediately and a crawler reports as the wrong language.
 *
 * So the document's language follows the CONTENT: Arabic when there is Arabic, English when
 * there is only English.
 */
function primaryLang(post: PublicPost): "ar" | "en" {
  if (post.title_ar || post.body_ar) return "ar";
  if (post.title_en || post.body_en) return "en";
  return "ar";
}

function side(post: PublicPost, lang: "ar" | "en") {
  const title = lang === "ar" ? post.title_ar : post.title_en;
  const body = lang === "ar" ? post.body_ar : post.body_en;
  const place = lang === "ar" ? post.place_ar : post.place_en;
  const venue = lang === "ar" ? post.venue_ar : post.venue_en;
  const other = lang === "ar" ? post.title_en : post.title_ar;
  return { title: title ?? "", body: body ?? "", place: place ?? "", venue: venue ?? "", other: other ?? "" };
}

const SITE_NAME = { ar: "ذاكرة رام الله", en: "Ramallah Memory Atlas" };

/**
 * The preview card's second line.
 *
 * Trimmed to 200 characters, on a word boundary where there is one. Every consumer truncates
 * anyway and they do it at different lengths and without regard for where a word ends;
 * cutting here means the ellipsis lands somewhere deliberate. Newlines collapse to spaces —
 * a meta attribute cannot hold one, and a raw newline in an attribute is a parse ambiguity
 * rather than a line break.
 */
export function summarise(text: string, fallback: string): string {
  const flat = (text || fallback || "").replace(/\s+/g, " ").trim();
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 200);
  const space = cut.lastIndexOf(" ");
  return (space > 120 ? cut.slice(0, space) : cut) + "…";
}

/* ── The page ──────────────────────────────────────────────── */

/**
 * The SPA's own script tags, absolute.
 *
 * ABSOLUTE, and this is the whole reason the list is duplicated rather than left relative: a
 * prerendered page is served at /item/{id}, so `assets/js/config.js` would resolve to
 * /item/{id}/assets/js/config.js and 404. Every one of them.
 *
 * The duplication is real and is defended by a test rather than by care —
 * prerender.test.ts reads site/index.html and asserts this list is exactly the scripts it
 * loads, in order. A module added to the shell and forgotten here would leave every shared
 * link hydrating into a half-built page, which looks like a rendering bug and is a routing
 * one.
 */
export const SPA_SCRIPTS = [
  "/assets/js/config.js",
  "/assets/js/i18n.js",
  "/assets/js/data.js",
  "/assets/js/archive.js",
  "/assets/js/ui.js",
  "/assets/js/auth.js",
  "/assets/js/db.js",
  "/assets/js/engage.js",
  "/assets/js/turnstile.js",
  "/assets/js/upload.js",
  "/assets/js/public.js",
];

/**
 * The shell's stylesheets, in order, and pinned against site/index.html by the same test as
 * SPA_SCRIPTS.
 *
 * The Google Fonts link is here for a reason that is easy to get wrong in either direction.
 * It is a known_violations entry in config/site.json, removed by M6's font subsetting, and
 * the CSP already blocks it — so it does nothing today. Omitting it would still be wrong:
 * the prerendered page is a SEPARATE document from the shell, so a reader arriving from a
 * shared link would get a different typeface from everyone else until the SPA hydrated, and
 * on a slow connection that is the whole visit.
 *
 * Consistency also has a safety consequence: scripts/frontend-csp-test.mjs scans this file
 * alongside site/, so the origin ratchet covers the prerendered pages. Leaving the font out
 * would put this document permanently out of step with the shell and give M6 two places to
 * remember instead of one.
 */
export const SPA_STYLES = [
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap",
  "/assets/css/tokens.css",
  "/assets/css/atlas.css",
];

/** `/item/{id}` — the shareable URL, and the only path this archive asks anyone to paste. */
export function itemPath(id: string): string {
  return `/item/${encodeURIComponent(id)}`;
}

export function itemPage(post: PublicPost, cfg: PrerenderConfig): string {
  const lang = primaryLang(post);
  const dir = lang === "ar" ? "rtl" : "ltr";
  const s = side(post, lang);
  const url = cfg.siteOrigin + itemPath(post.id);

  const heading = s.title || s.other || SITE_NAME[lang];
  const description = summarise(s.body, heading);

  // thumb before poster: the thumb is generated for every kind of media (§6, "generate a
  // thumbnail and a poster frame for every video"), it is the smallest thing that
  // represents the item, and a preview card is a small square. A poster is a video frame at
  // rendition size and would be a slow, large fetch for a card that will scale it down.
  const image = post.media.find((m) => m.role === "thumb") ??
    post.media.find((m) => m.role === "poster");
  const imageUrl = image && cfg.cdnOrigin ? `${cfg.cdnOrigin}/${image.path}` : "";

  const meta: string[] = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(heading)} · ${esc(SITE_NAME[lang])}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,

    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="${esc(SITE_NAME[lang])}">`,
    `<meta property="og:locale" content="${lang === "ar" ? "ar_PS" : "en_GB"}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(heading)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
  ];

  if (imageUrl) {
    meta.push(`<meta property="og:image" content="${esc(imageUrl)}">`);
    // Alt text on a preview image, because a screen reader in a chat app reads it and
    // because §9's accessibility line is not suspended for social cards.
    meta.push(`<meta property="og:image:alt" content="${esc(heading)}">`);
    if (image?.width) meta.push(`<meta property="og:image:width" content="${esc(image.width)}">`);
    if (image?.height) meta.push(`<meta property="og:image:height" content="${esc(image.height)}">`);
    // summary_large_image only when there IS an image. Declaring it without one produces a
    // card with a large empty box, which is worse than the small card.
    meta.push(`<meta name="twitter:card" content="summary_large_image">`);
  } else {
    meta.push(`<meta name="twitter:card" content="summary">`);
  }
  meta.push(`<meta name="twitter:title" content="${esc(heading)}">`);
  meta.push(`<meta name="twitter:description" content="${esc(description)}">`);
  if (imageUrl) meta.push(`<meta name="twitter:image" content="${esc(imageUrl)}">`);

  for (const href of SPA_STYLES) meta.push(`<link rel="stylesheet" href="${esc(href)}">`);

  /* ── The body ──────────────────────────────────────────────
   *
   * Mounted inside #view, which is the node public.js clears and re-renders. So the markup
   * below is what a crawler and a JS-less reader get, and it is replaced by the live view
   * the moment the bundle runs — no reconciliation, no duplicated DOM, and no requirement
   * that the two agree pixel for pixel.
   *
   * The comment thread is deliberately absent. The SPA fetches item/{id}.json regardless
   * (it needs the media list and the counts), and the thread is in that file, so nothing is
   * lost for a reader with JavaScript. What a crawler loses is other people's remarks, and
   * putting a stranger's words into the shareable preview of somebody else's photograph is
   * not obviously a favour to either of them.
   */

  const paragraphs = s.body
    ? s.body.split(/\n\s*\n/).map((p) => `<p class="prerender__para">${bdi(p)}</p>`).join("")
    : "";

  const factParts: string[] = [];
  if (post.decade) factParts.push(`<li>${esc(post.decade)}s</li>`);
  if (s.place) factParts.push(`<li>${bdi(s.place)}</li>`);
  if (s.venue) factParts.push(`<li>${bdi(s.venue)}</li>`);
  if (post.author?.handle) {
    factParts.push(
      `<li><a href="/u/${esc(encodeURIComponent(post.author.handle))}">${
        bdi(post.author.display_name || post.author.handle)
      }</a></li>`,
    );
  }
  // §7: day precision, never a time. `day` is already a date string from created_on; it is
  // printed as-is rather than formatted, because Intl is a browser API and the SPA
  // re-renders this line within a frame anyway.
  if (post.day) factParts.push(`<li><time datetime="${esc(post.day)}">${esc(post.day)}</time></li>`);

  const figure = imageUrl
    ? `<figure class="prerender__figure"><img src="${esc(imageUrl)}" alt="${esc(heading)}"` +
      (image?.width ? ` width="${esc(image.width)}"` : "") +
      (image?.height ? ` height="${esc(image.height)}"` : "") +
      `></figure>`
    : "";

  const rights = [
    post.license ? `<li>${bdi(post.license)}</li>` : "",
    post.provenance ? `<li>${bdi(post.provenance)}</li>` : "",
  ].filter(Boolean).join("");

  const body = [
    `<article class="prerender" lang="${lang}" dir="${dir}">`,
    `<h1 class="prerender__title">${bdi(heading)}</h1>`,
    s.other ? `<p class="prerender__gloss">${bdi(s.other)}</p>` : "",
    figure,
    factParts.length ? `<ul class="prerender__facts">${factParts.join("")}</ul>` : "",
    paragraphs,
    rights ? `<ul class="prerender__rights">${rights}</ul>` : "",
    `<p class="prerender__home"><a href="/">${esc(SITE_NAME[lang])}</a></p>`,
    `</article>`,
  ].join("");

  return [
    "<!DOCTYPE html>",
    `<html lang="${lang}" dir="${dir}">`,
    "<head>",
    meta.join("\n"),
    "</head>",
    "<body>",
    `<header class="masthead" id="masthead"></header>`,
    `<main id="view">${body}</main>`,
    `<footer class="site-footer" id="site-footer"></footer>`,
    `<div id="overlays"></div>`,
    SPA_SCRIPTS.map((src) => `<script src="${esc(src)}"></script>`).join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The object key for one item page.
 *
 * At the ROOT of the bucket, not inside /v/{ts}/, and that is the one structural decision in
 * this file. Everything else a release contains is immutable and versioned because the
 * manifest points at it; an item page is the opposite — it is the URL a person pasted into a
 * group chat two years ago, and it has to keep working without anybody resolving a pointer
 * first. A versioned item page would need the site to read manifest.json before it could
 * serve HTML, which is a request in front of every shared link and a redirect a crawler may
 * not follow.
 *
 * The cost is that these objects are rewritten in place on every publish rather than
 * accumulating — see release.ts for the cache TTL that makes that safe, and CLAUDE.md §2's
 * 19 Aug amendment for what rewriting everything on every release already costs.
 */
export function itemPageKey(id: string): string {
  return `item/${id}/index.html`;
}
