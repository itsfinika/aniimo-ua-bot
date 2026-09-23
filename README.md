# Aniimo UA Submission Bot

Telegram bot for a Ukrainian Aniimo community. It gathers content from seven sources, turns each item into a Ukrainian draft with Gemini, and routes everything — collected news and manual user submissions alike — through one admin moderation queue. Nothing is ever published automatically: an admin approves, edits, or rejects each post before it reaches the public channel. The same bot also moderates the community's Telegram group chat, and can optionally run a Discord moderation bot in the same process.

Forked from `marvel-rivals-ua-bot` and re-pointed at Aniimo, the open-world creature-catching RPG by Pawprint Studio.

## What It Does

**Collects content from seven sources** (each item becomes a pending draft, never an automatic post):

- the official Aniimo news site (`aniimo.com/newslist`, read through its JSON API) — always on, the only source that cannot be switched off
- Steam, the app's own "Community Announcements" RSS — patch notes and notices, treated as official
- Bluesky — short announcements with images or native video; Aniimo has no official account, so this one is off until you point it at a handle
- YouTube, the official English channel — trailers and reveals, published with a playable video
- Reddit (`r/AniimoLeaks`) — leaks and datamines, explicitly framed as rumours
- aniimotools.dev — a fan-run tools site's article feed; third-party news, neither official nor a rumour
- the official Aniimo wiki (`wiki.aniimo.com`, read through its JSON backend) — one creature a week for the "Аніімо тижня" rubric

Every source except the official site is opt-in and off by default.

**Runs two weekly rubrics on their own schedules:**

- a fan-art digest — the week's top `r/Aniimo` art as one credited Telegram album
- the "Аніімо тижня" creature rubric — one creature from the official wiki, turned into a Ukrainian spotlight post with its picture and a link to its wiki page

**Accepts manual user submissions** — plain text, links, photos, videos, and documents with optional captions, and whole albums (a media group becomes one submission, not one per photo) — rate-limited per user and filtered for too-short throwaway messages.

**Moderates everything in one queue:**

- each submission is stored in SQLite as `pending`, `published`, or `rejected`
- the moderation chat shows the publishable post parts first, then a separate metadata/control message with `✅ Approve` / `✏️ Edit` / `❌ Reject`
- only user IDs listed in `ADMIN_USER_IDS` may act on the buttons
- admins can edit any part, add new parts, and cancel an active edit with `/cancel`
- `/fetch_news`, `/fanartdigest`, and `/aniimoweek` trigger a source or rubric on demand; `/redraft` re-drafts a source's newest item for testing; `/stats` reports what every source has been doing

**Avoids duplicates twice over:** every source tracks what it has already seen, and an optional Gemini check drops an item that retells a story another source already delivered.

**Handles media properly:** article cover photos, multi-image posts as Telegram albums (photo and video in the same group), and YouTube/Bluesky videos downloaded and re-uploaded so they play inline instead of appearing as a link.

**Moderates the community chat** on Telegram (anti-flood, invite/scam/bad-word filters, warnings with auto-mutes, reports, welcome messages) and optionally on Discord.

**Keeps itself running:** nightly SQLite backups on the server, and a GitHub Actions pipeline that builds a Docker image and rolls it out over SSH.

## What It Does Not Do Yet

Publication stays fully manual by design — the bot never posts without an admin pressing Approve. Beyond that, it does not implement:

