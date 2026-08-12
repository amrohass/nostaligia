// What is this file actually? (CLAUDE.md §6: "Validate by magic bytes, not extension.")
//
// request-upload accepts a DECLARED mime type and signs a URL bound to it. The
// declaration is a claim by an untrusted client, and R2 will happily store whatever
// bytes arrive under whatever content-type was signed. So the first thing the processing
// function does is open the object and decide for itself.
//
// ── Why this is a sniffer and not a parser ───────────────────
//
// The job is NOT to prove the file is a valid, well-formed image. It cannot be: a
// malformed JPEG is still a JPEG, and proving otherwise means decoding, which is the
// expensive step this gate exists to protect. The job is narrower and achievable —
// establish what the file CLAIMS to be at the byte level, so that:
//
//   1  a declared image/jpeg that is actually a video is refused before a decoder sees
//      it, rather than being handed to the wrong pipeline;
//   2  SVG is caught by content and not only by declaration (§6 rejects SVG outright —
//      it is XML, it executes script, and it is the one "image" that is a document);
//   3  a polyglot — a file valid as two formats at once — is at minimum forced to lead
//      with a signature we recognise, instead of hiding behind an extension.
//
// Re-encoding is what actually neutralises a hostile image, and that happens after this.
// This gate makes sure the right decoder is chosen and the obviously-wrong things never
// reach one.
//
// ── No dependency, deliberately ──────────────────────────────
//
// Same reasoning as _shared/sigv4.ts. This runs on attacker-controlled bytes on the only
// path into the archive; a sniffing library is a supply-chain edge on that path, and the
// entire useful subset of the problem is a few dozen byte comparisons.

export type Family = "image" | "video" | "audio";

export interface Sniffed {
  /** The type the BYTES say it is. Never the declaration. */
  mime: string;
  family: Family;
}

/** How many leading bytes a caller must read for sniff() to be meaningful. */
export const SNIFF_LENGTH = 64;

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function startsWith(b: Uint8Array, sig: readonly (number | null)[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    const want = sig[i];
    if (want !== null && b[offset + i] !== want) return false; // null = wildcard
  }
  return true;
}

// ── ISO base media (ftyp) ────────────────────────────────────
// MP4, QuickTime, HEIC, AVIF and M4A are all the same container, distinguished only by
// the four-character brand at offset 8. Getting this wrong routes an audio file into the
// video ladder, so the brand is read rather than guessed.
const FTYP_BRANDS: Record<string, Sniffed> = {
  // still images
  avif: { mime: "image/avif", family: "image" },
  avis: { mime: "image/avif", family: "image" },
  heic: { mime: "image/heic", family: "image" },
  heix: { mime: "image/heic", family: "image" },
  heim: { mime: "image/heic", family: "image" },
  heis: { mime: "image/heic", family: "image" },
  hevc: { mime: "image/heic", family: "image" },
  mif1: { mime: "image/heif", family: "image" },
  msf1: { mime: "image/heif", family: "image" },
  // audio-only MP4
  M4A: { mime: "audio/mp4", family: "audio" },
  "M4A ": { mime: "audio/mp4", family: "audio" },
  M4B: { mime: "audio/mp4", family: "audio" },
  // video
  qt: { mime: "video/quicktime", family: "video" },
  "qt  ": { mime: "video/quicktime", family: "video" },
  isom: { mime: "video/mp4", family: "video" },
  iso2: { mime: "video/mp4", family: "video" },
  iso4: { mime: "video/mp4", family: "video" },
  iso5: { mime: "video/mp4", family: "video" },
  iso6: { mime: "video/mp4", family: "video" },
  mp41: { mime: "video/mp4", family: "video" },
  mp42: { mime: "video/mp4", family: "video" },
  mp4v: { mime: "video/mp4", family: "video" },
  avc1: { mime: "video/mp4", family: "video" },
  dash: { mime: "video/mp4", family: "video" },
  MSNV: { mime: "video/mp4", family: "video" },
  NDAS: { mime: "video/mp4", family: "video" },
};

function sniffFtyp(b: Uint8Array): Sniffed | null {
  if (!startsWith(b, ascii("ftyp"), 4)) return null;
  const brand = String.fromCharCode(...b.slice(8, 12));
  const hit = FTYP_BRANDS[brand] ?? FTYP_BRANDS[brand.trim()];
  if (hit) return hit;
  // An unknown brand is still an ISO container. Calling it mp4 would send it to the
  // video ladder on a guess; returning null refuses it instead, which is the safe
  // direction for a format we cannot name.
  return null;
}

