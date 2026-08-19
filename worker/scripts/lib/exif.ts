/* EXIF, by hand, in both directions — the tooling §11 gate 2 needs and nothing more.
 *
 * §11: "EXIF stripping verified on a real photo carrying GPS data, end to end."
 *
 * Every assertion the repository makes about stripping today is an assertion about ARGV:
 * ladder.test.ts checks that `-map_metadata -1` appears in the array, and ladder-fixture.ts
 * checks that a `-metadata title=` tag stamped by ffmpeg does not survive. Neither is the
 * gate. A container tag written by the same tool that removes it proves the flag is spelled
 * correctly; it does not prove that the APP1 segment of a photograph — the actual carrier of
 * the actual coordinates of an actual person's actual home — is gone from the file the CDN
 * serves.
 *
 * The gap is not pedantry. EXIF GPS and an ffmpeg format tag live in different places, are
 * parsed by different code, and survive differently: a JPEG's APP1 is a block the mjpeg
 * decoder never has to look at, and "the tag went away" is entirely compatible with "the
 * block was copied through". §7 calls the aggregate — identity plus history plus precise
 * coordinates — a de-anonymization vector, and this is the coordinates half.
 *
 * ── Why write EXIF rather than commit a photograph ───────────
 *
 * A real photograph carrying real GPS is somebody's real location. Committing one to a
 * public repository to test that we remove locations is its own small joke. A synthesized
 * frame with a synthesized APP1 has the same bytes in the same places, is a few hundred
 * bytes, and names a coordinate everyone involved already knows: the middle of Ramallah.
 *
 * ── Why no library ───────────────────────────────────────────
 *
 * §6: the worker's dependency surface is a credential path. This runs beside it, reads the
 * files it produced, and adding an npm EXIF parser to do so would put a transitive tree next
 * to the container that holds the R2 keys. The subset of TIFF needed here is one header,
 * two IFDs and one tag type, and it is written out below in full.
 *
 * Everything in this file is pure. exif.test.ts covers it with no ffmpeg and no files.
 */

/** Decimal degrees, as a person would write them. */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** The middle of Ramallah — al-Manara. A coordinate nobody has to be careful with. */
export const RAMALLAH: Coordinates = { latitude: 31.8996, longitude: 35.2042 };

/* ── TIFF primitives ────────────────────────────────────────
 *
 * Big-endian throughout ("MM"). TIFF permits either byte order and a real camera may use
 * "II"; the READER below handles both, because it has to read whatever a camera wrote. The
 * WRITER picks one, because it only has to be read by the reader.
 */

const TAG_IMAGE_DESCRIPTION = 0x010e;
const TAG_GPS_IFD = 0x8825;

const GPS_VERSION_ID = 0x0000;
const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/** deg/min/sec as three TIFF RATIONALs. 5856/100 rather than 58.56 — TIFF has no floats. */
function toDms(decimal: number): Array<[number, number]> {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  // Hundredths of a second. Rounded, so the round-trip is exact to ~0.3 mm.
  const sec = Math.round((minFloat - min) * 60 * 100);
  return [[deg, 1], [min, 1], [sec, 100]];
}

function fromDms(dms: Array<[number, number]>, ref: string): number {
  const [d, m, s] = dms.map(([n, den]) => (den === 0 ? 0 : n / den));
  const magnitude = d + m / 60 + s / 3600;
  return ref === "S" || ref === "W" ? -magnitude : magnitude;
}

/**
 * A complete APP1 segment — marker, length, `Exif\0\0`, and a TIFF block carrying GPS.
 *
 * Offsets are computed from the sizes rather than written as constants, so a change to the
 * entry count cannot silently leave a pointer aimed at the middle of a rational.
 */
