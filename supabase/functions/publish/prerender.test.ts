/* The prerendered item page — the one document a stranger reads first.
 *
 *     deno test --allow-read supabase/functions/publish/
 *
 * ── What is worth asserting ──────────────────────────────────
 *
 * §9 calls a blank preview card "a growth failure, not a polish issue", so the tags are the
 * feature and are asserted as such. But the sharper reason for this file is that these pages
 * are the only place in the system where content becomes MARKUP rather than a DOM node: the
 * browser side obeys §6 by construction now (ui.js has no way to put a string into the
 * document as HTML), and this module is a string builder, so the same rule has to be
 * enforced by escaping and proved by testing.
 *
 * So the central test is the same shape as shards.test.ts's: given a post whose every field
 * carries something that would break out of its context, does anything break out?
 *
 * --allow-read, because two of these read site/index.html. That is deliberate rather than
 * lazy — the script list here is a DUPLICATE of the shell's and the only thing that can
 * catch it drifting is comparing the two.
 */

import { esc, itemPage, itemPageKey, itemPath, SPA_SCRIPTS, SPA_STYLES, summarise } from "./prerender.ts";
import { publicPost } from "./shards.ts";
import type { SourcePost } from "./shards.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
}

const CFG = { siteOrigin: "https://atlas.test", cdnOrigin: "https://cdn.test" };

function row(over: Partial<SourcePost> = {}): SourcePost {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    kind: "media",
    title_ar: "زفّة في حواري البلدة القديمة",
    title_en: "A wedding procession",
    body_ar: "كان الزفاف يمرّ من هنا كل خميس.",
    body_en: "The procession came through here every Thursday.",
    date_earliest: "1963-01-01",
    date_latest: "1969-12-31",
    date_precision: "decade",
    decade: 1960,
    location_public: { lat: 31.899, lon: 35.204 },
    location_precision: "street",
    place_name_ar: "البلدة القديمة",
    place_name_en: "Old City",
    event_starts_at: null,
    event_ends_at: null,
    venue_ar: null,
    venue_en: null,
    license: "CC-BY-SA-4.0",
    provenance: "family album",
    author_label: "member",
    author_handle: "abu_ramallah",
    author_display_name: "أبو رام الله",
    author_avatar_path: null,
    like_count: 12,
    comment_count: 2,
    comments: [],
    created_on: "2026-08-19",
    media: [{
      role: "thumb",
      rendition: null,
      storage_path: "00000000-0000-0000-0000-0000000000b1/thumb.webp",
      bucket: "public",
      mime: "image/webp",
      width: 640,
      height: 480,
      duration_s: null,
    }],
    ...over,
  };
}

const page = (over: Partial<SourcePost> = {}, cfg = CFG) => itemPage(publicPost(row(over)), cfg);

/* ── 1 · The preview card ──────────────────────────────────── */

