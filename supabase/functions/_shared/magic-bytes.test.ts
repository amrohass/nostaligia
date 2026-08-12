// Magic-byte sniffing — CLAUDE.md §6, "validate by magic bytes, not extension".
//
// The cases that matter here are the disagreements: a file whose declaration and whose
// bytes say different things. A sniffer that only ever sees honest files is untested
// against the only input it exists for.
//
//     deno test supabase/functions/_shared/

import { agreesWithDeclaration, type Family, sniff } from "./magic-bytes.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

/** Builds a header from byte values and/or ASCII runs, padded to a realistic length. */
function head(...parts: Array<number | string>): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "number") out.push(p);
    else out.push(...[...p].map((c) => c.charCodeAt(0)));
  }
  while (out.length < 64) out.push(0x00);
  return new Uint8Array(out);
}

function ftyp(brand: string): Uint8Array {
  return head(0x00, 0x00, 0x00, 0x20, "ftyp", brand, "\0\0\0\0");
}

function expect(bytes: Uint8Array, mime: string, family: Family, label: string): void {
  const s = sniff(bytes);
  assertEquals(s?.mime, mime, `${label}: mime`);
  assertEquals(s?.family, family, `${label}: family`);
}

// ── Images ───────────────────────────────────────────────────

Deno.test("still image signatures", () => {
  expect(head(0xff, 0xd8, 0xff, 0xe0), "image/jpeg", "image", "JPEG/JFIF");
  expect(head(0xff, 0xd8, 0xff, 0xe1), "image/jpeg", "image", "JPEG/Exif");
  expect(
    head(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a),
    "image/png",
    "image",
    "PNG",
  );
  expect(head("RIFF", 0, 0, 0, 0, "WEBP"), "image/webp", "image", "WebP");
  expect(head(0x49, 0x49, 0x2a, 0x00), "image/tiff", "image", "TIFF little-endian");
  expect(head(0x4d, 0x4d, 0x00, 0x2a), "image/tiff", "image", "TIFF big-endian");
  expect(ftyp("avif"), "image/avif", "image", "AVIF");
  expect(ftyp("heic"), "image/heic", "image", "HEIC");
  expect(ftyp("mif1"), "image/heif", "image", "HEIF");
});

// ── The ftyp family split, which is the subtle one ───────────
// MP4, QuickTime, HEIC, AVIF and M4A are one container. Reading the brand is what stops
// an audio file being routed into the video ladder, and a still image being transcoded.

Deno.test("ISO container brands route to the right family", () => {
  expect(ftyp("isom"), "video/mp4", "video", "isom");
  expect(ftyp("mp42"), "video/mp4", "video", "mp42");
  expect(ftyp("qt  "), "video/quicktime", "video", "QuickTime");
  expect(ftyp("M4A "), "audio/mp4", "audio", "M4A is AUDIO, not video");
  expect(ftyp("avif"), "image/avif", "image", "AVIF is an IMAGE, not video");
});

Deno.test("an unknown ISO brand is refused rather than guessed as mp4", () => {
  // Guessing mp4 would hand an unknown container to the transcoder. Refusing is the
  // safe direction for a format we cannot name.
  assertEquals(sniff(ftyp("XXXX")), null, "unrecognised brand must not resolve");
});

// ── Video and audio ──────────────────────────────────────────

Deno.test("video and audio signatures", () => {
  expect(head(0x1a, 0x45, 0xdf, 0xa3), "video/webm", "video", "EBML (WebM/Matroska)");
  expect(head("OggS"), "audio/ogg", "audio", "Ogg");
  expect(head("fLaC"), "audio/flac", "audio", "FLAC");
  expect(head("ID3", 0x03, 0x00), "audio/mpeg", "audio", "MP3 with ID3");
  expect(head(0xff, 0xfb), "audio/mpeg", "audio", "bare MPEG frame");
  expect(head(0xff, 0xf1), "audio/aac", "audio", "AAC ADTS");
  expect(head("RIFF", 0, 0, 0, 0, "WAVE"), "audio/wav", "audio", "WAV");
});

Deno.test("RIFF alone is not enough — the sub-type decides", () => {
  assertEquals(
    sniff(head("RIFF", 0, 0, 0, 0, "AVI ")),
    null,
    "a RIFF we have no pipeline for is refused, not called WebP",
  );
});

// ── SVG, which §6 rejects by name ────────────────────────────