export function buildExifApp1(gps: Coordinates, description: string): Uint8Array {
  const desc = new TextEncoder().encode(description + "\0");
  // TIFF wants offsets word-aligned. The description is last, so this only ever pads the end.
  const descLen = desc.length + (desc.length % 2);

  const HEADER = 8;
  const IFD0_SIZE = 2 + 2 * 12 + 4; // count + two entries + next-IFD pointer
  const GPS_SIZE = 2 + 5 * 12 + 4; // count + five entries + next-IFD pointer

  const gpsOff = HEADER + IFD0_SIZE;
  const latOff = gpsOff + GPS_SIZE;
  const lonOff = latOff + 24; // three RATIONALs
  const descOff = lonOff + 24;
  const tiffLen = descOff + descLen;

  const tiff = new Uint8Array(tiffLen);
  const view = new DataView(tiff.buffer);
  let p = 0;
  const u16 = (v: number) => { view.setUint16(p, v); p += 2; };
  const u32 = (v: number) => { view.setUint32(p, v); p += 4; };
  const entry = (tag: number, type: number, count: number, write: () => void) => {
    u16(tag);
    u16(type);
    u32(count);
    const after = p + 4;
    write();
    p = after; // whatever `write` did, the entry is exactly 12 bytes
  };

  // Header: byte order, magic 42, offset of IFD0.
  tiff[p++] = 0x4d; // 'M'
  tiff[p++] = 0x4d; // 'M'
  u16(42);
  u32(HEADER);

  // IFD0 — two entries, ascending by tag as TIFF requires.
  u16(2);
  entry(TAG_IMAGE_DESCRIPTION, TYPE_ASCII, desc.length, () => u32(descOff));
  entry(TAG_GPS_IFD, TYPE_LONG, 1, () => u32(gpsOff));
  u32(0); // no IFD1: no thumbnail

  // GPS IFD — five entries, also ascending.
  u16(5);
  entry(GPS_VERSION_ID, TYPE_BYTE, 4, () => {
    tiff[p] = 2;
    tiff[p + 1] = 3;
  });
  entry(GPS_LAT_REF, TYPE_ASCII, 2, () => {
    tiff[p] = gps.latitude >= 0 ? 0x4e : 0x53; // N | S
  });
  entry(GPS_LAT, TYPE_RATIONAL, 3, () => u32(latOff));
  entry(GPS_LON_REF, TYPE_ASCII, 2, () => {
    tiff[p] = gps.longitude >= 0 ? 0x45 : 0x57; // E | W
  });
  entry(GPS_LON, TYPE_RATIONAL, 3, () => u32(lonOff));
  u32(0);

  // The rationals the two pointers above aim at.
  p = latOff;
  for (const [n, d] of toDms(gps.latitude)) { u32(n); u32(d); }
  p = lonOff;
  for (const [n, d] of toDms(gps.longitude)) { u32(n); u32(d); }
  tiff.set(desc, descOff);

  const payload = new Uint8Array(6 + tiff.length);
  payload.set(new TextEncoder().encode("Exif\0\0"), 0);
  payload.set(tiff, 6);

  // The APP1 length field counts itself but not the FFE1 marker.
  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, payload.length + 2);
  segment.set(payload, 4);
  return segment;
}

/**
 * The photograph, as a camera would have handed it over: an APP1 immediately after SOI.
 *
 * Real cameras put it there, and a decoder that only scans until the first scan header would
 * otherwise never see it — which would make this fixture easier to strip than a real file.
 */
export function injectExif(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) throw new Error("not a JPEG: no SOI");
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

/** Every marker in a JPEG, in order, as `0xFFxx` numbers. Stops at the compressed scan. */
export function jpegMarkers(jpeg: Uint8Array): number[] {
  const markers: number[] = [];
  if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) return markers;
  let i = 2;
  while (i + 3 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    markers.push(0xff00 | marker);
    if (marker === 0xda) break; // SOS — entropy-coded data follows, not segments
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (len < 2) break;
    i += 2 + len;
  }
  return markers;
}

/**
 * The coordinates in a JPEG, or null.
 *
 * Deliberately forgiving: anything it cannot parse is `null`, never a throw. A test that
 * crashes on a stripped file and a test that passes on one are the same result, and only one
 * of them looks like a pass.
 */
export function readGps(jpeg: Uint8Array): Coordinates | null {
  // The bounds checks below cover the malformations worth naming; this covers the rest.
  // A DataView read past the end throws RangeError, and a half-written derivative — which
  // is precisely what this is pointed at — is full of those. A throw here would abort the
  // gate script mid-run and be read as a crash rather than as a finding.
  //
  // It cannot hide a false negative: exif.test.ts asserts the positive direction on a file
  // that DOES carry coordinates, so a reader that returned null for everything would fail
  // there first.
  try {
    return parseGps(jpeg);
  } catch {
    return null;
  }
}

