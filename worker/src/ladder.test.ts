// The ladder, and the three flags that fail silently.
//
// Rung selection at 4K is arithmetic, so it is asserted here at 2160 with no 4K file in
// sight — which is what makes the whole ladder testable on a laptop. The encode itself is
// exercised on a 2-second generated clip by worker/scripts/ladder-fixture.ts, and at real
// 4K on a CI runner.
//
// The argv assertions look pedantic and are not. -map_metadata -1 is CLAUDE.md §11 gate 2;
// drop it and every photograph publishes the GPS coordinates in its EXIF while the output
// file looks perfect. +faststart and -map 0:v:0 fail equally quietly.
//
//     deno test worker/

import {
  audioArgs,
  DURATION_CEILING_S,
  imageArgs,
  parseProbe,
  posterArgs,
  probeArgs,
  thumbArgs,
  VIDEO_LADDER,
  videoArgs,
  videoRungs,
  waveformArgs,
} from "./ladder.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const names = (h: number) => videoRungs(h).map((r) => r.name).join(",");

/** Asserts a flag and its value appear adjacently, not merely somewhere in the array. */
function hasFlag(args: string[], flag: string, value?: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  return value === undefined || args[i + 1] === value;
}

// ── Rung selection ───────────────────────────────────────────

Deno.test("a 4K master yields the four delivery rungs and never a 2160p one", () => {
  assertEquals(names(2160), "1440p,1080p,720p,480p", "§6's ladder, in order");
  assert(
    !videoRungs(2160).some((r) => (r.name as string) === "2160p"),
    "§6: 4K is not streamed. A 2160p rendition means the master became a delivery path",
  );
});

Deno.test("the ladder never reaches above the source height", () => {
  assertEquals(names(1440), "1440p,1080p,720p,480p", "1440 gets everything at or below it");
  assertEquals(names(1080), "1080p,720p,480p", "no 1440p from a 1080p source");
  assertEquals(names(720), "720p,480p", "no 1080p from a 720p source");
  assertEquals(names(480), "480p", "the bottom rung alone");
});

Deno.test("an odd source height falls to the rungs beneath it", () => {
  assertEquals(names(1600), "1440p,1080p,720p,480p", "1600 is above 1440");
  assertEquals(names(1000), "720p,480p", "1000 is below 1080 and above 720");
  assertEquals(names(500), "480p", "just above the floor");
});

// The case that would otherwise produce an item with nothing playable behind it.
Deno.test("a source below the bottom rung still gets one rendition, unscaled", () => {
  const rungs = videoRungs(360);
  assertEquals(rungs.length, 1, "exactly one");
  assertEquals(rungs[0].name, "480p", "labelled with the bottom rung");
  assertEquals(rungs[0].height, 360, "but encoded at its own height — never upscaled");
  assert(rungs[0].videoKbps < 1000, "and given proportionally less bitrate");
  assert(rungs[0].videoKbps >= 300, "with a floor, so it is not encoded into mush");
});

Deno.test("an unreadable height yields no rungs rather than a guess", () => {
  for (const h of [0, -1, NaN, Infinity]) {
    assertEquals(videoRungs(h).length, 0, `${h} must not produce a rung`);
  }
});

Deno.test("the ceiling is §6's largest role cap", () => {
  assertEquals(DURATION_CEILING_S, 20 * 60, "20 minutes — the moderator cap");
});

// ── The flags that fail silently ─────────────────────────────

Deno.test("every video rung strips metadata, faststarts, and takes one video stream", () => {
  for (const rung of VIDEO_LADDER) {
    const args = videoArgs("/in.mp4", "/out.mp4", rung);
    assert(hasFlag(args, "-map_metadata", "-1"), `${rung.name}: EXIF/metadata strip (§11 gate 2)`);
    assert(hasFlag(args, "-movflags", "+faststart"), `${rung.name}: faststart`);
    assert(hasFlag(args, "-map", "0:v:0"), `${rung.name}: exactly one video stream`);
    assert(args.includes("-sn") && args.includes("-dn"), `${rung.name}: no subtitle/data passthrough`);
    assert(hasFlag(args, "-c:v", "libx264"), `${rung.name}: §6 says H.264`);
    assert(hasFlag(args, "-c:a", "aac"), `${rung.name}: §6 says AAC`);
    assert(hasFlag(args, "-b:v", `${rung.videoKbps}k`), `${rung.name}: the §6 bitrate`);
    assert(hasFlag(args, "-vf", `scale=-2:${rung.height}:flags=lanczos`), `${rung.name}: scaled`);
  }
});

Deno.test("the §6 bitrates are the ones in the table", () => {
  const byName = Object.fromEntries(VIDEO_LADDER.map((r) => [r.name, r.videoKbps]));
  assertEquals(byName["1440p"], 8000, "1440p ~8 Mbps");
  assertEquals(byName["1080p"], 5000, "1080p ~5 Mbps");
  assertEquals(byName["720p"], 2500, "720p ~2.5 Mbps");
  assertEquals(byName["480p"], 1000, "480p ~1 Mbps");
});

