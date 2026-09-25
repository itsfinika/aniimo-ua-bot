#!/usr/bin/env bash
# Remote rollout for the Aniimo UA submission bot. Streamed to the server
# over SSH by .github/workflows/deploy.yml and executed with `bash -s` — it is
# never stored on the server.
#
# All inputs arrive as environment variables, prepended to this script as
# shell-quoted `export` lines on stdin (so nothing sensitive touches argv/ps):
#   Required: BOT_IMAGE, REGISTRY_USER, REGISTRY_TOKEN, DEPLOY_DIR
#   Bot config (any non-empty value is written to .env.prod): the required
#     BOT_TOKEN / ADMIN_CHAT_ID / PUBLISH_CHAT_ID / ADMIN_USER_IDS / GEMINI_API_KEY
#     plus every optional setting the app reads — core (GEMINI_MODEL,
#     OFFICIAL_NEWS_URL, OFFICIAL_NEWS_API_URL, OFFICIAL_NEWS_REGION,
#     NEWS_CHECK_INTERVAL_MINUTES, ARTICLE_TIMEZONE, SUBMISSION_COOLDOWN_SECONDS,
#     MIN_SUBMISSION_TEXT_*, MODERATION_SEND_INTERVAL_SECONDS), cross-source
#     dedup, the Telegram + Discord moderation blocks, the nightly backup block,
#     the weekly report, and every news source (Steam / Bluesky / YouTube / Reddit /
#     Aniimo Tools / the "Аніімо тижня" wiki rubric / fan-art digest). See
#     .env.example for the full list + defaults.
#
# Keys we are NOT given are left untouched in .env.prod, so you may also manage
# .env.prod by hand on the box. .env.prod is kept mode 0600. The bot has no HTTP
# endpoint, so instead of an HTTP health check we confirm the container reaches
# a STABLE running state — it must stay `running` with no new restarts for a
# settle window that comfortably exceeds startup, catching slow crash-loops
# (e.g. a bad token that only fails after warm-up), not just instant exits.
set -euo pipefail
umask 077  # files we create (.env.prod) must not be world-readable

: "${BOT_IMAGE:?BOT_IMAGE is required}"
: "${REGISTRY_USER:?REGISTRY_USER is required}"
: "${REGISTRY_TOKEN:?REGISTRY_TOKEN is required}"
: "${DEPLOY_DIR:?DEPLOY_DIR is required}"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"
SERVICE="bot"
SETTLE_SECONDS=40
POLL_INTERVAL=2

cd "$DEPLOY_DIR"

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# --- Runtime config -------------------------------------------------------
# Upsert KEY=VALUE into .env.prod for each non-empty value; preserve keys we
# were not given. BOT_IMAGE is recorded too so manual `docker compose` commands
# work without re-exporting it.
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Write a value for the docker-compose dotenv parser (NOT a shell). Single-
# quoting makes the value fully literal, so spaces, '#', '$' and backslashes are
# taken verbatim. compose's single-quoted form has no escape for an embedded
# single quote or newline, so refuse those rather than silently corrupt the
# file (none of the bot's tokens/ids/urls contain them).
upsert() {
  local key="$1" val="${2-}"
  [ -n "$val" ] || return 0
  case "$val" in
    *$'\n'*) echo "Refusing to write $key: value contains a newline." >&2; exit 1 ;;
    *\'*)    echo "Refusing to write $key: value contains a single quote." >&2; exit 1 ;;
  esac
  local tmp="${ENV_FILE}.tmp"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf "%s='%s'\n" "$key" "$val" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"  # mv inherited the temp file's mode; re-assert 0600
}