// ── RIFF (WebP, WAV) ─────────────────────────────────────────
function sniffRiff(b: Uint8Array): Sniffed | null {
  if (!startsWith(b, ascii("RIFF"))) return null;
  if (startsWith(b, ascii("WEBP"), 8)) return { mime: "image/webp", family: "image" };
  if (startsWith(b, ascii("WAVE"), 8)) return { mime: "audio/wav", family: "audio" };
  return null;
}

// ── SVG ──────────────────────────────────────────────────────
// Not a bitmap and not really an image: it is an XML document that can carry script and
// remote references. §6 rejects it by name. It has no binary signature, so this looks
// for the document start within the sniff window, tolerating a BOM, whitespace, an XML
// declaration, a doctype or comments before the root element.
function sniffSvg(b: Uint8Array): Sniffed | null {
  let start = 0;
  if (startsWith(b, [0xef, 0xbb, 0xbf])) start = 3; // UTF-8 BOM
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.slice(start, SNIFF_LENGTH))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg")) return { mime: "image/svg+xml", family: "image" };
  // `<?xml` or `<!doctype svg` or a leading comment: only claim SVG if the word appears,
  // so an arbitrary XML document is refused as unknown rather than mislabelled.
  if (head.startsWith("<?xml") || head.startsWith("<!doctype") || head.startsWith("<!--")) {
    if (head.includes("<svg") || head.includes("svg")) {
      return { mime: "image/svg+xml", family: "image" };
    }
  }
  return null;
}

/**
 * What the bytes say the file is, or null if nothing recognised it.
 *
 * Pass at least SNIFF_LENGTH bytes from the START of the object. A null return is a
 * refusal, not a fallback to the declaration — an unrecognised file is one we have no
 * pipeline for and must not store.
 */
export function sniff(bytes: Uint8Array): Sniffed | null {
  const b = bytes;

  // Checked first and unconditionally: §6 wants SVG refused, and the reason to be
  // nameable in a log rather than folded into a generic "unsupported".
  const svg = sniffSvg(b);
  if (svg) return svg;

  // ── images ──
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", family: "image" };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", family: "image" };
  }
  // TIFF, both endiannesses. Also what most camera raw files lead with.
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00])) return { mime: "image/tiff", family: "image" };
  if (startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return { mime: "image/tiff", family: "image" };

  const riff = sniffRiff(b);
  if (riff) return riff;

  const ftyp = sniffFtyp(b);
  if (ftyp) return ftyp;

  // ── video ──
  // Matroska and WebM share the EBML header; telling them apart needs the DocType, which
  // is past the sniff window. Both go to the same pipeline, so the distinction is not
  // load-bearing — but the declared type is not trusted to make it either.
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: "video/webm", family: "video" };
  }

  // ── audio ──
  if (startsWith(b, ascii("OggS"))) return { mime: "audio/ogg", family: "audio" };
  if (startsWith(b, ascii("fLaC"))) return { mime: "audio/flac", family: "audio" };
  if (startsWith(b, ascii("ID3"))) return { mime: "audio/mpeg", family: "audio" };
  // A bare MPEG audio frame: 11 sync bits set. 0xFF followed by 0xEx or 0xFx covers
  // MPEG-1/2/2.5 layers; 0xF1/0xF9 is AAC in an ADTS wrapper.
  if (b.length > 1 && b[0] === 0xff) {
    const s = b[1];
    if (s === 0xf1 || s === 0xf9) return { mime: "audio/aac", family: "audio" };
    if ((s & 0xe0) === 0xe0) return { mime: "audio/mpeg", family: "audio" };
  }

  return null;
}

/**
 * Are the sniffed bytes acceptable for what was declared at request-upload time?
 *
 * Equality of mime is NOT required, and demanding it would reject ordinary uploads: a
 * browser that declares `video/quicktime` for a file whose brand reads `isom` is not
 * lying, it is guessing from the extension, and both go to the same pipeline. What must
 * match is the FAMILY, because the family is what selects the pipeline and enforces the
 * §6 duration cap.
 */
export function agreesWithDeclaration(
  sniffed: Sniffed | null,
  declaredFamily: Family,
): boolean {
  return sniffed !== null && sniffed.family === declaredFamily;
}