Deno.test("the poster seeks before decoding, and takes a single frame", () => {
  const args = posterArgs("/in.mp4", "/poster.webp", 1);
  const ss = args.indexOf("-ss");
  const input = args.indexOf("-i");
  assert(ss !== -1 && ss < input, "-ss before -i, or a 4K master is decoded up to the mark");
  assert(hasFlag(args, "-frames:v", "1"), "one frame");
  assert(hasFlag(args, "-map_metadata", "-1"), "and no metadata carried into it");
});

Deno.test("an image is capped without ever being enlarged", () => {
  const args = imageArgs("/in.jpg", "/out.webp");
  const vf = args[args.indexOf("-vf") + 1];
  assert(vf.includes("min(iw,1920)") && vf.includes("min(ih,1920)"), `no-upscale cap, got ${vf}`);
  assert(
    vf.includes("force_original_aspect_ratio=decrease"),
    "aspect preserved on the way down",
  );
  // An animated WebP or a multi-page TIFF is one upload and many frames.
  assert(hasFlag(args, "-frames:v", "1"), "one frame out, whatever came in");
  assert(hasFlag(args, "-map_metadata", "-1"), "EXIF stripped — §11 gate 2");
});

Deno.test("a thumbnail is a fixed width and carries no metadata", () => {
  const args = thumbArgs("/in.webp", "/thumb.webp");
  assert(hasFlag(args, "-vf", "scale=400:-2:flags=lanczos"), "400px wide, aspect preserved");
  assert(hasFlag(args, "-map_metadata", "-1"), "and stripped");
});

Deno.test("audio is normalized, mono, and inside §6's bitrate range", () => {
  const args = audioArgs("/in.m4a", "/out.opus");
  const af = args[args.indexOf("-af") + 1];
  assert(af.startsWith("loudnorm="), `EBU R128 normalization, got ${af}`);
  assert(hasFlag(args, "-ac", "1"), "§6: mono");
  assert(hasFlag(args, "-c:a", "libopus"), "§6: Opus");
  assert(hasFlag(args, "-b:a", "48k"), "§6: 48–64 kbps");
  assert(args.includes("-vn"), "no video stream rides along in an audio derivative");
  assert(hasFlag(args, "-map_metadata", "-1"), "and no metadata — a voice file carries plenty");
});

Deno.test("the waveform card is one frame, and maps nothing by hand", () => {
  const args = waveformArgs("/in.m4a", "/thumb.webp");
  assert(args[args.indexOf("-filter_complex") + 1].startsWith("showwavespic="), "a waveform");
  assert(hasFlag(args, "-frames:v", "1"), "one frame");
  // Found by running it: a filtergraph declares its own inputs and outputs, and an explicit
  // -map alongside makes ffmpeg refuse the whole invocation. Every other command in this
  // file maps deliberately, which is exactly why this exception needs pinning.
  assert(!args.includes("-map"), "a filtergraph does its own mapping");
  assert(hasFlag(args, "-map_metadata", "-1"), "but metadata is still stripped");
});

// Some demuxers will follow a reference out of the file they were handed. The sniffer keeps
// playlists away from ffmpeg entirely; this is the wall behind that one.
Deno.test("every ffmpeg invocation restricts protocols to local files", () => {
  const rung = VIDEO_LADDER[0];
  const invocations = [
    videoArgs("/i", "/o", rung),
    posterArgs("/i", "/o", 1),
    imageArgs("/i", "/o"),
    thumbArgs("/i", "/o"),
    audioArgs("/i", "/o"),
    waveformArgs("/i", "/o"),
  ];
  for (const args of invocations) {
    assert(hasFlag(args, "-protocol_whitelist", "file"), `missing protocol guard: ${args[3]}`);
    assert(args.includes("-nostdin"), "and never blocks waiting on stdin");
  }
});

// ── ffprobe output ───────────────────────────────────────────

Deno.test("probe output is read without trusting any field to be present", () => {
  const full = parseProbe(JSON.stringify({
    format: { duration: "12.5" },
    streams: [{ codec_type: "video", width: 3840, height: 2160 }, { codec_type: "audio" }],
  }));
  assertEquals(full.durationS, 12.5, "duration");
  assertEquals(full.height, 2160, "height");
  assertEquals(full.hasVideo, true, "video present");
  assertEquals(full.hasAudio, true, "audio present");

  const audioOnly = parseProbe(JSON.stringify({
    format: { duration: "61" },
    streams: [{ codec_type: "audio" }],
  }));
  assertEquals(audioOnly.hasVideo, false, "a voice note has no video stream");
  assertEquals(audioOnly.height, null, "and no height to read");
});

Deno.test("unparseable or empty probe output is null, never a default", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ streams: [] })]) {
    const p = parseProbe(bad);
    assertEquals(p.durationS, null, `${bad || "(empty)"}: no duration invented`);
    assertEquals(p.height, null, "no height invented");
    assertEquals(p.hasVideo, false, "and no stream claimed");
  }
});

Deno.test("a zero or negative duration is treated as absent", () => {
  const p = parseProbe(JSON.stringify({ format: { duration: "0" }, streams: [] }));
  assertEquals(p.durationS, null, "0 seconds is not a duration, it is a missing one");
});

Deno.test("probeArgs asks for json and nothing on stderr", () => {
  const args = probeArgs("/in.mp4");
  assert(hasFlag(args, "-of", "json"), "machine-readable");
  assert(hasFlag(args, "-v", "error"), "so stdout is pure JSON");
});
