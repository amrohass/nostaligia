# The media ingestion worker (CLAUDE.md §6).
#
# Build from the REPOSITORY ROOT, not from worker/:
#
#     docker build -f worker/Dockerfile -t rma-media-worker .
#
# because the worker imports two modules from supabase/functions/_shared/ and a build
# context rooted at worker/ cannot see them. That sharing is deliberate: the magic-byte
# sniffer and the R2 signer are each the single implementation of a §6 rule, and a copy of
# either inside this directory would be a second thing to keep in step with the first.
#
# ── Why Deno, on a Debian base, with ffmpeg from apt ─────────
#
# Deno because the sniffer is already TypeScript with its own test suite. A worker in
# another language needs a second sniffer, and §6's SVG rule would then live in two places
# that can disagree — on the one path in the system that handles hostile bytes.
#
# ffmpeg from Debian rather than a static build fetched at image-build time. The header of
# _shared/sigv4.ts makes the argument in full: this is the process that decodes
# attacker-supplied files, and `curl | tar` of somebody's binary is a supply-chain edge on
# exactly that path. A distribution package is signed, reproducible and patched.
#
# trixie rather than bookworm for one concrete reason: bookworm ships ffmpeg 5.1, whose HEIF
# support is thin, and a heritage archive collecting photographs from phones receives HEIC
# constantly. trixie's ffmpeg 7.x decodes it.

FROM denoland/deno:bin-2.1.4 AS denobin

FROM debian:trixie-slim

COPY --from=denobin /deno /usr/local/bin/deno

# ca-certificates is not optional: without it every HTTPS call to R2 and PostgREST fails
# certificate verification, and the failure looks like a network problem.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY worker/src ./worker/src
COPY supabase/functions/_shared ./supabase/functions/_shared

# Resolve and type-check the whole module graph at BUILD time. A broken import would
# otherwise surface on the first real upload, several minutes into a deploy, as a 500 with
# the row already moved to 'processing'.
#
# There is nothing to download: the worker has no third-party dependencies at all, only
# relative imports. This is a compile check wearing a cache's clothes.
ENV DENO_DIR=/app/.deno
RUN deno cache worker/src/main.ts && chmod -R a+rX /app

RUN useradd --system --create-home --uid 10001 worker
USER worker

ENV PORT=8080
EXPOSE 8080

# Permissions are scoped, and --allow-run most of all. This process decodes hostile input;
# a general exec capability would turn any decoder escape into arbitrary commands, whereas
# this one turns it into "may start ffmpeg", which it was going to do anyway.
#
# --allow-net is unscoped because both hosts it needs arrive as environment variables at
# deploy time, so there is no list to write here that would not have to be wrong.
ENTRYPOINT ["deno", "run", \
  "--allow-net", \
  "--allow-env", \
  "--allow-read=/app,/tmp", \
  "--allow-write=/tmp", \
  "--allow-run=ffmpeg,ffprobe", \
  "worker/src/main.ts"]
