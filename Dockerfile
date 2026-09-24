# Container image for the Aniimo UA submission bot.
#
# A single long-polling process: no inbound ports, no web server. Runtime
# configuration comes from the environment (see .env.example). The SQLite
# database lives at DATABASE_PATH, which docker-compose.prod.yml points at the
# mounted /data volume so it survives container recreation.

FROM node:24-slim

# Predictable runtime: production install, no npm update nags.
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# yt-dlp + ffmpeg, the only non-Node runtime dependencies.
#
# They exist for ONE reason: YouTube serves most videos over SABR, where the
# separate video and audio tracks carry no fetchable URLs, and youtubei.js can
# negotiate only the combined 360p stream. yt-dlp speaks that protocol and
# reaches the real tracks; ffmpeg merges them (a stream copy, no re-encode).
# Measured on a 116-second clip: 640x360 before, 1280x720 after.
#
# The `yt-dlp_linux` release is a self-contained binary, so no Python is needed.
# It is pinned: YouTube changes often enough that an unpinned "latest" would make
# the image non-reproducible, and bumping this line is the update. If either
# binary is missing the bot still posts videos, just through the old path, so a
# failed pin degrades instead of breaking.
ARG YTDLP_VERSION=2026.08.19
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
       -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first so this layer is cached across code-only changes.
# `npm ci` also proves package-lock.json resolves. There is still no native build
# step: the database driver is the built-in node:sqlite.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code.
COPY . .

# Run as an unprivileged user with a writable data dir. Docker seeds a fresh
# named volume from this directory, so the volume inherits app's ownership and
# the bot can create the SQLite file there.
#
# The uid is pinned to 10001 and MUST NOT change: Docker only applies image
# ownership when it seeds an EMPTY named volume, so the existing `botdata`
# volume keeps whatever uid wrote it. Running as any other user (for instance
# the base image's `node`, uid 1000) leaves the process able to read
# /data/bot.db but not write it, and SQLite then fails every write with
# "attempt to write a readonly database".
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /data \
    && chown -R app:app /app /data
USER app

# Default DB location; compose mounts the persistent volume here.
ENV DATABASE_PATH=/data/bot.db

CMD ["node", "main.js"]