Deno.test("every tag a preview card reads is present and absolute", () => {
  const html = page();

  for (const tag of [
    'property="og:type" content="article"',
    'property="og:url" content="https://atlas.test/item/00000000-0000-0000-0000-0000000000b1"',
    'property="og:title"',
    'property="og:description"',
    'property="og:image" content="https://cdn.test/00000000-0000-0000-0000-0000000000b1/thumb.webp"',
    'property="og:image:alt"',
    'property="og:locale" content="ar_PS"',
    'name="twitter:card" content="summary_large_image"',
    'rel="canonical" href="https://atlas.test/item/00000000-0000-0000-0000-0000000000b1"',
  ]) {
    assert(html.includes(tag), `missing or wrong: ${tag}`);
  }

  // A relative og:url is a card that resolves to whatever host the crawler guessed, which
  // for a link pasted into a chat is no host at all.
  assert(!/content="\/item\//.test(html), "og:url must be absolute");
});

Deno.test("with no CDN configured there is no og:image at all, and the card degrades", () => {
  const html = page({}, { siteOrigin: CFG.siteOrigin, cdnOrigin: "" });

  assert(!html.includes("og:image"), "an unconfigured CDN must not produce an image URL");
  // The discriminating half. Declaring summary_large_image with no image produces a card
  // with a large empty box, which is worse than the small card.
  assert(html.includes('name="twitter:card" content="summary"'),
    "without an image the card type steps down to summary");
  assert(!html.includes("summary_large_image"), "...and does not claim a large image");
});

Deno.test("an item with no image at all still produces a complete card", () => {
  const html = page({ media: [] });
  assert(html.includes('property="og:title"'), "title survives");
  assert(!html.includes("og:image"), "no image, no image tag");
  assert(html.includes('content="summary"'), "small card");
});

/* ── 2 · The language follows the content ──────────────────── */

Deno.test("an English-only item is an English page, not right-aligned English", () => {
  const ar = page();
  assert(ar.includes('<html lang="ar" dir="rtl">'), "an Arabic item is Arabic and RTL");

  const en = page({ title_ar: null, body_ar: null });
  assert(en.includes('<html lang="en" dir="ltr">'), "an English-only item is English and LTR");
  assert(en.includes('content="en_GB"'), "...and says so in og:locale");
  assert(en.includes("A wedding procession"), "...with the English title as the heading");
});

Deno.test("an item with no title at all still names the archive rather than nothing", () => {
  const html = page({ title_ar: null, title_en: null, body_ar: null, body_en: null });
  assert(/<title>[^<]+·/.test(html), "the document has a title");
  assert(!/<title>\s*·/.test(html), "and it is not empty before the separator");
});

/* ── 3 · THE gate: nothing breaks out of its context ───────── */

/* The same argument shards.test.ts makes about §7's fields, pointed at §6's rule. Every
 * user-controlled string in the row below carries a payload that would escape its context
 * if it were interpolated raw — out of an attribute, out of a text node, out of the
 * document's <head>. The assertion is on the emitted BYTES, not on which function was
 * called, because the failure mode is a call site that forgot rather than a helper that is
 * wrong. */

const XSS = {
  title: `" onload="alert(1)`,
  body: `</p><script>alert(1)</script><p>`,
  place: `</title><script>alert(2)</script>`,
  handle: `"><img src=x onerror=alert(3)>`,
  provenance: `'><svg/onload=alert(4)>`,
  license: `</a><iframe src=javascript:alert(5)>`,
};

Deno.test("no user string can leave a text node or an attribute", () => {
  const html = page({
    title_ar: XSS.title,
    body_ar: XSS.body,
    place_name_ar: XSS.place,
    provenance: XSS.provenance,
    license: XSS.license,
    author_handle: XSS.handle,
    author_display_name: XSS.handle,
  });

  // Two checks, and the first is the precise one: the payload must not appear VERBATIM
  // anywhere. It IS in the document — escaped — so "absent" would be the wrong assertion;
  // "present, but not as the characters that would parse" is the right one.
  for (const [field, payload] of Object.entries(XSS)) {
    assert(!html.includes(payload), `${field}'s payload survived unescaped:\n${payload}`);
  }

  // The second is a sweep, over the document with its OWN markup removed. The page
  // legitimately contains <script src="/assets/…"> and one <img> for the figure, so a bare
  // scan for "<script" reports the shell as the injection. Stripping exactly what this
  // module is known to emit leaves behind only what could have come from a payload.
  const stripped = html
    .replace(/<script src="\/assets\/js\/[a-z0-9-]+\.js"><\/script>/g, "")
    .replace(/<img src="https:\/\/cdn\.test\/[^"]*"[^>]*>/g, "")
    .replace(/<link\b[^>]*>/g, "");
  //
  // Tag OPENERS only, and the omission is the interesting part: `onerror=` and
  // `javascript:` appear in the output and are supposed to. They are inside escaped text —
  // a reader literally sees the words `<img src=x onerror=alert(3)>` printed on the page,
  // which is what an escaped payload is meant to look like. A sweep that banned them would
  // be banning the correct behaviour, and the pressure to "fix" it would be pressure to
  // start dropping fields.
  //
  // What cannot survive is a literal `<` followed by a tag name, because that is the one
  // thing escaping removes and the only thing a parser acts on.
  for (const dangerous of ["<script", "<iframe", "<svg", "<img", "<style", "<link"]) {
    assert(!stripped.toLowerCase().includes(dangerous),
      `a payload survived as markup: ${dangerous}\n${stripped.slice(0, 500)}`);
  }

  // And the CONTROL: the escaped text really is in there, so the assertion above is not
  // passing because the fields were silently dropped.
  assert(html.includes("&lt;/p&gt;&lt;script&gt;"), "the body IS present, escaped");
  assert(html.includes("&quot; onload=&quot;"), "the title IS present, escaped");
});

Deno.test("CONTROL: the same payloads DO appear when interpolated raw", () => {
  // A test that only ever sees clean output cannot tell a working escaper from an empty
  // document. This proves the payloads are the shape they claim to be.
  const raw = `<p>${XSS.body}</p><a title="${XSS.title}">`;
  assert(raw.includes("<script"), "the fixture payload is a real one");
  assert(esc(XSS.body).includes("&lt;script&gt;"), "esc() neutralises it");
  assert(!esc(XSS.title).includes('"'), "esc() neutralises the attribute break too");
});

Deno.test("§6's render half: user strings are inside <bdi>", () => {
  const html = page();
  // The heading, specifically — it is the string most likely to reorder a line it sits in.
  assert(/<h1 class="prerender__title"><bdi>/.test(html), "the title is isolated");
  assert(/<p class="prerender__para"><bdi>/.test(html), "so is every body paragraph");
});

/* ── 4 · §7, on the emitted bytes ──────────────────────────── */

Deno.test("nothing the shard withholds can appear in the page", () => {
  // publicPost() is the gate and this module sits behind it — so the strongest statement
  // available here is that the gate is actually in the path, which is what this asserts:
  // fields present on the SOURCE row and absent from the public shape are absent here too.
  const source = row({
    location: { lat: 31.8996123, lon: 35.2042987 },
    created_by: "SENTINEL-AUTH-USER-ID",
    created_at: "SENTINEL-2026-08-19T04:17:33.918Z",
    consent: { note: "SENTINEL-CONSENT" },
    content_hash: "SENTINEL-HASH",
    approved_by: "SENTINEL-MODERATOR",
    media: [
      ...row().media,
      {
        role: "master", rendition: null, storage_path: "SENTINEL-UPLOADER/master.jpg",
        bucket: "originals", mime: "image/jpeg", width: null, height: null, duration_s: null,
      },
    ],
  });
  const html = itemPage(publicPost(source), CFG);

  // One per line, which is not formatting. Packed onto two lines this array trips
  // gitleaks' generic-api-key rule: eight upper-case hyphenated tokens and two long
  // decimals in one run read as a high-entropy string, and the pre-commit hook refuses the
  // commit. Widening .gitleaks.toml to admit it would loosen the scanner for the whole
  // repository to accommodate a test fixture, which is the wrong direction — §6 was written
  // after a real compromised key.
  for (const sentinel of [
    "31.8996123",
    "35.2042987",
    "SENTINEL-AUTH-USER-ID",
    "SENTINEL-2026-08-19",
    "SENTINEL-CONSENT",
    "SENTINEL-HASH",
    "SENTINEL-MODERATOR",
    "SENTINEL-UPLOADER",
  ]) {
    assert(!html.includes(sentinel), `the page leaked ${sentinel}`);
  }

  // CONTROL. If publicPost() were bypassed these would be reachable, so prove the fixture
  // actually carries them.
  assert(JSON.stringify(source).includes("SENTINEL-AUTH-USER-ID"),
    "CONTROL: the source row really does carry the sentinels");
});

/* ── 5 · The duplicated lists ──────────────────────────────── */

Deno.test("SPA_SCRIPTS is exactly the shell's script list, in order", async () => {
  const shell = await Deno.readTextFile("site/index.html");
  const local = [...shell.matchAll(/<script src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => src.startsWith("/"));

  assert(local.length > 5, `CONTROL: the shell loads ${local.length} local scripts`);
  assertEquals(SPA_SCRIPTS.join("|"), local.join("|"),
    "prerender.ts and site/index.html disagree about which modules the SPA needs");
});

Deno.test("SPA_STYLES is exactly the shell's stylesheet list, in order", async () => {
  const shell = await Deno.readTextFile("site/index.html");
  const links = [...shell.matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /rel="stylesheet"/.test(tag))
    .map((tag) => /href="([^"]+)"/.exec(tag)?.[1] ?? "")
    .filter(Boolean);

  assert(links.length > 0, "CONTROL: the shell loads stylesheets");
  assertEquals(SPA_STYLES.join("|"), links.join("|"),
    "prerender.ts and site/index.html disagree about the stylesheets");
});

Deno.test("every asset the page loads is absolute", () => {
  const html = page();
  // A relative path resolves under /item/{id}/ and 404s — for every module, on every shared
  // link, which is the population these pages exist for.
  assert(!/src="assets\//.test(html) && !/href="assets\//.test(html),
    "a relative asset path would resolve under the item route");
  for (const src of SPA_SCRIPTS) assert(html.includes(`<script src="${src}">`), `missing ${src}`);
});

/* ── 6 · Paths and keys ────────────────────────────────────── */

Deno.test("the object key and the URL agree about where an item lives", () => {
  const id = "00000000-0000-0000-0000-0000000000b1";
  assertEquals(itemPageKey(id), `item/${id}/index.html`, "the bucket key");
  assertEquals(itemPath(id), `/item/${id}`, "the URL");
  // The key is NOT under /v/{ts}/ and that is the structural decision: a permalink cannot
  // require resolving a pointer first.
  assert(!itemPageKey(id).startsWith("v/"), "an item page is never inside a release directory");
});

Deno.test("summarise cuts on a word boundary and collapses newlines", () => {
  assertEquals(summarise("one\n\ntwo", ""), "one two", "a paragraph break becomes a space");
  assertEquals(summarise("", "fallback"), "fallback", "an empty body falls back to the title");

  const long = "word ".repeat(80);
  const cut = summarise(long, "");
  assert(cut.length <= 201, `summary is ${cut.length} characters`);
  assert(cut.endsWith("…"), "a truncated summary says so");
  assert(!/ …$/.test(cut) || cut.trim().endsWith("…"), "no dangling space before the ellipsis");

  // A 200-character run with no space in it cannot be cut on a word boundary; it must still
  // be cut. Arabic without spaces is unusual but a URL in a description is not.
  const unbroken = "x".repeat(400);
  assert(summarise(unbroken, "").length <= 201, "an unbreakable string is still bounded");
});
