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

# Install dependencies first so this layer is cached across code-only changes.
# `npm ci` also proves package-lock.json resolves. The image is pure Node: the
# database driver is the built-in node:sqlite and YouTube downloads go through
# youtubei.js, so there is no native build step, no toolchain and no extra
# runtime to install.
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
