# The liveness probe image. Built and pushed only when the question below needs re-asking —
# it is not part of the worker image. Same Deno major as worker/Dockerfile so the runtime
# behaviour of the unawaited background task is the one the real worker relies on.
FROM denoland/deno:2.1.4
WORKDIR /app
COPY server.ts .
RUN deno cache server.ts
EXPOSE 8080
CMD ["run", "--allow-net", "server.ts"]