function parseGps(jpeg: Uint8Array): Coordinates | null {
  if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) return null;

  // Locate the Exif APP1.
  let i = 2;
  let tiffStart = -1;
  while (i + 3 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xda) break;
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (len < 2) break;
    if (marker === 0xe1) {
      const head = jpeg.subarray(i + 4, i + 10);
      if (new TextDecoder().decode(head) === "Exif\0\0") {
        tiffStart = i + 10;
        break;
      }
    }
    i += 2 + len;
  }
  if (tiffStart < 0 || tiffStart + 8 > jpeg.length) return null;

  const view = new DataView(jpeg.buffer, jpeg.byteOffset + tiffStart, jpeg.length - tiffStart);
  const order = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  if (order !== "MM" && order !== "II") return null;
  const big = order === "MM";
  const u16 = (o: number) => view.getUint16(o, !big);
  const u32 = (o: number) => view.getUint32(o, !big);
  if (u16(2) !== 42) return null;

  const findTag = (ifd: number, tag: number): { type: number; count: number; at: number } | null => {
    if (ifd + 2 > view.byteLength) return null;
    const n = u16(ifd);
    for (let e = 0; e < n; e++) {
      const off = ifd + 2 + e * 12;
      if (off + 12 > view.byteLength) return null;
      if (u16(off) === tag) return { type: u16(off + 2), count: u32(off + 4), at: off + 8 };
    }
    return null;
  };

  const gpsPointer = findTag(u32(4), TAG_GPS_IFD);
  if (!gpsPointer || gpsPointer.type !== TYPE_LONG) return null;
  const gpsIfd = u32(gpsPointer.at);

  const rationals = (tag: number): Array<[number, number]> | null => {
    const f = findTag(gpsIfd, tag);
    if (!f || f.type !== TYPE_RATIONAL || f.count !== 3) return null;
    const base = u32(f.at);
    if (base + 24 > view.byteLength) return null;
    const out: Array<[number, number]> = [];
    for (let k = 0; k < 3; k++) out.push([u32(base + k * 8), u32(base + k * 8 + 4)]);
    return out;
  };
  const ref = (tag: number): string | null => {
    const f = findTag(gpsIfd, tag);
    if (!f || f.type !== TYPE_ASCII || f.at >= view.byteLength) return null;
    return String.fromCharCode(view.getUint8(f.at));
  };

  const lat = rationals(GPS_LAT);
  const lon = rationals(GPS_LON);
  const latRef = ref(GPS_LAT_REF);
  const lonRef = ref(GPS_LON_REF);
  if (!lat || !lon || !latRef || !lonRef) return null;

  return { latitude: fromDms(lat, latRef), longitude: fromDms(lon, lonRef) };
}

/**
 * The four-character chunk ids in a RIFF/WebP file, in order.
 *
 * WebP is where an image derivative lands (ladder.ts encodes with libwebp), and WebP carries
 * metadata in `EXIF` and `XMP ` chunks — a different container with the same problem.
 */
export function riffChunks(bytes: Uint8Array): string[] {
  // Chunk ids are four raw bytes, not text in any encoding. fromCharCode rather than a
  // TextDecoder so a byte outside ASCII becomes a visible character rather than U+FFFD,
  // which would make two different malformed ids compare equal.
  const fourCC = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

  if (bytes.length < 12) return [];
  if (fourCC(0) !== "RIFF" || fourCC(8) !== "WEBP") return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids: string[] = [];
  let p = 12;
  while (p + 8 <= bytes.length) {
    ids.push(fourCC(p));
    const size = view.getUint32(p + 4, true);
    if (size < 0 || size > bytes.length) break;
    p += 8 + size + (size % 2); // chunks are padded to an even length
  }
  return ids;
}

/** Where `needle` first occurs in `haystack`, or -1. Naive on purpose; the inputs are small. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * The coordinate as it appears on the wire: six big-endian u32s, deg/min/sec over their
 * denominators.
 *
 * Searching a derivative for THIS is the assertion that does not depend on knowing which
 * container the derivative turned out to be. A stripper that dropped the EXIF chunk while
 * copying the block into a comment somewhere would still be caught.
 */
export function gpsWireBytes(decimal: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer);
  toDms(decimal).forEach(([n, d], k) => {
    view.setUint32(k * 8, n);
    view.setUint32(k * 8 + 4, d);
  });
  return out;
}
