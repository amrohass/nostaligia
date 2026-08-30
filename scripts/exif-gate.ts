/* §11 launch gate 2 — "EXIF stripping verified on a real photo carrying GPS data, end to
 * end" — discharged against the DEPLOYED archive rather than against a local re-encode.
 *
 * WHY IT NEEDED ITS OWN SCRIPT. The 30 Aug addendum got most of the way there: it observed
 * that the published WebP had no EXIF chunk. But the gate is not "the output is clean" —
 * an output with no EXIF is also what you get from an input that never had any, and from a
 * pipeline that silently dropped the file. The gate is that a photo which DEMONSTRABLY
 * CARRIED GPS went in and a derivative with no trace of it came out. So this reads both
 * ends of the same object: the master out of `originals/` over a signed request, and the
 * derivative off the public CDN, and it fails if the master turns out to have no GPS to
 * strip — because then the run proved nothing and must not be recorded as a pass.
 *
 * Both parsers are written out rather than pulled in: §9's no-dependency rule, and an EXIF
 * library is a large amount of code to trust for a question this narrow.
 *
 *   deno run --allow-read --allow-env --allow-net scripts/exif-gate.ts
 */

import { presignR2 } from '../supabase/functions/_shared/sigv4.ts';

const CDN = 'https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev';

function readDevVars(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of Deno.readTextFileSync(path).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = readDevVars('supabase/functions/.dev.vars');

/* ── JPEG: find APP1/Exif, walk the TIFF IFD, report the GPS tags ──────────────
   Only as much TIFF as the question needs: IFD0, its GPS IFD pointer (0x8825), and the
   latitude/longitude tags inside it. Values are decoded so the output can show that real
   coordinates were present — an assertion that "a GPS IFD exists" would be satisfied by an
   empty one. */
function jpegGps(buf: Uint8Array): { found: boolean; lat?: number; lon?: number; tags: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 2; // skip SOI
  while (p < buf.length - 4) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    if (marker === 0xda) break;                     // start of scan: metadata is behind us
    const len = dv.getUint16(p + 2);
    if (marker === 0xe1) {                          // APP1
      const s = p + 4;
      const tag = new TextDecoder().decode(buf.subarray(s, s + 4));
      if (tag === 'Exif') {
        const tiff = s + 6;
        const le = String.fromCharCode(buf[tiff], buf[tiff + 1]) === 'II';
        const u16 = (o: number) => dv.getUint16(tiff + o, le);
        const u32 = (o: number) => dv.getUint32(tiff + o, le);
        const ifd0 = u32(4);
        const count = u16(ifd0);
        let gpsOff = 0;
        for (let i = 0; i < count; i++) {
          const e = ifd0 + 2 + i * 12;
          if (u16(e) === 0x8825) gpsOff = u32(e + 8);
        }
        if (!gpsOff) return { found: false, tags: 0 };
        const gc = u16(gpsOff);
        const rational = (off: number, n: number) => {
          const out: number[] = [];
          for (let k = 0; k < n; k++) {
            const num = u32(off + k * 8);
            const den = u32(off + k * 8 + 4);
            out.push(den === 0 ? 0 : num / den);
          }
          return out;
        };
        let lat: number | undefined;
        let lon: number | undefined;
        for (let i = 0; i < gc; i++) {
          const e = gpsOff + 2 + i * 12;
          const t = u16(e);
          if (t === 2 || t === 4) {
            const [d, m, s2] = rational(u32(e + 8), 3);
            const v = d + m / 60 + s2 / 3600;
            if (t === 2) lat = v; else lon = v;
          }
        }
        return { found: true, lat, lon, tags: gc };
      }
    }
    p += 2 + len;
  }
  return { found: false, tags: 0 };
}

/* ── WebP: list RIFF chunk FourCCs. EXIF and XMP travel as their own chunks. ── */
function webpChunks(buf: Uint8Array): string[] {
  const td = new TextDecoder();
  if (td.decode(buf.subarray(0, 4)) !== 'RIFF' || td.decode(buf.subarray(8, 12)) !== 'WEBP') return ['<not a webp>'];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: string[] = [];
  let p = 12;
  while (p + 8 <= buf.length) {
    out.push(td.decode(buf.subarray(p, p + 4)));
    const size = dv.getUint32(p + 4, true);
    p += 8 + size + (size % 2);
  }
  return out;
}

async function getOriginal(key: string): Promise<Uint8Array> {
  const p = await presignR2({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: 'originals',
    key,
    method: 'GET',
    expiresIn: 120,
    bucketPrefix: env.R2_BUCKET_PREFIX ?? '',
  });
  const r = await fetch(p.url);
  if (!r.ok) throw new Error(`originals GET ${r.status} for ${key}`);
  return new Uint8Array(await r.arrayBuffer());
}

interface Pair { post: string; masterKey: string; derivatives: string[] }
const pairs: Pair[] = JSON.parse(new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer()));

let bad = 0;
let provedOne = false;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? 'ok    ' : 'NOT OK'}  ${m}`); if (!c) bad++; };

for (const pr of pairs) {
  const master = await getOriginal(pr.masterKey);
  const isJpeg = master[0] === 0xff && master[1] === 0xd8;
  if (!isJpeg) {
    console.log(`  --      ${pr.post.slice(0, 8)} master is not a JPEG, skipped for the GPS half`);
    continue;
  }
  const gps = jpegGps(master);
  console.log(`\n  ${pr.post.slice(0, 8)} master ${master.length} bytes — GPS IFD ${gps.found ? `PRESENT, ${gps.tags} tags, lat ${gps.lat?.toFixed(6)} lon ${gps.lon?.toFixed(6)}` : 'absent'}`);

  if (!gps.found) {
    console.log('          (nothing to strip — this one cannot discharge the gate)');
    continue;
  }
  provedOne = true;

  for (const d of pr.derivatives) {
    const r = await fetch(`${CDN}/${d}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const chunks = webpChunks(bytes);
    const hasExif = chunks.includes('EXIF');
    const hasXmp = chunks.includes('XMP ');
    ok(!hasExif, `${d.split('/')[1]} carries no EXIF chunk (chunks: ${chunks.join(',')})`);
    ok(!hasXmp, `${d.split('/')[1]} carries no XMP chunk`);

    /* Belt and braces: the coordinate must not survive as a raw byte pattern either — a
       re-encoder that copied the APP1 payload into a comment would pass a chunk check. */
    const hay = new TextDecoder('latin1').decode(bytes);
    ok(!hay.includes('Exif\0\0') && !/GPSLatitude|GPSLongitude/.test(hay),
      `${d.split('/')[1]} contains no Exif marker or GPS tag name anywhere in its bytes`);
  }
}

/* THE anti-vacuity check, and the reason this script exists rather than a grep. */
ok(provedOne,
  'at least one master demonstrably carried GPS — otherwise this run proves nothing and is not a pass');

console.log(`\n${bad === 0 ? 'launch gate 2: EXIF stripping verified end to end' : bad + ' check(s) FAILED'}`);
Deno.exit(bad === 0 ? 0 : 1);