Deno.test("SVG is detected by content, however it is dressed up", () => {
  const variants: Array<[string, string]> = [
    ["bare root element", "<svg xmlns='http://www.w3.org/2000/svg'></svg>"],
    ["leading whitespace", "\n\n   <svg xmlns='x'></svg>"],
    ["xml declaration", "<?xml version='1.0'?><svg xmlns='x'></svg>"],
    ["doctype", "<!DOCTYPE svg PUBLIC '-//W3C//DTD SVG 1.1//EN'><svg></svg>"],
    ["leading comment", "<!-- a comment --><svg></svg>"],
    ["uppercase", "<SVG XMLNS='x'></SVG>"],
  ];
  for (const [label, text] of variants) {
    const s = sniff(head(text));
    assertEquals(s?.mime, "image/svg+xml", `${label} must be detected as SVG`);
  }
});

Deno.test("SVG behind a UTF-8 BOM is still SVG", () => {
  const s = sniff(head(0xef, 0xbb, 0xbf, "<svg xmlns='x'></svg>"));
  assertEquals(s?.mime, "image/svg+xml", "a BOM must not hide the root element");
});

Deno.test("ordinary XML that is not SVG is refused, not mislabelled", () => {
  assertEquals(
    sniff(head("<?xml version='1.0'?><rss><channel></channel></rss>")),
    null,
    "an arbitrary XML document has no pipeline and must not become an image",
  );
});

// ── The disagreements this file exists for ───────────────────

Deno.test("a video declared as an image does not agree", () => {
  // The attack: declare image/jpeg (member cap 200 MB, no duration required), upload a
  // video. Without a family check it would skip the duration cap entirely.
  const s = sniff(ftyp("isom"));
  assertEquals(s?.family, "video", "the bytes say video");
  assert(!agreesWithDeclaration(s, "image"), "declared image must be refused");
  assert(agreesWithDeclaration(s, "video"), "declared video is fine");
});

Deno.test("an SVG declared as a PNG does not agree — and is caught twice", () => {
  const s = sniff(head("<svg xmlns='x'></svg>"));
  assertEquals(s?.mime, "image/svg+xml", "named, so the refusal is greppable");
  // Family alone would pass here, since SVG sniffs as an image. The mime is what the
  // caller must refuse on, which is why sniff() reports it separately.
  assert(agreesWithDeclaration(s, "image"), "family agrees — not sufficient on its own");
});

Deno.test("unrecognised bytes never agree with anything", () => {
  const junk = head(0x00, 0x01, 0x02, 0x03, "definitely not a media file");
  assertEquals(sniff(junk), null, "nothing claims it");
  for (const family of ["image", "video", "audio"] as const) {
    assert(!agreesWithDeclaration(null, family), `must not agree with ${family}`);
  }
});

Deno.test("a truncated or empty file is refused rather than throwing", () => {
  // The processing function reads a fixed-size head; a tiny object yields a short slice.
  for (const n of [0, 1, 2, 3, 7, 11]) {
    const short = new Uint8Array(n).fill(0xff);
    sniff(short); // must not throw
  }
  assertEquals(sniff(new Uint8Array(0)), null, "empty is not a media file");
});

Deno.test("sniffing is not validation — a 2-byte 'MP3' still sniffs as MP3", () => {
  // 0xFF 0xFB is a legitimate MPEG sync word, so this is reported as audio even though
  // it is far too short to be a playable file. That is correct and worth pinning: this
  // module answers "what does it claim to be", and the decoder in the next stage is what
  // answers "is it real". Anything that treats a non-null sniff as proof of validity has
  // misread what this gate does.
  const s = sniff(new Uint8Array([0xff, 0xfb]));
  assertEquals(s?.mime, "audio/mpeg", "the sync word is present, so the claim stands");
  assertEquals(s?.family, "audio", "and it routes to the audio pipeline to be rejected there");
});

// ── The polyglot case ────────────────────────────────────────

Deno.test("a polyglot is judged by what it leads with", () => {
  // A GIF/JS polyglot, a JPEG with a ZIP appended, an HTML file with an image header —
  // all of these are decided by the FIRST signature, not by anything later in the file.
  // That does not make the file safe; re-encoding does. It makes the routing honest.
  const jpegThenHtml = head(0xff, 0xd8, 0xff, 0xe0, "<html><script>alert(1)</script>");
  expect(jpegThenHtml, "image/jpeg", "image", "leads with JPEG");

  const htmlThenJpeg = head("<html><script>alert(1)</script>", 0xff, 0xd8, 0xff);
  assertEquals(sniff(htmlThenJpeg), null, "leads with HTML, which has no pipeline");
});