- webhook mode (Telegram long polling only)
- role management inside Telegram (the news/submission queue is `ADMIN_USER_IDS`-only; a moderated group chat's own Telegram admins are treated as moderators there)
- video parsing for the official news site and Steam (those sources are photo-only; Bluesky and YouTube do carry video)

Each source is a `BaseNewsCollector` subclass registered in `services/collectors/registry.js`, so a new one reuses the whole moderation, dedup, and publishing flow.

## Before You Deploy: Placeholders To Replace

The repository ships with example values that are **not** yours. Set them before the first run:

- **Telegram and Discord ids in `.env`** — `ADMIN_CHAT_ID`, `PUBLISH_CHAT_ID`, `ADMIN_USER_IDS`, `TELEGRAM_MODERATION_CHAT_IDS`, and every `DISCORD_*_ID` in `.env.example` are made-up sample numbers. The sections below explain how to find the real ones.
- **Footer links in `locales/uk.json`** — `post_footer.links` points at `https://t.me/AniimoUAChat` and `https://t.me/AniimoUABot`. Replace them with your own community links; there is no environment variable for them. The `discord` entry ships with an empty `url` and is therefore left out of the footer — fill it in when the community server exists.
- **Reddit** — `r/Aniimo` was probed on 21 Sep 2026: its flairs are `News`, `Discussion`, `Question`, `Guide`, `Meme`, `Screenshot`, `Video` and `Media`; it has no fan-art and no leak/datamine flair. So the weekly album defaults to `FANART_FLAIR=Media` (the community's screenshots and catches), and the rumour source defaults to `REDDIT_SUBREDDIT=AniimoLeaks` — a subreddit that exists but was still empty at launch, so its flair defaults (`Leak,Datamine,Reliable,Confirmed`) are a guess to check once it has posts. A wrong flair does not error — the feed simply comes back empty.
- **Bluesky is off until you name an account** — `BLUESKY_ACTOR` defaults to empty because Aniimo has no official Bluesky account. `ENABLE_BLUESKY_SOURCE=true` has no effect until the actor is set; the registry keeps the source disabled and logs one warning.

## Project Structure

```text
main.js                      entrypoint: config, DB, composers, command menus, background tasks
config.js                    the frozen config object and loadConfig()
database.js                  node:sqlite layer (submissions, parts, seen_sources, tags, warnings)
keyboards.js                 inline keyboards and callback data
discord_moderation.js        optional, self-contained Discord moderation bot
handlers/
  user.js                    private-DM submission flow
  admin.js                   moderation queue, part editing, admin commands
  moderation.js              Telegram group-chat moderation composer
services/
  collectors/
    base.js                  lightweight collector types shared with the UI
    runner.js                BaseNewsCollector: the orchestration engine every source extends
    registry.js              source registry, enable gates, and the periodic tick
    throttle.js              minimum gap between moderation sends within one tick
    official_aniimo/         news_fetcher.js (JSON API), article_parser.js, collector.js
    steam/                   feed_fetcher.js (Steam announcements RSS), collector.js
    bluesky/                 feed_fetcher.js, video.js (getBlob MP4), collector.js
    youtube/                 feed_fetcher.js (channel Atom feed), collector.js
    reddit/                  feed_fetcher.js (flair search.rss), collector.js
    aniimotools/             feed_fetcher.js (aniimotools.dev RSS), collector.js
    wiki_aniimo/             client.js (wiki JSON backend), collector.js + weekly scheduler
  digests/
    fanart.js                weekly fan-art album digest
  background.js              cancellable scheduler tasks (the asyncio.Task analogue)
  chat_moderation.js         pure Telegram moderation rules (no Telegram I/O)
  date_utils.js              article date/timezone parsing, UTC+8 range conversion
  db_backup.js               nightly VACUUM INTO snapshots
  formatter.js               admin moderation preview
  gemini.js                  prompts, drafts, hashtags, cross-source dedup verdict
  html.js                    cheerio helpers with BeautifulSoup get_text semantics
  i18n.js                    JSON translation lookup
  logger.js                  the log-line format the deploy playbook greps for
  media_parser.js            article image extraction
  moderation.js              sending a submission into the moderation chat
  post_footer.js             community footer and per-source attribution lines
  publisher.js               publishing: text, photo, album, native video
  reports.js                 weekly activity report and /stats
  pyutils.js                 Python-semantics shims (strip, format, ISO timestamps, code-point slicing)
  source_links.js            allowlisted links kept from the original post text
  telegram_errors.js         grammY error classification
  telegram_html.js           re-render a message as HTML (the aiogram html_text analogue)
  telegram_retry.js          retries, timeouts, inter-message spacing
  urlutils.js                urlsplit/urljoin with urllib semantics
  xml.js                     feed parsing with DTDs and entities refused
  youtube_video.js           InnerTube download for native video re-upload
  youtube_po_token.js        BotGuard/PO token so a server IP may download at all
prompts/
  gemini_news_uk.md          long-form official article draft (site + Steam)
  gemini_shortform_uk.md     concise social/leak/third-party posts
  gemini_wiki_creature_uk.md "Аніімо тижня" creature spotlight
  gemini_dedup_uk.md         cross-source duplicate-title judge
  official_news_style.md     editable style guide injected into the news prompt
locales/
  uk.json                    every user-visible string, incl. the footer links
scripts/
  deploy-remote.sh           remote rollout streamed over SSH by the deploy workflow
  setup_lft_forum.js         one-off Discord LFT forum setup helper
  telegram_chat_ids.js       prints every chat the bot has seen, for the *_CHAT_ID variables
tests/                       vitest suite (one module per subsystem)
tests/fixtures/aniimo/       captured live responses of every Aniimo endpoint
.github/workflows/           ci.yml (install, import, vitest, eslint) and deploy.yml
Dockerfile                   node:24-slim image, unprivileged, no inbound ports
docker-compose.prod.yml      production composition with the botdata volume
telegram_rules.txt           editable chat rules shown in the welcome message
telegram_badwords.txt        editable blocked-word list for Telegram moderation
discord_rules.txt            editable Discord rules
discord_badwords.txt         editable blocked-word list for Discord moderation
package.json                 dependencies and the start / test / lint scripts
.env.example
```

## Create a Bot With BotFather

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Follow the prompts for bot name and username.
4. BotFather will return a token. Use it as `BOT_TOKEN`.

Keep the token private. Anyone with the token can control the bot.

## Get `BOT_TOKEN`

Use the token from BotFather:

```env
BOT_TOKEN=1234567890:your_real_token_here
```

## Get `ADMIN_CHAT_ID`

`ADMIN_CHAT_ID` is the private moderation chat where submissions and buttons are sent.

A private group or supergroup is recommended. A Telegram channel can be used for moderation previews and buttons, but channel posts do not expose the real admin user ID to the bot.

In channel-based moderation, the admin user ID is checked when inline buttons are clicked. Existing parts are edited through copied draft posts with `💾 Зберегти`; new parts are added by clicking `➕ Нова частина` and sending the next text, photo, video, or document post in the admin channel.

Telegram can show modal alerts only after inline button clicks, not after ordinary text messages. After a new part is received, the confirmation is the metadata/control message moving back to the bottom.

Recommended method — once `BOT_TOKEN` is in `.env`:

1. Add your bot to the admin group (for a channel: as an administrator with "Post messages").
2. Run the helper; it lists every chat the bot has seen in the last 24 hours with its id, type and title:

```bash
node scripts/telegram_chat_ids.js
```

It reads the pending updates without confirming them, so nothing is lost for the bot itself — but do not run it while the bot is already deployed and polling (Telegram answers 409 to both callers).

Manual alternative: send any message in the group, open this URL in a browser, replacing the token, and find the group `chat.id`:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

Group and supergroup IDs are usually negative, often starting with `-100`.

Example:

```env
ADMIN_CHAT_ID=-1001234567890
```

## Get `PUBLISH_CHAT_ID`

`PUBLISH_CHAT_ID` is the public channel or group where approved submissions are published.

For a group: add the bot to the group. For a channel: add the bot as an admin of the channel with permission to post messages. Then run `node scripts/telegram_chat_ids.js` (or use `getUpdates` as above) and copy the `chat.id`. The same two ids also serve `TELEGRAM_MODERATION_CHAT_IDS` and `TELEGRAM_MOD_LOG_CHAT_ID` if chat moderation is enabled.

Example:

```env
PUBLISH_CHAT_ID=-1009876543210
```

## Get `ADMIN_USER_IDS`

`ADMIN_USER_IDS` controls who may approve, reject, or edit submissions. The bot checks the Telegram user ID of the person clicking the inline button, even inside the private admin chat.

Ways to find a user ID:

- Message `@userinfobot` or a similar Telegram ID helper bot.
- Send a private message to your bot, then run `node scripts/telegram_chat_ids.js` — it lists the senders under "Users who wrote to the bot".
- Or inspect `from.id` by hand in:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

Multiple admins are comma-separated:

```env
ADMIN_USER_IDS=111111111,222222222,333333333
```

## Install Dependencies

Use Node.js 24 or newer (the database layer uses the built-in `node:sqlite` module).

```bash
cd aniimo-ua-bot
npm install
```

That is the whole toolchain. There is no native build step (the database is
Node's built-in `node:sqlite`) and no external executable to install — native
YouTube video re-upload runs on `youtubei.js`, a JavaScript client for
YouTube's private InnerTube API, with `bgutils-js` and `jsdom` for the
Proof-of-Origin token a server IP needs.

## Create `.env`

Copy `.env.example` to `.env` and fill in real values. `.env.example` lists every variable the bot reads; the groups below explain what each one does.

Only four variables are required. A missing or unparseable one raises a configuration error and the bot exits:

```env
BOT_TOKEN=1234567890:your_real_token_here
ADMIN_CHAT_ID=-1001234567890
PUBLISH_CHAT_ID=-1009876543210
ADMIN_USER_IDS=111111111,222222222
```

### Core settings

```env
DATABASE_PATH=bot.db
SUBMISSION_COOLDOWN_SECONDS=120
MIN_SUBMISSION_TEXT_WORDS=3
MIN_SUBMISSION_TEXT_CHARS=10
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.7-flash
OFFICIAL_NEWS_URL=https://www.aniimo.com/newslist
OFFICIAL_NEWS_API_URL=https://worldx-office-api.aniimo.com
OFFICIAL_NEWS_REGION=en
NEWS_CHECK_INTERVAL_MINUTES=5
ARTICLE_TIMEZONE=Europe/Kyiv
```

- `DATABASE_PATH` — SQLite file path. Omitted, it creates `bot.db` in the project directory. **In production this value is ignored:** the image and `docker-compose.prod.yml` pin it to `/data/bot.db` on the persistent volume, and the deploy workflow deliberately does not forward it.
- `SUBMISSION_COOLDOWN_SECONDS` — per-user minimum gap between submissions, default `120`. `0` disables it, and `ADMIN_USER_IDS` always bypass it.
- `MIN_SUBMISSION_TEXT_WORDS` / `MIN_SUBMISSION_TEXT_CHARS` — a plain-text submission shorter than either limit is bounced with a hint instead of reaching the queue. Defaults `3` and `10`; `0` disables that half of the check. Links, media, and admins are exempt.
- `GEMINI_API_KEY` — enables every AI feature: drafts for all sources, the cross-source duplicate check, and the "Аніімо тижня" rubric. Create a key at `https://aistudio.google.com/app/apikey`. Without it the bot still starts and manual submissions still work, but the periodic collector scheduler never starts, a manual `/fetch_news` run stops before drafting with a Ukrainian warning, and the creature rubric refuses to run.
- `GEMINI_MODEL` — default `gemini-3.7-flash`, chosen by running the same real article through several models: 2.5-flash ran into the length cap and was cut mid-sentence, losing a fix entirely, while 3.7 fit the whole patch note into fewer characters with cleaner structure. The model in use is named in the startup log, since a deployment can override it — and note that `.env.prod` keeps whatever the deploy last gave it, so a model pinned there wins over this default until the secret is changed.
- `OFFICIAL_NEWS_URL` — the human-facing news page, default `https://www.aniimo.com/newslist`. It is what a published post links to (`<OFFICIAL_NEWS_URL>/detail/<id>`); the listing itself is not scraped from it.
- `OFFICIAL_NEWS_API_URL` — the JSON API behind that page, default `https://worldx-office-api.aniimo.com`. The collector reads `GET /api/information/list` for the listing and `GET /api/information/new?id=<id>` for the article body.
- `OFFICIAL_NEWS_REGION` — the `Region` header (and `region` query parameter) the API is asked for, default `en`.
- `NEWS_CHECK_INTERVAL_MINUTES` — the periodic collector tick, default `5`. Empty, non-numeric, `0`, or negative disables scheduled checks. It also requires `GEMINI_API_KEY`. A tick over every source costs about two seconds when nothing is new, so this setting is about how stale a post may be rather than about load — at 30 minutes a big announcement could sit undetected for half an hour.
- `ARTICLE_TIMEZONE` — default `Europe/Kyiv`. It converts article dates **and** is the local timezone every schedule below is evaluated in: the backup hour, the creature rubric, the fan-art digest, and the weekly report.

Note that `SUBMISSION_COOLDOWN_SECONDS`, `MIN_SUBMISSION_TEXT_WORDS`, and `MIN_SUBMISSION_TEXT_CHARS` are the only numeric settings that are strict — a negative or non-integer value stops startup. Every other number below is parsed leniently and silently falls back to its default, so a typo can never take the bot down.

Boolean flags accept `true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off`, case-insensitively. **Any other value keeps the default** rather than being read as false.

### Operations

```env
ENABLE_DATABASE_BACKUP=true
DATABASE_BACKUP_HOUR=4
DATABASE_BACKUP_KEEP=14
ENABLE_CROSS_SOURCE_DEDUP=true
CROSS_SOURCE_DEDUP_TITLE_LIMIT=200
MODERATION_SEND_INTERVAL_SECONDS=5
ENABLE_WEEKLY_REPORT=true
WEEKLY_REPORT_WEEKDAY=0
WEEKLY_REPORT_HOUR=11
```

- `ENABLE_DATABASE_BACKUP` — **on by default.** Once a night the bot writes a `VACUUM INTO` snapshot to a `backups/` folder next to the database and prunes old ones. On the server that is `/data/backups` on the `botdata` volume.
- `DATABASE_BACKUP_HOUR` — local hour of the snapshot, default `4`.
- `DATABASE_BACKUP_KEEP` — how many snapshots to keep, default `14`. `0` is coerced back to `14`; you cannot keep none.
- `ENABLE_CROSS_SOURCE_DEDUP` — **on by default.** Before queueing an item, Gemini compares its title against recently seen titles from *other* sources and drops a retelling of a story already delivered. It fails open: any error keeps the item.
- `CROSS_SOURCE_DEDUP_TITLE_LIMIT` — how many recent titles are compared, default `200`. `0` disables the check.
- `MODERATION_SEND_INTERVAL_SECONDS` — minimum gap between moderation sends inside one tick, shared across all sources, default `5`. `0` disables the pacing. A manual `/fetch_news` run is never delayed.
- `ENABLE_WEEKLY_REPORT` / `WEEKLY_REPORT_WEEKDAY` / `WEEKLY_REPORT_HOUR` — the weekly per-source activity report to the admin chat, **on by default**, Monday (`0`) at `11`:00. See [Knowing what the sources actually do](#knowing-what-the-sources-actually-do).

### News sources

Every source here is off by default. The official site needs no flag and cannot be disabled.

```env
ENABLE_STEAM_SOURCE=false
STEAM_FEED_URL=https://store.steampowered.com/feeds/news/app/4126040/

ENABLE_BLUESKY_SOURCE=false
BLUESKY_ACTOR=
ENABLE_BLUESKY_VIDEO_DOWNLOAD=true
BLUESKY_VIDEO_MAX_MB=48

ENABLE_YOUTUBE_SOURCE=false
YOUTUBE_CHANNEL_ID=UC2YdJw53sP73T-lffzrqTZA
YOUTUBE_EXCLUDE_KEYWORDS=
ENABLE_YOUTUBE_VIDEO_DOWNLOAD=true
YOUTUBE_VIDEO_MAX_MB=48
ENABLE_YOUTUBE_PO_TOKEN=true
YOUTUBE_COOKIE=

ENABLE_REDDIT_SOURCE=false
REDDIT_SUBREDDIT=AniimoLeaks
REDDIT_FLAIRS=
REDDIT_EXCLUDE_KEYWORDS=

ENABLE_ANIIMOTOOLS_SOURCE=false
ANIIMOTOOLS_FEED_URL=https://aniimotools.dev/articles/rss.xml

ENABLE_WIKI_ANIIMO=false
WIKI_ANIIMO_API_URL=https://wiki-backend.aniimo.com
WIKI_ANIIMO_SITE_URL=https://wiki.aniimo.com/en
WIKI_ANIIMO_WEEKDAY=0
WIKI_ANIIMO_HOUR=12

ENABLE_FANART_DIGEST=false
FANART_SUBREDDIT=Aniimo
FANART_FLAIR=Media
FANART_DIGEST_WEEKDAY=4
FANART_DIGEST_HOUR=18
FANART_DIGEST_COUNT=10
```

- `ENABLE_STEAM_SOURCE` / `STEAM_FEED_URL` — Steam's "Community Announcements" RSS for the Aniimo app (`4126040`). Every item in that feed is the developers' own post, so it is handled as an official source: full news prompt, `#Офіційно`, and a `Повні деталі — на сторінці у Steam.` line linking the announcement.
- `BLUESKY_ACTOR` — the handle whose public feed is polled. **Default empty**, because Aniimo has no official Bluesky account; with the actor empty the source stays off even when `ENABLE_BLUESKY_SOURCE=true` (one warning is logged).
- `ENABLE_BLUESKY_VIDEO_DOWNLOAD` (**on by default**) — resolves a video post to its original MP4 and re-uploads it as a native Telegram video. Off, or above `BLUESKY_VIDEO_MAX_MB` (default `48`), the post degrades to text.
- `YOUTUBE_CHANNEL_ID` — default `UC2YdJw53sP73T-lffzrqTZA`, the official English channel @Aniimo_EN. The Japanese channel is a separate upload stream and is deliberately not used.
- `YOUTUBE_EXCLUDE_KEYWORDS` — a comma-separated title blocklist, matched case-insensitively as substrings. The built-in default list is **empty** (the channel has no esports-VOD stream to filter out), so nothing is skipped until you set one; `-` or `none` disables filtering explicitly. The mechanism stays for when it is needed.
- `ENABLE_YOUTUBE_VIDEO_DOWNLOAD` (**on by default**) — downloads the video and re-uploads it natively, up to `YOUTUBE_VIDEO_MAX_MB` (default `48`). Off, too large, or refused by YouTube, the post falls back to a large playable link preview.
- `ENABLE_YOUTUBE_PO_TOKEN` (**on by default**) — mints a Proof-of-Origin token for the InnerTube session. From a datacenter IP YouTube answers a plain download with "Video is login required" on every client, while the same video downloads fine from a home connection; the token is what the real web player sends to prove the request is genuine, and it reopens the `WEB`/`MWEB` download path on a server. Minting it costs one BotGuard run per session.
- `YOUTUBE_COOKIE` — last resort for an IP YouTube blocks even with a token: the `Cookie` header of a **throwaway** Google account. Empty (the default) means anonymous. It is a full credential, so never use a personal account.
- `REDDIT_SUBREDDIT` — without the `r/` prefix, default `AniimoLeaks` (the general `r/Aniimo` has no leak flair and its news posts are reposts of official announcements).
- `REDDIT_FLAIRS` — comma-separated flairs combined with `OR` into one search query. Empty keeps the default `Leak,Datamine,Reliable,Confirmed`, a guess for the still-empty `r/AniimoLeaks`: see [Before You Deploy](#before-you-deploy-placeholders-to-replace).
- `REDDIT_EXCLUDE_KEYWORDS` — title blocklist, default `megathread` (recurring sticky threads). `-` or `none` disables it.
- `ENABLE_ANIIMOTOOLS_SOURCE` / `ANIIMOTOOLS_FEED_URL` — the aniimotools.dev article RSS, default `https://aniimotools.dev/articles/rss.xml`. A fan-run site, so its posts get the short-form prompt with neither `#Офіційно` nor `#Чутки`.
- `ENABLE_WIKI_ANIIMO` / `WIKI_ANIIMO_API_URL` / `WIKI_ANIIMO_SITE_URL` — the "Аніімо тижня" rubric: the wiki's JSON backend (default `https://wiki-backend.aniimo.com`) supplies the roster and the creature pages, and the public site (default `https://wiki.aniimo.com/en`) is what the post links to (`<WIKI_ANIIMO_SITE_URL>/item/<entryId>`). The rubric also needs `GEMINI_API_KEY`.
- `WIKI_ANIIMO_WEEKDAY` / `WIKI_ANIIMO_HOUR` — when the rubric runs, default Monday (`0`) at `12`:00. Weekdays are `0`=Monday … `6`=Sunday.
- `ENABLE_FANART_DIGEST` — switches the weekly fan-art digest on; it is a rubric with its own schedule, not a per-tick source.
- `FANART_SUBREDDIT` / `FANART_FLAIR` — default `Aniimo` and `Media`: `r/Aniimo` has no fan-art flair, and `Media` is where the screenshots and catches go, so the album is a "best shots of the week" round-up (`📸 Найкращі кадри тижня`).
- `FANART_DIGEST_WEEKDAY` / `FANART_DIGEST_HOUR` — when the digest runs, default Friday (`4`) at `18`:00.
- `FANART_DIGEST_COUNT` — images per album, default `10`, hard-capped at Telegram's media-group maximum of 10.

The community navigation footer is always appended to every published post. Its labels and URLs both live in `locales/uk.json` under `post_footer.links` — there is no environment variable for it. See [Content Sources](#content-sources) for details.

## Run Locally

```bash
npm start
```

On startup the bot validates required environment variables, initializes SQLite tables, and starts polling Telegram.

## Test the Full Flow

1. Start the bot locally.
2. Open the bot in Telegram and send `/start`.
3. Send a text post or link.
4. Confirm the bot replies:

```text
Дякуємо! Твою новину відправлено на модерацію.
```

5. Check the admin chat for the original post content first, then a metadata message with buttons.
6. Click `✏️ Edit` from an allowed admin account.
7. Choose the part to edit, update the copied draft post, then click `💾 Зберегти`.
8. Confirm the original post message above is updated and the metadata message still has approve/edit/reject buttons.
9. Click `✅ Approve`.
10. Confirm the post appears in `PUBLISH_CHAT_ID`.
11. Send another submission and click `❌ Reject`.
12. Confirm it is not published and the admin preview status changes to `rejected`.
13. Try clicking a button from a Telegram user ID not listed in `ADMIN_USER_IDS`. The bot should show an alert and do nothing.
14. Send two submissions from the same user within `SUBMISSION_COOLDOWN_SECONDS`. The second one should be rejected with a wait message.

## Content Sources

Seven sources are registered in `services/collectors/registry.js`. Each is a `BaseNewsCollector` subclass, so they all share the same pipeline: fetch a listing, skip what has already been seen, ask Gemini for a Ukrainian draft, and queue it for moderation.

| Source | Enabled by | What it brings | Media |
| --- | --- | --- | --- |
| Official site | always on | update notices, events, announcements | cover photo, album of the article's images |
| Steam | `ENABLE_STEAM_SOURCE` | the same official announcements, patch notes | cover photo, album of the post's images |
| Bluesky | `ENABLE_BLUESKY_SOURCE` + `BLUESKY_ACTOR` | short announcements from whatever account you name | photos, album, native video |
| YouTube | `ENABLE_YOUTUBE_SOURCE` | trailers and reveals | native video, else playable preview |
| Reddit | `ENABLE_REDDIT_SOURCE` | leaks and datamines, framed as rumours | photo |
| Aniimo Tools | `ENABLE_ANIIMOTOOLS_SOURCE` | third-party guides and news | photo, album of the article's images |
| Wiki Aniimo | `ENABLE_WIKI_ANIIMO` | weekly "Аніімо тижня" creature spotlight | the creature's picture |

Reddit is the only rumour-framed source: Gemini is explicitly told to present the item as an unofficial leak that developers have not confirmed, so a datamine never reads like an announcement. Aniimo Tools is deliberately *not* framed that way — it is a fan site publishing guides and news, not leaks — but it is not official either, so its posts get the short-form prompt without `#Офіційно` and without an attribution line.

### The official site

The site has no HTML feed; the news page is rendered from a JSON API, and the collector talks to that API directly. With `OFFICIAL_NEWS_API_URL` as the base and `Region: <OFFICIAL_NEWS_REGION>` on every request, it reads the listing from `GET /api/information/list?pageNum=1&pageSize=20&hasPublish=1&type=latest&hasContent=false&region=en`. A response whose `code` is not `200`, or whose `data.list` is not an array, is treated as an empty listing with a logged warning rather than an error. Each entry carries an `id`, an `informationType` (`new` or `announcement`), a `mainPic` cover, a `title` that may contain a line break (collapsed to one space), a `describe` excerpt, and `publishTime` / `showTime` / `createTime`.

Two things about that listing shape the collector. First, **every timestamp is UTC+8** — the server lives in Asia/Shanghai, and a post scheduled for "00:00 (UTC+8)" carries a `publishTime` of `00:00:12` — so the date is parsed as Asia/Shanghai and converted to `ARTICLE_TIMEZONE` like any other source's date. Second, `is_top` pins an item at the head of the list regardless of date, so the collector re-sorts by `publishTime` and keys `seen_sources` on the canonical public URL `<OFFICIAL_NEWS_URL>/detail/<id>`, which is also the `source_url` a published post links to — never the API URL.

For the body it fetches `GET /api/information/new?id=<id>`, whose `content` is an HTML string. Headings, paragraphs and list items become lines (deduplicated, capped at 12,000 characters), inline style noise is stripped, and the fullwidth parentheses the site writes around `（UTC+8）` are normalised to ASCII so the time converter recognises them. `mainPic` is the cover photo; further `<img>` sources on `aniimo.com` hosts are collected for an album (up to 10). The article type is recorded in the admin-only original text as `Тип: новина` or `Тип: оголошення`. If the detail request fails, the draft is built from the listing's title, excerpt and cover instead, so an API hiccup delays a post's detail rather than losing the post.

### Steam

`STEAM_FEED_URL` is the app's "Community Announcements" RSS 2.0 feed. Each `<item>` has a title, a link to `store.steampowered.com/news/app/4126040/view/<id>`, an RFC-822 `pubDate` in UTC, a `guid`, and a `description` holding the announcement as HTML (`bb_paragraph`, `bb_img`). The feed is parsed with the same DTD-refusing XML parser as the other feeds; the body is the text of its paragraphs, headings and list items, capped at 12,000 characters, with the same fullwidth-parenthesis normalisation as the site (Steam carries the site's text verbatim). Images are accepted only from `steamstatic.com`, `steamusercontent.com` and `akamaihd.net` hosts, up to 10, as cover plus album. The dedup key is the `guid`. Because every item is the developers' own post, `steam` sits in the official set alongside the site — full news prompt, `#Офіційно`, and the Steam attribution line. The site runs first in the registry, so when both carry the same announcement the cross-source check drops the Steam copy.

### Aniimo Tools

`ANIIMOTOOLS_FEED_URL` is a plain RSS 2.0 feed of `aniimotools.dev/articles/<slug>/` pages: `title`, `link`, `guid`, `pubDate`, `description`, and sometimes `content:encoded`. The body is the encoded content when present, else the description. Images are taken only from `aniimotools.dev` hosts, up to 10, as cover plus album — and any image that appears in more than one item of the same fetch is dropped as site boilerplate, since an article's own image belongs to exactly one article. The dedup key is the `guid`, falling back to the link.

### The wiki

The "Аніімо тижня" rubric reads the official wiki through its JSON backend at `WIKI_ANIIMO_API_URL`. Requests are `POST` with a JSON body and an `X-Lang: en-US` header (the backend rejects any other language). `POST /entries/getBaseAll` returns the whole roster — 86 creatures at the time of writing — each with an `entryId`, name, image, one-line description, element(s) and role(s); only visible entries of type `ANIIMO` are kept. `POST /entries/detailByAnchor` with `{ entryId, currentMorphology }` returns the page as a tree of typed components, from which the collector pulls the fact-sheet block (number, description, elements, roles, gender), habitats, the evolution line (for example `Emberpup → Flameruff → Scorchhowl / Inferlupa`), the trait and the mobility text. Elements and roles are mapped to Ukrainian (`fire` → Вогонь, `dps` → DPS, `sup` → Підтримка, and so on); anything unknown is shown capitalised in English. The post links to `<WIKI_ANIIMO_SITE_URL>/item/<entryId>`.

The generated public draft includes only publishable post content and hashtags. Publication date, source type, article title, status, and raw `source_url` are admin-only metadata — the moderation card names the source and carries its URL, and the post itself does not repeat them. Public posts do not show raw source URLs, and carry no `Джерело: <name>` line: it is stripped both when the draft is generated and again when a post is rendered, so drafts queued before that rule — and any line the model adds despite the prompt — never reach the channel. Three sources end with a call-to-action line instead, whose highlighted words link to the stored `source_url`: the official site's `Повні деталі — на офіційному сайті.`, Steam's `Повні деталі — на сторінці у Steam.`, and the wiki's `Більше про цю істоту — в офіційній вікі.`. Every other source ends with its hashtags. A user's own submission is never touched, whatever it says.

### Links inside a post

Every URL is stripped out of a generated draft, because a URL a model wrote is not one worth publishing. That also used to discard the links a post existed to share — a playlist, an event page, a stream.

Those are now re-attached from the **original** post text, never from the draft, and only when all three of these hold:

- the source is trusted enough to carry links — currently Bluesky only. The official site and Steam are already reachable through their attribution links, YouTube descriptions are mostly boilerplate, and Reddit is user-submitted leak content, which is where an unvetted link is likeliest to be hostile.
- the destination is on a small allowlist of official and known platforms (aniimo.com and its subdomains, pawprintstudio.com, YouTube, Twitch, Spotify, Discord, Steam, the Epic Games Store, the App Store and Google Play).
- a link shortener is resolved one hop first, so a hidden destination is judged on where it actually goes. The bot reads the redirect header only and never fetches the linked page. An `http` destination on an allowlisted host is upgraded to `https` rather than dropped, since shorteners commonly hand one back.

At most two links survive per post, appended as `🔗 <platform>: <url>` lines. Telegram makes them clickable on its own, and previews stay disabled, so no preview card appears. Anything that fails a gate is dropped exactly as before.

Nothing is auto-published. Each generated item is inserted into `submissions` with `status = "pending"` and sent to the same admin moderation queue as manual submissions, with the same `✅ Approve`, `✏️ Edit`, and `❌ Reject` buttons. When a draft must be split, the parts stay under one metadata/control message. Admins can edit each part before publishing.

### Running a source manually

```text
/fetch_news
```

The command renders one button per **enabled** source, so the menu grows as you switch sources on: `Офіційний сайт` is always there, joined by `Steam (патчноути)`, `Bluesky`, `YouTube`, `Reddit (витоки)`, `Aniimo Tools (новини)`, and `Аніімо тижня (вікі)`. After an admin clicks a source the bot sends a parsing-started status message, processes the single latest unseen item from that source, and reports how many items were found, how many were already seen, how many were new, how many drafts were created, how many were sent to moderation, and how many failed. Only users listed in `ADMIN_USER_IDS` can run it.

`/redraft` shows the same source picker but re-drafts the source's **newest item even though it has already been posted**. A source that has been collecting for a while reports `found 9, duplicates 9, new 0` and produces nothing, which leaves no way to check the pipeline end-to-end after a change; `/cleanup` cannot help, because it deliberately never clears `seen_sources` (that would re-queue every old article at once). It creates exactly ONE draft and writes nothing to `seen_sources`, so rejecting the result leaves no trace — the report ends with a reminder to reject it rather than publish a duplicate.

Two more admin commands trigger the weekly rubrics on demand:

```text
/fanartdigest         build this week's fan-art digest
/fanartdigest force   rebuild it even if this week was already queued
/aniimoweek           queue one "Аніімо тижня" creature post
```

A fifth command prunes the database:

```text
/cleanup              report how many finished submissions are older than 30 days
/cleanup confirm      delete them and reclaim the freed space
/cleanup 7 confirm    same, with a 7-day window (0 means everything finished)
/cleanup all confirm  wipe every submission, pending ones included, at any age
```

By default `/cleanup` deletes only `published` and `rejected` submissions, together with their parts and tag links — a pending submission is still waiting for a decision. Add `all` to include pending ones too, which is how you clear a queue of abandoned drafts; it drops the age window to 0 unless you also pass a number. Their moderation messages stay in the chat but their buttons then report that the submission no longer exists, so delete those messages by hand.

`seen_sources` is never touched, in either mode. That table is what stops a source from re-queueing news the channel already handled, so clearing it would flood the moderation chat with old items. Published posts already in the channel are unaffected too, since Telegram holds them, not the database.

Nothing is deleted without `confirm`: on its own the command reports what would go, and when nothing matches it lists what the database actually holds by status — otherwise "nothing to clean" is baffling when the moderation chat is visibly full of pending drafts. `VACUUM` runs after a deletion, because SQLite does not shrink its file on its own.

All three commands work in the admin chat or in a DM with the bot, and are listed in the admin chat's command menu. `/aniimoweek` also reports *why* the rubric is idle when it is — it names the missing precondition (`ENABLE_WIKI_ANIIMO` or `GEMINI_API_KEY`) instead of failing quietly.

### The periodic check

When `NEWS_CHECK_INTERVAL_MINUTES` is a positive integer and `GEMINI_API_KEY` is set, a background tick runs every enabled source that belongs to the schedule. Scheduled runs process unseen items from the latest stored publication date in `seen_sources.article_date`, not from the time the bot last parsed the source.

The first tick runs immediately on startup rather than after one interval, so a restart or deploy does not leave the bot blind, and each wait is measured from the start of a run so a slow tick cannot make the schedule drift later and later.

The very first scheduled tick of a source it has never seen is a seeding run: whatever the feed holds at that moment is recorded in `seen_sources` with the outcome `seeded` and none of it is drafted, so a fresh database does not push months of archive into moderation. Seeding fetches only the listing — no article is parsed and no Gemini call is made — and collection starts from the next item published after it. It applies only to a source with no rows at all; once one item is recorded, whether by a seeding run or by `/fetch_news`, the article-date gate keeps older items out, so enabling a new source later never replays its archive either. Seeded rows are excluded from what `/stats` and the weekly report count as collected.

Two things deliberately sit outside that tick, because they are weekly and would otherwise post every interval:

- the **"Аніімо тижня" rubric**, which runs on `WIKI_ANIIMO_WEEKDAY` at `WIKI_ANIIMO_HOUR` — it is still available as a `/fetch_news` button
- the **fan-art digest**, which runs on `FANART_DIGEST_WEEKDAY` at `FANART_DIGEST_HOUR`

Sources in a tick run one after another rather than in parallel, in registry order — official site, Steam, Bluesky, YouTube, Reddit, Aniimo Tools — so each one's duplicate check can see what the previous source just queued. They share one send throttle, so a tick with many new items trickles into the moderation chat instead of flooding it. If one source raises, it is logged and counted as failed while the rest of the tick continues.

### Prompts and text

The draft prompt is chosen by source: `prompts/gemini_news_uk.md` for official articles from the site and Steam (plus the editable style guide in `prompts/official_news_style.md`), `prompts/gemini_shortform_uk.md` for social, leak and third-party posts, and `prompts/gemini_wiki_creature_uk.md` for the creature spotlight. One further prompt backs no single source's draft: `prompts/gemini_dedup_uk.md` for the cross-source duplicate check. Update the style guide to tune tone, templates, length limits, source URL rules, tag rules, and Kyiv-time wording without changing code.

All three drafting prompts carry the same terminology rules, so the channel reads consistently. The game is **Aniimo** and is never translated or transliterated; the creatures are «аніімо» in Ukrainian, lowercase and indeclinable («нове аніімо», «86 аніімо»); players are Pathfinders → «Слідопити». Creature names, locations (Idyll, Nimbus Fields, The Mistwoods, Polaris Institute), forms («Highland Form»), items, currencies (Glimmer), event names and terms like Bond Pact or Sparkling stay in the original English — no Ukrainian localisation exists and players search by the English names — while elements and roles may be translated (Fire → вогонь, Support → підтримка). Everything the developers publish is in UTC+8, so the prompts insist on Kyiv time from the supplied notes and never leave "UTC+8" in a post. Feed titles and bodies are passed to Gemini as untrusted data with an explicit instruction not to obey anything embedded in them. User-visible UI text, reports, date labels, footer labels, and collector button labels live in `locales/uk.json`.

### The weekly rubrics

### Knowing what the sources actually do

Until a source is measured, keeping it is a guess. The bot posts an **activity report** to the admin chat once a week (`ENABLE_WEEKLY_REPORT`, on by default, `WEEKLY_REPORT_WEEKDAY`/`WEEKLY_REPORT_HOUR` in `ARTICLE_TIMEZONE`), and the same report is available on demand as `/stats` — `/stats` covers the last 7 days, `/stats 30` the last 30, up to 90.

Per source it answers four questions: how many items it **found**, how many of those were dropped as **cross-source duplicates**, how many were **published**, and how many were **rejected**. A source that brought nothing is listed as such rather than omitted — silence is the finding, and it is how a quietly broken feed shows up. A switched-off source says so. Readers' own submissions are counted separately, without the "found" and "duplicate" columns that would always read zero for them.

The report closes with the queue as it stands right now, ignoring the window: how many drafts are pending and how long the oldest has waited. A draft forgotten for three weeks is exactly what a weekly summary should put in front of you.

The duplicate count is possible because `seen_sources` records **why** an item was marked seen — `queued` or `duplicate`. Rows written before that column existed are counted as found, never silently dropped.

The **fan-art digest** pulls the top `FANART_FLAIR` posts of the past week from `FANART_SUBREDDIT` and queues one Telegram album of up to `FANART_DIGEST_COUNT` images. The caption credits each artist by their Reddit nick, hyperlinked to their post — post titles are never shown. Only direct `i.redd.it` still images are included: a media group is atomic, so one image Telegram cannot fetch would fail the whole album. At most three works by the same artist are used, so one prolific week does not turn the round-up into a solo show; further works by that artist are held back and only used if the album would otherwise come out short. A week that yields no usable image is not marked done, so a later run can still post it.

The **"Аніімо тижня" rubric** shuffles the wiki roster and takes the first creature whose `wiki_aniimo:<entryId>` key is not yet in `seen_sources`, so over time it walks the whole roster in random order without repeating one. There is no AI "pick" step: the choice is a shuffle, and Gemini's only job is the writing. The creature's page is turned into an English fact sheet — name, number, element, role, description, habitats, evolution line, trait, mobility — and the prompt turns that into a 250–700 character Ukrainian post opening with `🐾 Аніімо тижня — <Name>`, keeping creature, location and form names in English, translating elements and roles, and forbidding invented facts. The post carries the creature's wiki image, ends with `Більше про цю істоту — в офіційній вікі.` linking its wiki page, and is tagged `#AniimoUA #АніімоТижня`.

Official AI posts are styled as Telegram gaming-community updates, not article summaries. The prompt asks for a short headline, 1-3 compact blocks, relevant emoji markers, natural Ukrainian, no greetings, no clickbait, no raw Markdown, no public metadata, and no copied patch-note wall. Post-processing sanitizes Markdown artifacts such as `**bold**`, `*` bullets, raw headings, excessive asterisks, duplicated blank lines, misplaced hashtags, raw source URLs, and public `Дата публікації` / `Джерело` lines before moderation. The code detects broad article types from title/body keywords and passes the matching style context to Gemini: patch notes/update notice, maintenance/server notice, trailer/teaser/reveal, event/rewards/login bonus, shop/outfits/bundles, or announcement/notice. Normal posts target 400-900 characters and are capped at 1200; large patch notes are capped at 1600.

The admin moderation preview keeps metadata separate from the publishable draft. For official news it shows the submission ID, source, article title, detected category, Kyiv article date when available, source URL, truncated draft preview, tags, status, and the normal approve/edit/reject buttons. It does not dump the full parsed article body into Telegram; full `original_text` remains stored in the database for context.

The community navigation footer is always added to every published post — official AI-generated news drafts (after the hashtags) and manual user submissions alike. It is shown in moderation so admins see the final publishable post:

```text
#AniimoUA #Офіційно #Патч

💬 Чат | 🤖 Запропонувати новину
```

It is one line of links and nothing more. A horizontal rule and a "Навігація по ком'юніті" heading used to sit above it; under a short post they took up more room than the post itself, so both were dropped.

Footer labels and URLs both live in `locales/uk.json` under `post_footer.links` (`chat`, `submission`, `discord`), each with a `label` and a `url`. **The shipped URLs are placeholders for your community** (`https://t.me/AniimoUAChat`, `https://t.me/AniimoUABot`) — change them there. An item whose `url` is empty or invalid is left out of the footer entirely rather than printed as dead text, which is how a link is parked until it exists: the `discord` entry ships that way, with its label kept so restoring it is a one-line change. If a `url` is set, that item is rendered as a safe Telegram HTML link. The bot validates that footer URLs use `http` or `https` before rendering links. The footer is not part of a draft's stored text: it is appended fresh on every render. The editable copy of a part therefore shows the bare body without it, and any trailing footer is stripped again on save, so editing a part can never duplicate it. Change the labels and URLs in `locales/uk.json` rather than in a draft.

Published, moderated, and edited text messages are sent with Telegram link previews disabled, which keeps hidden footer links and body links from creating large embedded preview cards. Two cases deliberately opt back in. A collector's YouTube post enables a large preview of its video URL, so a post whose video could not be downloaded is still playable in place. And a **reader's own submission** previews the first link in the text they sent: a submitted link is otherwise published as naked blue text that says nothing about what is behind it. If that link is a YouTube video it takes the same path as the collector's — downloaded and re-uploaded as native video, falling back to the playable preview — while any other link simply gets its card. Readers' text is never rewritten; only how their link is displayed changed. An IP-literal host in a non-public range is never previewed. Telegram sends use a 30 second request timeout and retry grammY `HttpError` network failures, request timeouts and aborts (`TimeoutError`, `AbortError`, `ETIMEDOUT`, `ECONNRESET`), and flood-wait `429` responses up to three times with exponential backoff. A short delay is added between multi-message sends to reduce flood risk.

### Duplicate detection

Two independent layers keep the same story from arriving twice.

Per-source deduplication uses the `seen_sources` table, where each source has its own `source_type` and its own natural key: the canonical `/newslist/detail/<id>` URL for the official site, the feed `guid` for Steam and Aniimo Tools, the `at://` post URI for Bluesky, a normalised title scoped to the publish day for YouTube (a channel may re-upload the same trailer under different IDs), the `t3_` post id for Reddit, `wiki_aniimo:<entryId>` for the creature rubric, and the ISO week for the fan-art digest. An item is marked seen either when it is dropped as a cross-source duplicate (so the same story is not re-fetched and re-judged every tick), or after Gemini creates a draft **and** the moderation preview is sent successfully. If Gemini fails, the moderation send fails, or the bot crashes first, the item stays unseen and can be picked up again.

Cross-source deduplication then catches the same story arriving through two different feeds. Before queueing, Gemini compares the candidate's title against recent titles from *other* sources and drops a duplicate. Two sources opt out of being suppressed: the official site, so its full article is never dropped in favour of a shorter social post or the Steam copy, and the creature rubric, since a creature page is not a news story. Both still contribute their titles for other sources to compare against. Steam does take part, which is the point: it repeats the site's announcements, and the site runs first. The check fails open — any error keeps the item.

### Hashtags

Tags are deterministic, not generated. Official articles (site and Steam) get `#AniimoUA` and `#Офіційно`, followed by up to three Ukrainian topic hashtags matched from the title and body: `#Патч`, `#Фікси`, `#Баланс`, `#Івент`, `#Магазин`, `#Косметика`, `#Трейлер`, `#Аніімо`, `#Сюжет`, `#Локації`, `#Геймплей`, `#Версія`, `#ТехнічніРоботи`, `#Рейтинг`, `#Мобільна`, `#Платформи`, `#Бета`, `#Креатори`, `#Спільнота`, or `#Анонс` as the fallback. Social and third-party sources (Bluesky, YouTube, Aniimo Tools) get the same topic tags without the `#Офіційно` marker.

Two kinds of post opt out of that scheme, because the topic rules would mislabel them:

- **Leaks** (Reddit) always carry `#Чутки` and never fall back to `#Анонс` — a datamine is not an announcement. The marker is added to every leak rather than only when no topic matched, so it is something readers can rely on and use as a filter.
- **The creature rubric** always uses `#AniimoUA #АніімоТижня` and ignores the topic rules entirely, since a habitat list is neither news nor an announcement.

### Media

The official site and Steam are photo-only: the site's `mainPic` (or the first safe image in the Steam announcement) is the cover, and further images from the article body are collected for an album, each source restricted to its own hosts. When no image can be parsed safely the draft is still created as text.

The other sources go further:

- **Albums.** A single-part draft with two or more photos — a Bluesky post with several infographics, an official or Steam article with several images, an Aniimo Tools article, or the fan-art digest — becomes one Telegram media group. Collector album images are downloaded and re-uploaded as bytes rather than sent by URL, because Telegram refuses by-URL photos above roughly 5 MB while a bytes upload allows 10 MB. Images are capped at 10 MiB and must be JPEG, PNG, or WebP. A media group is atomic, so if Telegram rejects one item the publisher drops that image and retries with the rest.

  A reader's own album arrives differently: Telegram has no "album finished" update, so its items appear as separate messages that share only a `media_group_id`. The submission handler collects them for a short window (2.5 s, restarted by each new item) and stores ONE submission with a part per item — otherwise five photos became five queue entries, five moderation cards and five single-photo posts. Those items carry a Telegram `file_id`, so publishing sends them straight back with no download and no size limit, and each keeps its own type: a photo-and-video group publishes as one mixed media group rather than losing the video.
- **Native video.** YouTube videos are downloaded through YouTube's own InnerTube API with `youtubei.js` (progressive MP4 only, so no ffmpeg is needed) and Bluesky videos are fetched as their original uploaded MP4. Both are re-uploaded so they play inline. Above the configured MB cap, or if the download or upload fails, the post falls back to text: a YouTube post keeps its large playable link preview, while a Bluesky video post degrades to plain text with previews disabled.

  The stream URL is scrambled by a function inside YouTube's player script. `services/youtube_video.js` runs that function in a `node:vm` realm whose global object is empty — no `process`, no `require`, no `fetch` — with a hard timeout, so third-party script has nothing to reach the bot token or the database with.

  Where the bot runs decides whether a download is possible at all. From a home connection the app clients (`ANDROID` first) hand back a progressive MP4 with no ceremony. From a datacenter IP — any VPS — YouTube answers every client with "Video is login required", which is why a server that works in development can publish nothing but link previews. `services/youtube_po_token.js` mints a Proof-of-Origin token for the session, which reopens the `WEB`/`MWEB` path; the client order is `ANDROID`, `WEB`, `MWEB`, `IOS`, `TV_EMBEDDED` so both cases are covered. Minting means running Google's BotGuard, obfuscated third-party code that expects a browser, so it runs inside a jsdom window — a separate realm with no `process`, `require` or `fetch` — and only strings and byte arrays cross back. The token is bound to the session's visitor data and the client is rebuilt every six hours so it cannot go stale. Every failure degrades to a token-less download, and then to the link preview.

  Live streams and Post-Live-DVR videos are never downloadable: YouTube serves them as five-second segments that need ffmpeg to stitch, so a live broadcast always publishes as a playable preview no matter how the token negotiation goes.
- **Moderation shows the real thing.** Albums and native videos are previewed in the moderation chat exactly as they will be published, so an admin approves what actually goes out. The cost is that a video is downloaded twice — once for the preview, once for publishing.

Album posts, YouTube posts, and downloaded-video posts cannot be edited from moderation — there is no text message to edit — so they are approved or rejected as a whole. Every other post type is editable as usual.

All external media is host-restricted and SSRF-guarded: images may come only from each source's own CDN (`aniimo.com` for the site and wiki, Steam's CDNs for Steam, `aniimotools.dev` for Aniimo Tools), downloads are HTTPS-only with redirects disabled, internal and loopback addresses are refused, and bodies are streamed with a hard size cap instead of being buffered. Untrusted XML feeds are parsed with DTDs and entity declarations refused outright, so an entity-expansion bomb is rejected rather than expanded. If a media send still fails after retries, the bot logs it and falls back to publishing the text.

The bot does not keep collector media on disk. It stores Telegram `file_id` values for user-submitted media and external URLs for collected items; downloads happen in memory at send time.

### Dates and times

Article dates are parsed by a purpose-built parser covering the shapes the sources actually emit (ISO 8601, RFC 2822, the month-name / slash forms, and the official API's `2026-09-22 00:00:12`, which is read as Asia/Shanghai because that is what the server writes). If the source includes timezone information, the date is converted to `ARTICLE_TIMEZONE` using the IANA timezone database. If a source date includes a time but no timezone and no known origin, the bot does not assume UTC; it keeps date-only metadata instead. Public posts show visible times only as Kyiv time with `за Києвом` when conversion is reliable.

Aniimo writes its schedules the way a UTC+8 studio does: `September 23, 2026, 00:00 – 10:00 (UTC+8)`, `September 25, 2026, 10:00 – December 10, 2026, 07:59（UTC+8）`, `as of September 22, 2026, at 00:00 (UTC+8)`. A trailing zone applies to every time in the same range or sentence before it, each endpoint gets the date nearest before it, and both the fullwidth `（）` and ASCII `()` spellings are accepted. Those conversions are supplied to Gemini as notes and post-processing also replaces matching raw times when the notes are available, so a maintenance window lands in the post as Kyiv time. If conversion is uncertain, the prompt tells Gemini to avoid guessing and omit the time or keep date-only wording.

## Editing Text And Media

The moderation chat now keeps the publishable post content separate from the control panel:

- The first message or messages are the current post parts without buttons.
- Every post part message renders the community footer with clickable Telegram HTML links, matching the publish preview, for both official AI news and manual submissions.
- The last message is the metadata/control message with `✅ Approve`, `✏️ Edit`, and `❌ Reject`.
- After `✏️ Edit`, the bot shows buttons for every part, even when there is only one part.
- Choosing a part copies that original message into a temporary draft message with `💾 Зберегти`.
- After the admin edits the draft message and clicks save, the draft is deleted and the original part message above is updated.
- In groups where admins cannot directly edit bot messages, sending a new text message while the draft is active updates the draft message; the admin still confirms with `💾 Зберегти`.
- `➕ Нова частина` starts add-part mode. The next supported admin message is copied into the moderation chat as a new post part, and the metadata/control message is moved to the bottom again.
- Approval publishes all saved parts in order.

## Discord Moderation (Optional)

The project can also run an optional Discord moderation bot for our own Aniimo
UA community server. It is **independent** from the Telegram flow and is
**not** a news source — Discord is used only for moderation/utility.

Both bots run in the **same process**: `main.js` starts the Discord bot as a
cancellable background task (`createTask`) alongside the existing Telegram
long-polling loop, inside the same Node process. If the Discord bot is disabled, misconfigured,
or fails to log in, it logs a safe message and the Telegram bot keeps running
normally. Secrets are never logged.

### Enable it

The Discord module lives in [`discord_moderation.js`](discord_moderation.js) and
uses `discord.js`. It starts only when `ENABLE_DISCORD_MODERATION=true`. Add to
`.env` (the ids below are placeholders — use your own server's):

```env
ENABLE_DISCORD_MODERATION=true
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_MOD_LOG_CHANNEL_ID=123456789012345678
DISCORD_ALLOWED_INVITES=
DISCORD_GUILD_ID=
DISCORD_WELCOME_CHANNEL_ID=
DISCORD_CHAT_CHANNEL_ID=
DISCORD_LFT_CHANNEL_ID=
```

- `ENABLE_DISCORD_MODERATION` — `true`/`1`/`yes`/`on` starts the Discord bot, `false`/`0`/`no`/`off` keeps it off. An unrecognized value keeps the default, which is off.
- `DISCORD_BOT_TOKEN` — bot token from the Discord Developer Portal. Keep it secret; it is read only from the environment and never printed or logged.
- `DISCORD_MOD_LOG_CHANNEL_ID` — channel where moderation actions, reports, and warning auto-actions are logged (enable Developer Mode, right-click the channel → Copy Channel ID). If it is missing or the bot cannot post there, the bot logs a single safe warning instead.
- `DISCORD_ALLOWED_INVITES` — optional, comma-separated invite codes or full invite URLs to allow. **Empty means block every Discord invite link.**
- `DISCORD_GUILD_ID` — optional. When set, slash commands sync instantly to that server; otherwise a global sync is used, which can take up to ~1 hour to appear.
- `DISCORD_WELCOME_CHANNEL_ID` — optional. When set, the bot greets each new member in that channel. **This requires the privileged "Server Members Intent" enabled in the Developer Portal.** Leave it empty to disable public welcomes; the bot then does not request the members intent at all, so the rest of the bot is unaffected.
- `DISCORD_CHAT_CHANNEL_ID`, `DISCORD_LFT_CHANNEL_ID` — optional channel IDs shown as links in the welcome message. Each appears only when set; channels are never hardcoded. (Rules are shown inline from `discord_rules.txt`, not as a channel link.)

Misconfigured Discord values never raise a configuration error, so they cannot
stop the Telegram bot from starting.

### Developer Portal setup (one-time)

1. **Message Content Intent** — enable it under *Developer Portal → your app → Bot → Privileged Gateway Intents*. Without it the bot logs in but cannot read messages, so the filters cannot work. The bot detects this case and logs a clear hint.
2. **Slash command scopes** — invite the bot with **both** the `bot` and `applications.commands` OAuth2 scopes, e.g. an invite URL containing `scope=bot%20applications.commands`. Without `applications.commands` the slash commands will not appear.
3. **Server Members Intent** — only required if you enable the welcome system (`DISCORD_WELCOME_CHANNEL_ID`). Enable it in the same *Privileged Gateway Intents* section. The bot requests this intent only when a welcome channel is configured, so leaving welcome off needs no extra setup.

### Required Discord permissions (no Administrator)

Grant only these — the bot is designed to work without Administrator and degrades
gracefully when a permission is missing:

- View Channels
- Send Messages
- Manage Messages (delete flagged messages, `/clear`)
- Read Message History
- Moderate Members (timeouts, `/timeout`)
- Embed Links (mod-log embeds)
- Use Application Commands (slash commands)

Double-check that the bot's role is **above** the roles of members it should be
able to time out — Discord forbids timing out the server owner or anyone with an
equal/higher role, regardless of permissions.

### Moderation features

- **Anti-spam** — tracks messages per user per channel; more than 5 messages in ~7 seconds deletes the triggering message (when the bot has Manage Messages), applies a 60-second timeout (when it has Moderate Members), and logs the action. Thresholds are constants near the top of `discord_moderation.js`.
- **Invite filter** — detects `discord.gg/…`, `discord.com/invite/…`, and `discordapp.com/invite/…` and deletes them unless the code is in `DISCORD_ALLOWED_INVITES`.
- **Suspicious link filter** — conservative patterns for fake-Nitro, Steam-gift scams, crypto/airdrop spam, phishing look-alike domains, and IP-logger/grabber links; generic URL shorteners are flagged only when paired with a scam keyword.
- **Bad-word filter** — a deliberately tiny, configurable list kept in an external, easy-to-edit text file, [`discord_badwords.txt`](discord_badwords.txt) (one term per line, `#` comments allowed). It is matched with Unicode-aware word boundaries to avoid overblocking normal Ukrainian/Russian/English words. Add server-specific terms there and restart the bot; if the file is missing the bot falls back to a small built-in default.
- **Mod logs** — every action is posted to `DISCORD_MOD_LOG_CHANNEL_ID` as an embed with the action, user mention + ID, channel, reason, a short safe message preview, and a timestamp. The log never pings anyone.

Members who already have **Manage Messages** (mods/admins) bypass the content
filters.

### Slash commands

All command descriptions and user-facing replies are in Ukrainian.

- `/help` — show the full command list (visible to moderators only).
- `/clear amount` — delete 1–100 recent messages in the current channel (requires Manage Messages).
- `/timeout user minutes reason` — timeout a member for 1–40320 minutes / up to 28 days (requires Moderate Members).
- `/warn user reason` — warn a member; stored in persistent history, logged to the mod-log channel, and DM'd to the user when possible (requires Moderate Members).
- `/warnings member` — show a member's warning history (requires Moderate Members).
- `/clearwarnings member` — clear a member's warning history (requires Moderate Members).
- `/report member reason` — **available to any member**; sends a report to the mod-log channel. The reporter gets an ephemeral confirmation and a light per-user cooldown prevents spam.
- `/lfthelp` — **available to any member**; shows an ephemeral guide for the looking-for-team forum (how to create a post, tags, post template). Links the forum when `DISCORD_LFT_CHANNEL_ID` is set. The forum itself can be (re)configured with `node scripts/setup_lft_forum.js` (needs Manage Channels, Send Messages / Create Posts, and Manage Threads on the forum channel).

Each moderator command re-checks permissions at runtime and reports problems
privately (ephemeral) instead of failing loudly.

### Warning history and auto-actions

`/warn` records each warning in the project's SQLite database in a dedicated
`discord_warnings` table (columns: `id`, `guild_id`, `user_id`, `moderator_id`,
`reason`, `created_at`). The table is created automatically on startup; no
migration step is needed and the Telegram side never touches it.

Auto-actions trigger on the number of active warnings (thresholds are constants
near the top of `discord_moderation.js`):

- 3 warnings → 10-minute timeout
- 5 warnings → 1-hour timeout
- 7 warnings → an urgent mod-log note asking moderators to review manually

The bot **never auto-bans or auto-kicks**, only times out when it has *Moderate
Members* (logging a safe note to the mod-log if it cannot), and never
auto-punishes members who themselves have moderator/admin permissions.

### Welcome system (optional)

When `DISCORD_WELCOME_CHANNEL_ID` is set, the bot greets each new member in that
channel with a Ukrainian welcome embed. The embed shows a short rules list read
from the editable `discord_rules.txt` (one rule per line; `#` comments allowed;
omitted if the file is missing/empty) and, optionally, chat / looking-for-team
channel links when those IDs are configured. It mentions only the joining member
and never `@everyone`. This is the only feature that needs the privileged Server
Members Intent, and it is requested only when the welcome channel is configured.

### Install and run

`discord.js` is listed in `package.json`, so `npm install` installs it. Run the
project exactly as before with `npm start` — when
`ENABLE_DISCORD_MODERATION=true` and a valid token is present, the Discord bot
starts automatically next to the Telegram bot. To run Telegram only, set
`ENABLE_DISCORD_MODERATION=false` (or leave the token empty).

## Telegram Chat Moderation (Optional)

The same Telegram bot can also moderate community group chats (for example
`t.me/AniimoUAChat`). It mirrors the Discord moderation feature set but uses
the native Telegram API and runs in the **same process** as the news/submission
flow — there is no second bot and still only one grammY `bot.start()` polling loop. It is disabled
by default and never affects the submission/news flows when off.

The moderation logic lives in [`handlers/moderation.js`](handlers/moderation.js)
(Telegram I/O) and [`services/chat_moderation.js`](services/chat_moderation.js)
(pure rules), and warnings are stored in the project's SQLite file in a dedicated
`telegram_warnings` table the rest of the bot never touches.

### Enable it

Add to `.env` (each value is parsed leniently, so a typo can never stop the bot; the chat id shown is a placeholder):

```env
ENABLE_TELEGRAM_MODERATION=true
TELEGRAM_MODERATION_CHAT_IDS=-1001234567890
TELEGRAM_MOD_LOG_CHAT_ID=
TELEGRAM_LINK_ALLOWLIST=
TELEGRAM_WELCOME_DELETE_SECONDS=60
```

- `ENABLE_TELEGRAM_MODERATION` — `true`/`1`/`yes`/`on` enables moderation, `false`/`0`/`no`/`off` disables it, and an unrecognized value keeps the default (off). Moderation only actually starts when the flag is on **and** `TELEGRAM_MODERATION_CHAT_IDS` contains at least one chat ID.
- `TELEGRAM_MODERATION_CHAT_IDS` — comma-separated chat IDs to moderate (supergroup
  IDs look like `-1001234567890`). Only these chats are moderated; everything else
  (the bot's DMs, admin chat, publish channel) is untouched. **Do not list
  `ADMIN_CHAT_ID` or `PUBLISH_CHAT_ID` here.**
- `TELEGRAM_MOD_LOG_CHAT_ID` — where moderation actions are logged. Defaults to
  `ADMIN_CHAT_ID` when empty.
- `TELEGRAM_LINK_ALLOWLIST` — comma-separated allowed `t.me` link codes/usernames
  (bare code or full URL). **Empty means block every non-allowlisted `t.me`
  invite/link** posted by non-moderators. List your own community links here.
- `TELEGRAM_WELCOME_DELETE_SECONDS` — seconds before the welcome message
  auto-deletes; `0` disables auto-delete.

### Telegram setup (one-time)

1. Each moderated chat must be a **supergroup** (Telegram only allows muting in
   supergroups).
2. Add the bot to the chat and **promote it to admin** with at least *Delete
   Messages* and *Ban/Restrict Users*. An admin bot receives every message
   regardless of the group's privacy mode, so the filters can see all content. If
   the bot is not an admin in an allowlisted chat, it logs a clear warning and the
   filters stay silent until it is promoted.

### Moderation features

- **Anti-flood** — more than 5 messages from the same user in ~7 seconds deletes
  the triggering message and applies a short temporary mute (constants near the top
  of `services/chat_moderation.js`). Stickers/media count toward the flood limit too.
- **Telegram invite/link filter** — deletes `t.me/…`, `t.me/+…`, and
  `t.me/joinchat/…` links to other chats unless the code is in
  `TELEGRAM_LINK_ALLOWLIST`. Well-known non-invite paths (sticker packs, share
  links, proxies) are ignored.
- **Suspicious/scam link filter** — conservative patterns for free-Nitro/Premium,
  gift-card and crypto-airdrop scams, pump groups, phishing look-alikes, and
  IP-logger links; generic shorteners are flagged only with a scam keyword.
- **Bad-word filter** — a tiny, editable list in
  [`telegram_badwords.txt`](telegram_badwords.txt) (one term per line, `#`
  comments allowed), matched with Unicode-aware word boundaries so it never flags
  substrings of normal words.
- **Edited messages** are re-checked for the content filters above (a benign
  message edited to add a scam link is caught), but edits do not count toward
  anti-flood.
- **Warnings + auto-actions** — `/warn` stores warnings in `telegram_warnings`;
  3 warnings → 10-minute mute, 5 → 1-hour mute, 7 → an urgent mod-log note for
  manual review. The bot **never auto-bans or auto-kicks** and never auto-punishes
  moderators.
- **Mod log** — every action is posted to `TELEGRAM_MOD_LOG_CHAT_ID` (or the admin
  chat) with the action, user, moderator, reason, and a short message preview.
- **One-tap log actions** — report entries carry inline 🗑 Delete / 🔇 Mute (1h) /
  ⛔ Ban buttons (auto-filter entries get Mute/Ban; Delete appears only if the
  offending message still exists). Only moderators of the target chat can use
  them; the outcome and who clicked are appended to the log entry.
- **Welcome** — new members get a Ukrainian welcome with a short rules list read
  from the editable [`telegram_rules.txt`](telegram_rules.txt); it auto-deletes
  after `TELEGRAM_WELCOME_DELETE_SECONDS` to avoid clutter.
- **Service-message cleanup** — the "X joined" / "X left" service messages are
  deleted automatically to keep the chat clean.

Chat administrators (and the bot's configured `ADMIN_USER_IDS`) bypass the content
filters and are protected from auto-actions; anonymous-admin and linked-channel
posts are never moderated. All destructive actions degrade gracefully when the bot
lacks a permission — they log a one-time warning and keep the bot polling.

### Commands

All command replies are Ukrainian. Available to chat admins / `ADMIN_USER_IDS`:

- `/modhelp` — show the command list and the active auto-moderation summary.
- `/del` — delete the replied-to message.
- `/mute [duration] [reason]` — mute a member (reply or numeric ID). Duration like
  `30` (minutes), `2h`, `1d`; no duration defaults to 60 minutes; `0` mutes
  permanently. Everything after the duration is stored as the reason.
- `/unmute` — lift a mute (restores the chat's default permissions).
- `/ban [duration] [reason]` — ban a member; no duration means a permanent ban.
- `/unban` — unban a member (by numeric ID or by replying to one of their messages).
- `/kick` — remove a member without a lasting ban (they can rejoin via an invite link).
- `/warn [reason]` — warn a member; stored in history, logged, and DM'd to the
  member when possible.
- `/warnings` — show a member's warning history.
- `/clearwarnings` — clear a member's warnings.

Available to **every member** of a moderated chat:

- `/report [reason]` — report the replied-to message to the moderators. The report
  goes to the mod-log chat with the reporter, the reported member, an optional
  reason, a short preview, and a deep link to the message. The `/report` message
  and the confirmation auto-delete shortly after, and a light per-user cooldown
  (3 reports per minute) prevents abuse. Self-reports and reports against bots
  are rejected.
- `/rules` — show the chat rules from `telegram_rules.txt`; the reply (and the
  command) auto-delete after `TELEGRAM_WELCOME_DELETE_SECONDS`.

Targets are chosen by replying to a message or by passing a numeric user ID.

### Which commands each chat sees

Telegram stores the command menu server-side per scope, so the bot sets every scope
explicitly at startup rather than relying on whatever BotFather was once given:

- **Private chats** show only `/start`.
- **The default and all-group scopes are cleared**, so an unmoderated group inherits
  no menu at all.
- **The admin chat** shows `/fetch_news`, `/redraft`, `/fanartdigest`, `/aniimoweek`, `/stats`, `/cleanup`, and `/cancel`.
  This is skipped when the admin chat is itself a moderated chat, so admin commands
  are never advertised to ordinary members.
- **Each moderated chat** shows `/report` and `/rules` to members, while its
  administrators get the full moderation list, which overrides the member menu.
- When moderation is switched off, the menus of the listed chats are deleted so
  members stop seeing dead `/report` and `/rules` entries.

The menu is only about discoverability — every command still checks permissions when
it runs, and a command that is not in a menu still works if you type it. If Telegram
rejects the menu update, the bot retries a few times, then keeps running with the
previously stored menu.

### Install and run

grammY already powers the bot, so no new dependency is needed — run `npm start`
as before. When `ENABLE_TELEGRAM_MODERATION=true` and at least one chat ID is set,
the moderation router is registered alongside the existing routers; otherwise the
bot behaves exactly as before.

## Deploying

`.github/workflows/ci.yml` installs the locked dependencies, imports `main.js`, runs the vitest suite and ESLint on every push and pull request. `.github/workflows/deploy.yml` builds the Docker image on a push to `main`, pushes it to GHCR, and rolls it out over SSH with `scripts/deploy-remote.sh` into `/opt/aniimo-ua-bot` on the server (override with the `HETZNER_DEPLOY_DIR` secret). The compose project is pinned to `aniimo-ua-bot`, so the SQLite database lives on the `aniimo-ua-bot_botdata` volume whatever the directory is called.

Every setting in `.env.example` is forwarded as a repository secret of the same name and upserted into `.env.prod` on the server; an unset secret leaves the app default in place, and a secret that is later deleted keeps its last value in `.env.prod` until you edit that file on the box. The three lists — the workflow's `env:` block, its `printf 'export …'` block and the `upsert` list in `deploy-remote.sh` — are kept identical, and identical to what `config.js` reads. `DATABASE_PATH` is the one exception: it is pinned to `/data/bot.db` by the image and the compose file, never forwarded.

## Current Limitations

- Polling mode only, no webhook setup.
- No role management inside Telegram. Access to the news/submission queue comes only from `ADMIN_USER_IDS`; in a moderated group chat the bot additionally treats that chat's own Telegram administrators as moderators.
- The official news site and Steam are parsed for photos only; video comes from Bluesky and YouTube instead.
- Bluesky is dormant until `BLUESKY_ACTOR` is set, because Aniimo has no official account there.
- The Reddit rumour source points at `r/AniimoLeaks`, which was empty at launch; its flair defaults are a guess, and a wrong flair yields an empty feed, not an error.
- A reader's submission is published as written: the bot adds the community footer and a link preview, but does not draft, translate, or rewrite it. Use Edit for that.
- Every AI feature depends on one Gemini API key. Without it the collectors still fetch and count items but produce no drafts, and the creature rubric does not run at all.
- Album, YouTube, and downloaded-video posts cannot be edited from moderation — only approved or rejected.
- A reader's album is grouped in memory while its items arrive, so a restart in that 2.5 second window leaves the pieces unqueued; the album has to be sent again.
- A YouTube or Bluesky video is downloaded twice, once for the moderation preview and once for publishing.
- Reddit rate-limits hard, so each Reddit-backed feed is fetched at most once per run.
- User submissions are rate-limited per Telegram user ID using the latest saved submission timestamp.
- Admin content parts stay in the moderation chat above the metadata/control message.
- If the moderation chat is a Telegram channel, Telegram does not expose the author of ordinary channel posts to the bot. The bot enforces `ADMIN_USER_IDS` on inline button clicks, then accepts the next supported channel post only for the explicit `➕ Нова частина` flow. Use a private group or supergroup if you need every add-part message to carry the real admin user ID. `/cancel` also cannot work there, since channel posts carry no user.
- There is no special command for clearing a text-only part to empty.

## Planned Future Features

- More gaming-media source parsers.
- Webhook deployment mode.