upsert BOT_IMAGE "$BOT_IMAGE"
upsert BOT_TOKEN "${BOT_TOKEN-}"
upsert ADMIN_CHAT_ID "${ADMIN_CHAT_ID-}"
upsert PUBLISH_CHAT_ID "${PUBLISH_CHAT_ID-}"
upsert ADMIN_USER_IDS "${ADMIN_USER_IDS-}"
upsert SUBMISSION_COOLDOWN_SECONDS "${SUBMISSION_COOLDOWN_SECONDS-}"
upsert GEMINI_API_KEY "${GEMINI_API_KEY-}"
upsert GEMINI_MODEL "${GEMINI_MODEL-}"
upsert OFFICIAL_NEWS_URL "${OFFICIAL_NEWS_URL-}"
upsert OFFICIAL_NEWS_API_URL "${OFFICIAL_NEWS_API_URL-}"
upsert OFFICIAL_NEWS_REGION "${OFFICIAL_NEWS_REGION-}"
upsert NEWS_CHECK_INTERVAL_MINUTES "${NEWS_CHECK_INTERVAL_MINUTES-}"
upsert ARTICLE_TIMEZONE "${ARTICLE_TIMEZONE-}"
upsert ENABLE_TELEGRAM_MODERATION "${ENABLE_TELEGRAM_MODERATION-}"
upsert TELEGRAM_MODERATION_CHAT_IDS "${TELEGRAM_MODERATION_CHAT_IDS-}"
upsert TELEGRAM_MOD_LOG_CHAT_ID "${TELEGRAM_MOD_LOG_CHAT_ID-}"
upsert TELEGRAM_LINK_ALLOWLIST "${TELEGRAM_LINK_ALLOWLIST-}"
upsert TELEGRAM_WELCOME_DELETE_SECONDS "${TELEGRAM_WELCOME_DELETE_SECONDS-}"
upsert ENABLE_DATABASE_BACKUP "${ENABLE_DATABASE_BACKUP-}"
upsert DATABASE_BACKUP_HOUR "${DATABASE_BACKUP_HOUR-}"
upsert DATABASE_BACKUP_KEEP "${DATABASE_BACKUP_KEEP-}"
upsert MIN_SUBMISSION_TEXT_WORDS "${MIN_SUBMISSION_TEXT_WORDS-}"
upsert MIN_SUBMISSION_TEXT_CHARS "${MIN_SUBMISSION_TEXT_CHARS-}"
upsert MODERATION_SEND_INTERVAL_SECONDS "${MODERATION_SEND_INTERVAL_SECONDS-}"
upsert ENABLE_CROSS_SOURCE_DEDUP "${ENABLE_CROSS_SOURCE_DEDUP-}"
upsert CROSS_SOURCE_DEDUP_TITLE_LIMIT "${CROSS_SOURCE_DEDUP_TITLE_LIMIT-}"
upsert ENABLE_DISCORD_MODERATION "${ENABLE_DISCORD_MODERATION-}"
upsert DISCORD_BOT_TOKEN "${DISCORD_BOT_TOKEN-}"
upsert DISCORD_MOD_LOG_CHANNEL_ID "${DISCORD_MOD_LOG_CHANNEL_ID-}"
upsert DISCORD_ALLOWED_INVITES "${DISCORD_ALLOWED_INVITES-}"
upsert DISCORD_GUILD_ID "${DISCORD_GUILD_ID-}"
upsert DISCORD_WELCOME_CHANNEL_ID "${DISCORD_WELCOME_CHANNEL_ID-}"
upsert DISCORD_CHAT_CHANNEL_ID "${DISCORD_CHAT_CHANNEL_ID-}"
upsert DISCORD_LFT_CHANNEL_ID "${DISCORD_LFT_CHANNEL_ID-}"
upsert ENABLE_STEAM_SOURCE "${ENABLE_STEAM_SOURCE-}"
upsert STEAM_FEED_URL "${STEAM_FEED_URL-}"
upsert ENABLE_BLUESKY_SOURCE "${ENABLE_BLUESKY_SOURCE-}"
upsert BLUESKY_ACTOR "${BLUESKY_ACTOR-}"
upsert ENABLE_BLUESKY_VIDEO_DOWNLOAD "${ENABLE_BLUESKY_VIDEO_DOWNLOAD-}"
upsert BLUESKY_VIDEO_MAX_MB "${BLUESKY_VIDEO_MAX_MB-}"
upsert ENABLE_YOUTUBE_SOURCE "${ENABLE_YOUTUBE_SOURCE-}"
upsert YOUTUBE_CHANNEL_ID "${YOUTUBE_CHANNEL_ID-}"
upsert YOUTUBE_EXCLUDE_KEYWORDS "${YOUTUBE_EXCLUDE_KEYWORDS-}"
upsert ENABLE_YOUTUBE_VIDEO_DOWNLOAD "${ENABLE_YOUTUBE_VIDEO_DOWNLOAD-}"
upsert YOUTUBE_VIDEO_MAX_MB "${YOUTUBE_VIDEO_MAX_MB-}"
upsert ENABLE_YOUTUBE_PO_TOKEN "${ENABLE_YOUTUBE_PO_TOKEN-}"
upsert ENABLE_YTDLP_DOWNLOAD "${ENABLE_YTDLP_DOWNLOAD-}"
upsert YOUTUBE_COOKIE "${YOUTUBE_COOKIE-}"
upsert ENABLE_REDDIT_SOURCE "${ENABLE_REDDIT_SOURCE-}"
upsert ENABLE_REDDIT_WATCH "${ENABLE_REDDIT_WATCH-}"
upsert REDDIT_WATCH_SUBREDDIT "${REDDIT_WATCH_SUBREDDIT-}"
upsert REDDIT_WATCH_QUERIES "${REDDIT_WATCH_QUERIES-}"
upsert REDDIT_WATCH_TITLE_ONLY "${REDDIT_WATCH_TITLE_ONLY-}"
upsert REDDIT_SUBREDDIT "${REDDIT_SUBREDDIT-}"
upsert REDDIT_FLAIRS "${REDDIT_FLAIRS-}"
upsert REDDIT_EXCLUDE_KEYWORDS "${REDDIT_EXCLUDE_KEYWORDS-}"
upsert ENABLE_ANIIMOTOOLS_SOURCE "${ENABLE_ANIIMOTOOLS_SOURCE-}"
upsert ANIIMOTOOLS_FEED_URL "${ANIIMOTOOLS_FEED_URL-}"
upsert ENABLE_WIKI_ANIIMO "${ENABLE_WIKI_ANIIMO-}"
upsert WIKI_ANIIMO_API_URL "${WIKI_ANIIMO_API_URL-}"
upsert WIKI_ANIIMO_SITE_URL "${WIKI_ANIIMO_SITE_URL-}"
upsert WIKI_ANIIMO_WEEKDAY "${WIKI_ANIIMO_WEEKDAY-}"
upsert WIKI_ANIIMO_HOUR "${WIKI_ANIIMO_HOUR-}"
upsert ENABLE_FANART_DIGEST "${ENABLE_FANART_DIGEST-}"
upsert FANART_SUBREDDIT "${FANART_SUBREDDIT-}"
upsert FANART_FLAIR "${FANART_FLAIR-}"
upsert FANART_DIGEST_WEEKDAY "${FANART_DIGEST_WEEKDAY-}"
upsert FANART_DIGEST_HOUR "${FANART_DIGEST_HOUR-}"
upsert ENABLE_WEEKLY_REPORT "${ENABLE_WEEKLY_REPORT-}"
upsert WEEKLY_REPORT_WEEKDAY "${WEEKLY_REPORT_WEEKDAY-}"
upsert WEEKLY_REPORT_HOUR "${WEEKLY_REPORT_HOUR-}"
upsert FANART_DIGEST_COUNT "${FANART_DIGEST_COUNT-}"
upsert ENABLE_GUIDES_DIGEST "${ENABLE_GUIDES_DIGEST-}"
upsert GUIDES_SUBREDDIT "${GUIDES_SUBREDDIT-}"
upsert GUIDES_FLAIR "${GUIDES_FLAIR-}"
upsert GUIDES_DIGEST_WEEKDAY "${GUIDES_DIGEST_WEEKDAY-}"
upsert GUIDES_DIGEST_HOUR "${GUIDES_DIGEST_HOUR-}"
upsert GUIDES_DIGEST_COUNT "${GUIDES_DIGEST_COUNT-}"

