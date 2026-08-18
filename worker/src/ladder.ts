// The delivery ladder of CLAUDE.md §6, and every ffmpeg command line derived from it.
//
// Everything in this file is a PURE FUNCTION. Nothing here opens a file, spawns a process
// or touches the network, which is deliberate: it is the part of the worker that a laptop
// can test exhaustively. Rung selection at 4K is arithmetic, so it is asserted at 2160
// without a 4K file anywhere near it; only the encode itself needs real pixels, and that
// is exercised once on a tiny generated clip locally and at full 4K in CI.
//
// ── What the argv assertions are actually protecting ─────────
//
// Three flags in here are load-bearing and none of them announces itself if it is dropped:
//
//   -map_metadata -1   the EXIF strip. §11 gate 2. Drop it and every photo in the archive
//                      publishes the GPS coordinates of a contributor's home, and nothing
//                      about the output looks wrong.
//   +faststart         moves the moov atom to the front. Drop it and video still plays —
//                      after the whole file downloads, which on a Ramallah mobile
//                      connection is indistinguishable from broken.
//   -map 0:v:0         take ONE video stream. A crafted container can declare dozens;
//                      without this, one upload becomes dozens of encodes on a machine
//                      billed by the second.
//
// So ladder.test.ts asserts on the argv rather than on the output file. An assertion that
// the WebP exists cannot tell you its metadata survived.

/** The rungs a media_assets row may name (migrations 0003 and 0029). */
export type Rendition = "1440p" | "1080p" | "720p" | "480p" | "audio";

export interface Rung {
  name: Rendition;
  /** Output height in pixels. Equals the ladder height except in the no-upscale case. */
  height: number;
  videoKbps: number;
}

// §6, verbatim: "1440p ~8 Mbps · 1080p ~5 Mbps · 720p ~2.5 Mbps · 480p ~1 Mbps".
//
// 2160p is absent and that is the rule, not an omission: §6 says 4K is not streamed. It
// exists in the media_rendition enum because a MASTER may be 4K, and a master is never a
// rendition. If a rung for it ever appears here, the archival original has become a
// delivery path and §6's preservation/delivery split is gone.
export const VIDEO_LADDER: readonly Rung[] = [
  { name: "1440p", height: 1440, videoKbps: 8000 },
  { name: "1080p", height: 1080, videoKbps: 5000 },
  { name: "720p", height: 720, videoKbps: 2500 },
  { name: "480p", height: 480, videoKbps: 1000 },
] as const;

/**
 * The absolute duration ceiling, in seconds.
 *
 * The same idiom as ABSOLUTE_MAX_BYTES in request-upload: rule out what no role could ever
 * permit, so the check needs no role lookup. §6 gives moderators 20 minutes and that is the
 * largest cap any role has.
 *
 * It is not redundant with the check request-upload already did. That one is against a
 * duration the CLIENT DECLARED, and the presigned URL binds bytes, not seconds — a 200 MB
 * three-hour file at a low bitrate passes every gate in front of this one. Without this,
 * that upload is unbounded transcode time on a per-second-billed instance.
 */
export const DURATION_CEILING_S = 20 * 60;

/** Long edge of a display image, and width of a thumbnail, in pixels. */
export const IMAGE_MAX_EDGE = 1920;
export const THUMB_WIDTH = 400;

/** Poster and thumb are pulled from here, or from the start if the clip is shorter. */
export const POSTER_AT_S = 1;

/**
 * Which rungs a source of this height gets.
 *
 * Two rules, and the second one is the one that is easy to get wrong:
 *
 *   1  never emit a rung above the source height — upscaling spends encode time and
 *      bandwidth manufacturing detail that is not in the file;
 *   2  a source below the bottom rung still gets exactly one rendition, encoded at its own
 *      height and LABELLED 480p. Returning nothing would mean a valid small video with no
 *      playable derivative at all, which reaches the moderation queue as an item with
 *      nothing to look at.
 */
export function videoRungs(sourceHeight: number): Rung[] {
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) return [];

  const rungs = VIDEO_LADDER.filter((r) => r.height <= sourceHeight);
  if (rungs.length > 0) return rungs.map((r) => ({ ...r }));

  // Below 480. Scale the bitrate down with the pixels rather than spending 1 Mbps on a
  // 240-line clip, with a floor so a very small source is not encoded into mush.
  const bottom = VIDEO_LADDER[VIDEO_LADDER.length - 1];
  return [{
    name: bottom.name,
    height: sourceHeight,
    videoKbps: Math.max(300, Math.round(bottom.videoKbps * (sourceHeight / bottom.height))),
  }];
}

// ── ffmpeg argv ──────────────────────────────────────────────
//
// `-protocol_whitelist file` is an input option and sits before -i on purpose. Some
// demuxers will happily follow a reference out of the file they were handed — into another
// path on disk, or over the network. The sniffer already refuses anything that is not a
// recognised binary media signature, so a playlist never reaches ffmpeg; this is the second
// wall behind that one, on the process that handles hostile bytes.
const INPUT_GUARD = ["-nostdin", "-protocol_whitelist", "file"] as const;

