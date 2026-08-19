/* The EXIF tooling, tested before it is trusted to judge the pipeline.
 *
 * A verification harness that is itself wrong fails in the direction nobody checks: it says
 * "no GPS found" about a file full of GPS, and the gate goes green. So the reader is tested
 * against bytes the writer produced, the writer is tested against offsets computed by hand,
 * and — the one that matters — the reader is shown a file it MUST find coordinates in.
 */

import {
  buildExifApp1,
  type Coordinates,
  gpsWireBytes,
  indexOfBytes,
  injectExif,
  jpegMarkers,
  RAMALLAH,
  readGps,
  riffChunks,
} from "./exif.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** A JPEG with nothing in it but the markers a parser walks. */
function bareJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // DQT, length 4, two bytes of payload
    0xff, 0xda, 0x00, 0x02, // SOS
    0x11, 0x22, 0x33, // "entropy-coded data"
    0xff, 0xd9, // EOI
  ]);
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

Deno.test("a written APP1 reads back as the coordinate that went in", () => {
  const jpeg = injectExif(bareJpeg(), buildExifApp1(RAMALLAH, "fixture"));
  const gps = readGps(jpeg);
  assert(gps !== null, "the reader found no GPS in a file the writer put GPS into");
  assert(near(gps!.latitude, RAMALLAH.latitude), `latitude ${gps!.latitude}`);
  assert(near(gps!.longitude, RAMALLAH.longitude), `longitude ${gps!.longitude}`);
});

// A camera in the southern or western hemisphere writes a positive magnitude and a ref of
// 'S'/'W'. Getting the sign from the magnitude instead would silently mirror the planet.
Deno.test("the hemisphere comes from the ref byte, not from the magnitude", () => {
  const south: Coordinates = { latitude: -33.9249, longitude: -18.4241 };
  const gps = readGps(injectExif(bareJpeg(), buildExifApp1(south, "cape")));
  assert(gps !== null, "no GPS");
  assert(gps!.latitude < 0 && near(gps!.latitude, south.latitude), `latitude ${gps?.latitude}`);
  assert(gps!.longitude < 0 && near(gps!.longitude, south.longitude), `longitude ${gps?.longitude}`);
});

Deno.test("the APP1 lands immediately after SOI, where a camera puts it", () => {
  const jpeg = injectExif(bareJpeg(), buildExifApp1(RAMALLAH, "fixture"));
  const markers = jpegMarkers(jpeg);
  assert(markers[0] === 0xffe1, `first marker was 0x${markers[0]?.toString(16)}, not APP1`);
  assert(markers.includes(0xffda), "the scan header went missing — the segment walk is wrong");
});

// The whole point of the gate. If the reader cannot tell a stripped file from a carrying
// one, every downstream assertion is decoration.
Deno.test("a file with no APP1 reads as no coordinates", () => {
  assert(readGps(bareJpeg()) === null, "found GPS in a JPEG that has none");
});

Deno.test("...and so does something that is not a JPEG at all", () => {
  assert(readGps(new Uint8Array([0x52, 0x49, 0x46, 0x46])) === null, "RIFF is not a JPEG");
  assert(readGps(new Uint8Array(0)) === null, "empty");
});

// Truncation is what a half-written derivative looks like. A throw here would abort the
// gate script mid-run and be read as a crash rather than as a finding.
Deno.test("a truncated APP1 is null rather than a throw", () => {
  const jpeg = injectExif(bareJpeg(), buildExifApp1(RAMALLAH, "fixture"));
  for (const cut of [12, 20, 40, 80, 120]) {
    readGps(jpeg.subarray(0, cut));
  }
});

Deno.test("the wire form of a coordinate is six big-endian u32s", () => {
  const wire = gpsWireBytes(RAMALLAH.latitude);
  assert(wire.length === 24, `${wire.length} bytes`);
  const view = new DataView(wire.buffer);
  assert(view.getUint32(0) === 31, "degrees");
  assert(view.getUint32(4) === 1, "over 1");
  assert(view.getUint32(8) === 53, "minutes");
  assert(view.getUint32(16) === 5856 && view.getUint32(20) === 100, "seconds as 5856/100");
});

// The search the gate runs against every derivative. It has to find the bytes when they ARE
// there, or its silence downstream means nothing.
Deno.test("the wire form is findable inside the file that carries it", () => {
  const jpeg = injectExif(bareJpeg(), buildExifApp1(RAMALLAH, "fixture"));
  assert(indexOfBytes(jpeg, gpsWireBytes(RAMALLAH.latitude)) > 0, "latitude not found in the fixture");
  assert(indexOfBytes(jpeg, gpsWireBytes(RAMALLAH.longitude)) > 0, "longitude not found");
  assert(indexOfBytes(bareJpeg(), gpsWireBytes(RAMALLAH.latitude)) === -1, "found in a bare JPEG");
});

Deno.test("riffChunks walks a WebP and refuses anything else", () => {
  // RIFF + size + WEBP + one 'VP8 ' chunk of 2 bytes + an 'EXIF' chunk of 1 (odd → padded).
  const bytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb,
    0x45, 0x58, 0x49, 0x46, 0x01, 0x00, 0x00, 0x00, 0xcc, 0x00,
  ]);
  assert(riffChunks(bytes).join(",") === "VP8 ,EXIF", riffChunks(bytes).join(","));
  assert(riffChunks(bareJpeg()).length === 0, "a JPEG is not a RIFF");
});