# --- Pull & roll out ------------------------------------------------------
export BOT_IMAGE
echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$REGISTRY_USER" --password-stdin
# Always drop the GHCR credential on the way out, however we exit.
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
dc pull
dc up -d --remove-orphans

# --- Verify ---------------------------------------------------------------
cid="$(dc ps -q "$SERVICE" | tail -n1)"
if [ -z "$cid" ]; then
  echo "Deploy FAILED: service '$SERVICE' has no container after 'up'." >&2
  exit 1
fi

inspect() { docker inspect -f "$1" "$cid" 2>/dev/null; }
baseline="$(inspect '{{.RestartCount}}')" || baseline=0
status=""
restarts="$baseline"
stable=1
elapsed=0
# Poll the whole settle window; fail the moment it leaves `running` or restarts.
while [ "$elapsed" -lt "$SETTLE_SECONDS" ]; do
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
  status="$(inspect '{{.State.Status}}')" || status="unknown"
  restarts="$(inspect '{{.RestartCount}}')" || restarts="-1"
  if [ "$status" != "running" ] || [ "$restarts" != "$baseline" ]; then
    stable=0
    break
  fi
done

if [ "$stable" = 1 ]; then
  echo "Deploy OK: $SERVICE stable for ${SETTLE_SECONDS}s ($BOT_IMAGE), restarts=$baseline."
  docker image prune -f >/dev/null 2>&1 || true
else
  echo "Deploy FAILED: $SERVICE unstable (status=$status, restarts ${baseline}->${restarts}, crash-looping?). Recent logs:" >&2
  dc logs --tail 120 "$SERVICE" || true
  exit 1
fi