// -sn -dn drop subtitle and data streams. A data stream is arbitrary bytes that would ride
// into the derivative untouched, which is precisely what re-encoding exists to prevent.
const STRIP = ["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn"] as const;

export function videoArgs(input: string, output: string, rung: Rung): string[] {
  const kbps = rung.videoKbps;
  return [
    ...INPUT_GUARD,
    "-y",
    "-i",
    input,
    // Exactly one video stream and at most one audio stream. The `?` makes the audio
    // optional so a silent clip is transcoded rather than refused.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    ...STRIP,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    `scale=-2:${rung.height}:flags=lanczos`,
    "-b:v",
    `${kbps}k`,
    "-maxrate",
    `${Math.round(kbps * 1.5)}k`,
    "-bufsize",
    `${kbps * 2}k`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
  ];
}

/** A single frame, for the poster §6 requires on every video. */
export function posterArgs(input: string, output: string, atSeconds: number): string[] {
  return [
    ...INPUT_GUARD,
    "-y",
    // Before -i: ffmpeg seeks the container rather than decoding up to the timestamp,
    // which on a 4K master is the difference between a second and a minute.
    "-ss",
    String(atSeconds),
    "-i",
    input,
    "-map",
    "0:v:0",
    ...STRIP,
    "-frames:v",
    "1",
    "-vf",
    "scale=-2:720:flags=lanczos",
    "-c:v",
    "libwebp",
    "-quality",
    "82",
    output,
  ];
}

/**
 * The display copy of a still image.
 *
 * -frames:v 1 is not decoration. An animated WebP or a multi-page TIFF is one file with
 * many frames, and without this ffmpeg writes one output per frame — a 900-page TIFF is a
 * single upload that fills a bucket.
 */
export function imageArgs(input: string, output: string): string[] {
  return [
    ...INPUT_GUARD,
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    ...STRIP,
    "-frames:v",
    "1",
    // min() on both axes caps the long edge without ever enlarging a smaller original —
    // force_original_aspect_ratio=decrease alone would scale a 400px scan up to 1920.
    "-vf",
    `scale='min(iw,${IMAGE_MAX_EDGE})':'min(ih,${IMAGE_MAX_EDGE})':` +
    "force_original_aspect_ratio=decrease:flags=lanczos",
    "-c:v",
    "libwebp",
    "-quality",
    "82",
    output,
  ];
}

/** A grid thumbnail, from a still or from a poster frame already written. */
export function thumbArgs(input: string, output: string): string[] {
  return [
    ...INPUT_GUARD,
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    ...STRIP,
    "-frames:v",
    "1",
    "-vf",
    `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
    "-c:v",
    "libwebp",
    "-quality",
    "80",
    output,
  ];
}

/**
 * §6: "Audio: Opus/AAC mono 48–64 kbps", normalized.
 *
 * loudnorm is EBU R128. A community archive receives phone recordings, cassette rips and
 * studio interviews in the same week; without normalization the viewer reaches for the
 * volume control on every item, which for a voice-note archive is the whole experience.
 */
export function audioArgs(input: string, output: string): string[] {
  return [
    ...INPUT_GUARD,
    "-y",
    "-i",
    input,
    "-map",
    "0:a:0",
    ...STRIP,
    "-vn",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    output,
  ];
}

/**
 * A waveform card, so a voice note is not a blank tile in a grid built for photographs.
 *
 * Deliberately no `-map`. A filtergraph declares its own inputs and outputs, and adding an
 * explicit stream map alongside it makes ffmpeg refuse the invocation outright — the
 * filtergraph's video output and a manually mapped audio stream are two different answers
 * to "what is in this file". Every other command here maps explicitly; this one must not.
 */
export function waveformArgs(input: string, output: string): string[] {
  return [
    ...INPUT_GUARD,
    "-y",
    "-i",
    input,
    ...STRIP,
    "-filter_complex",
    "showwavespic=s=800x200:colors=0x9a9a9a",
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
    "-quality",
    "80",
    output,
  ];
}

export function probeArgs(input: string): string[] {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,width,height",
    "-of",
    "json",
    input,
  ];
}

export interface Probe {
  durationS: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * Reads ffprobe's JSON.
 *
 * Every field is optional in the output and this treats them that way. A container that
 * declares no duration is not a decode error — it is a file whose duration cannot be
 * checked against the ceiling, which the pipeline turns into a refusal rather than a pass.
 */
export function parseProbe(json: string): Probe {
  let doc: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  try {
    doc = JSON.parse(json);
  } catch {
    return { durationS: null, width: null, height: null, hasVideo: false, hasAudio: false };
  }

  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(doc.format?.duration);

  return {
    durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: typeof video?.width === "number" && video.width > 0 ? video.width : null,
    height: typeof video?.height === "number" && video.height > 0 ? video.height : null,
    hasVideo: video !== undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}
