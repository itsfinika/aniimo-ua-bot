import process from "node:process";

import { Bot } from "grammy";

import { ConfigError, loadConfig } from "./config.js";
import { Database } from "./database.js";
import { startDiscordModeration } from "./discord_moderation.js";
import { buildAdminComposer } from "./handlers/admin.js";
import { buildModerationComposer, cancelScheduledDeletes } from "./handlers/moderation.js";
import { buildUserComposer } from "./handlers/user.js";
import { cancelTasks, cancellableSleep, createTask } from "./services/background.js";
import { runAllCollectors } from "./services/collectors/registry.js";
import { startWikiAniimoScheduler } from "./services/collectors/wiki_aniimo/collector.js";
import { startDbBackupScheduler } from "./services/db_backup.js";
import { startFanartDigestScheduler } from "./services/digests/fanart.js";
import { startGuidesDigestScheduler } from "./services/digests/guides.js";
import { startWeeklyReportScheduler } from "./services/reports.js";
import { t } from "./services/i18n.js";
import { getLogger, setLogLevel } from "./services/logger.js";
import { sleep, sortedNumbers } from "./services/pyutils.js";
import { isTelegramApiError } from "./services/telegram_errors.js";

const logger = getLogger("main");

export async function run() {
  const config = loadConfig();
  const database = new Database(config.database_path);
  await database.init();

  const bot = new Bot(config.bot_token);
  bot.catch((error) => {
    // aiogram logged a failing handler and kept polling; grammY would otherwise
    // tear the whole bot down on the first unhandled handler error.
    logger.exception("Unhandled error while processing an update", error.error ?? error);
  });
  await bot.init();

  // Order matters: admin (admin-chat/private) first, then the optional moderation
  // composer (scoped to the allowlisted group chats), then the private-only user
  // submission composer. The moderation composer is only registered when enabled
  // and at least one chat id is configured, so behaviour is unchanged when off.
  bot.use(buildAdminComposer({ config, db: database, bot }));
  if (config.enable_telegram_moderation && config.telegram_moderation_chat_ids.size) {
    bot.use(buildModerationComposer({ config, db: database, bot }));
    logger.info(
      `Telegram chat moderation enabled for chats: ${sortedNumbers(config.telegram_moderation_chat_ids).join(", ")}`,
    );
  } else {
    logger.info("Telegram chat moderation is disabled.");
  }
  bot.use(buildUserComposer({ config, db: database, bot }));

  logger.info("Starting Aniimo UA submission bot");
  logger.info(`Admin chat: ${config.admin_chat_id}, publish chat: ${config.publish_chat_id}`);
  logger.info(`Submission cooldown: ${config.submission_cooldown_seconds} seconds`);

  await configureBotCommands(bot, config);

  const newsSchedulerTask = startNewsSchedulerIfEnabled(bot, config, database);
  // Optional, independent Discord moderation bot. Returns null when disabled or
  // misconfigured; any Discord failure is contained and never stops Telegram.
  const discordTask = startDiscordModeration(config);
  const backupTask = startDbBackupScheduler(config);
  const fanartDigestTask = startFanartDigestScheduler(bot, config, database);
  const guidesDigestTask = startGuidesDigestScheduler(bot, config, database);
  const wikiAniimoTask = startWikiAniimoScheduler(bot, config, database);
  const weeklyReportTask = startWeeklyReportScheduler(bot, config, database);

  const stop = () => {
    bot.stop().catch((error) => logger.exception("Failed to stop the bot cleanly", error));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await bot.start({
      allowed_updates: ["message", "edited_message", "channel_post", "callback_query"],
    });
  } finally {
    await cancelTasks([
      newsSchedulerTask,
      discordTask,
      backupTask,
      fanartDigestTask,
      guidesDigestTask,
      wikiAniimoTask,
      weeklyReportTask,
    ]);
    cancelScheduledDeletes();
  }
}

const COMMAND_MENU_ATTEMPTS = 3;
const COMMAND_MENU_RETRY_DELAY_SECONDS = 5;

/**
 * Scope the command menu so the submission hint never shows in group chats.
 *
 * Retries a few times: a transient network blip right at startup would otherwise
 * leave the menu unconfigured until the next restart. Any persistent failure is
 * logged and never stops the bot.
 */
async function configureBotCommands(bot, config) {
  let lastError = null;
  for (let attempt = 1; attempt <= COMMAND_MENU_ATTEMPTS; attempt += 1) {
    try {
      await applyCommandMenu(bot, config);
      return;
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
      lastError = error;
      if (attempt < COMMAND_MENU_ATTEMPTS) {
        logger.info(
          `Configuring the bot command menu failed (attempt ${attempt}/${COMMAND_MENU_ATTEMPTS}); ` +
            `retrying in ${COMMAND_MENU_RETRY_DELAY_SECONDS} s.`,
        );
        await sleep(COMMAND_MENU_RETRY_DELAY_SECONDS);
      }
    }
  }
  logger.warning(
    `Could not configure the bot command menu (${lastError?.name ?? "unknown error"}). The previous menu, ` +
      "stored server-side by Telegram, stays in effect.",
  );
}

/**
 * One attempt at applying the scoped command menu.
 *
 * A default-scope command list (e.g. set once via BotFather) is shown in EVERY
 * chat, including the moderated public group. Instead: private chats get /start,
 * the default and group scopes are cleared, and each moderated chat additionally
 * shows the moderation commands to its administrators only.
 */
async function applyCommandMenu(bot, config) {
  await bot.api.setMyCommands([{ command: "start", description: t("commands.start") }], {
    scope: { type: "all_private_chats" },
  });
  // Clear the default scope so group chats inherit no command menu at all.
  await bot.api.deleteMyCommands({ scope: { type: "default" } });
  await bot.api.deleteMyCommands({ scope: { type: "all_group_chats" } });
  logger.info("Bot command menu configured: /start in private chats only.");

  await applyAdminChatCommands(bot, config);

  if (!(config.enable_telegram_moderation && config.telegram_moderation_chat_ids.size)) {
    // Per-chat command menus persist server-side across restarts. When the listed
    // chats are no longer moderated, clear their menus so members do not keep
    // seeing dead /report and /rules entries.
    for (const chatId of sortedNumbers(config.telegram_moderation_chat_ids)) {
      try {
        await bot.api.deleteMyCommands({ scope: { type: "chat", chat_id: chatId } });
        await bot.api.deleteMyCommands({ scope: { type: "chat_administrators", chat_id: chatId } });
      } catch (error) {
        if (!isTelegramApiError(error)) throw error;
        logger.info(`Could not clear the command menu for chat ${chatId}`);
      }
    }
    return;
  }

  // Ordinary members of a moderated chat see /report and /rules; its administrators
  // see the full moderation list (the admins scope fully overrides the chat scope).
  const memberCommands = ["report", "rules"].map((name) => ({
    command: name,
    description: t(`commands.${name}`),
  }));
  const moderatorCommands = [
    "modhelp",
    "del",
    "mute",
    "unmute",
    "ban",
    "unban",
    "kick",
    "warn",
    "warnings",
    "clearwarnings",
    "report",
    "rules",
  ].map((name) => ({ command: name, description: t(`commands.${name}`) }));
  for (const chatId of sortedNumbers(config.telegram_moderation_chat_ids)) {
    try {
      await bot.api.setMyCommands(memberCommands, { scope: { type: "chat", chat_id: chatId } });
      await bot.api.setMyCommands(moderatorCommands, {
        scope: { type: "chat_administrators", chat_id: chatId },
      });
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
      logger.info(`Could not set moderator commands for chat ${chatId} (is the bot a member there?)`);
    }
  }
}

/**
 * Make the content commands discoverable in the admin chat only.
 *
 * They are gated on ADMIN_USER_IDS at handler level and also work in a DM, but
 * nothing advertised them anywhere, so an admin had to remember the exact
 * spelling. Listing them under the admin chat's own scope keeps them out of every
 * other chat's menu.
 */
export async function applyAdminChatCommands(bot, config) {
  if (config.telegram_moderation_chat_ids.has(config.admin_chat_id)) {
    // That chat's menu belongs to the moderation scopes below: overwriting its
    // chat scope here would advertise admin commands to ordinary members.
    logger.info(
      `Admin chat ${config.admin_chat_id} is also moderated; leaving its command menu to moderation.`,
    );
    return;
  }

  const adminCommands = ["fetch_news", "redraft", "fanartdigest", "guidesdigest", "aniimoweek", "stats", "cleanup", "cancel"].map((name) => ({
    command: name,
    description: t(`commands.${name}`),
  }));
  try {
    await bot.api.setMyCommands(adminCommands, { scope: { type: "chat", chat_id: config.admin_chat_id } });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not set the admin command menu for chat ${config.admin_chat_id}`);
    return;
  }
  logger.info(`Admin command menu configured for chat ${config.admin_chat_id}.`);
}

function startNewsSchedulerIfEnabled(bot, config, db) {
  if (!config.gemini_api_key) {
    logger.warning("GEMINI_API_KEY is missing. Automatic news collector scheduler is disabled.");
    return null;
  }

  if (config.news_check_interval_minutes === null) {
    logger.info("NEWS_CHECK_INTERVAL_MINUTES is empty or invalid. News collector scheduler is disabled.");
    return null;
  }

  // The model is named here because it is the one setting with no other visible
  // trace: a GEMINI_MODEL secret silently overrides the code default, and the
  // deploy script keeps an old value when the secret is removed, so the log is
  // the only way to tell which model is actually generating drafts.
  logger.info(
    `News collector scheduler enabled: every ${config.news_check_interval_minutes} minutes, ` +
      `drafting with ${config.gemini_model}`,
  );
  return createTask("news-collector-scheduler", (signal) => newsScheduler(bot, config, db, signal));
}

/**
 * Poll every source on a fixed cadence.
 *
 * The first run happens immediately rather than after one interval: a restart
 * would otherwise leave the bot blind for a full interval, and a deploy is
 * exactly when it is most likely to have missed something. The wait is measured
 * from the START of each run, so a slow tick cannot make the schedule drift —
 * sources publish on the hour, and a drifting poll turns a predictable lag into
 * a random one.
 *
 * The clock, the sleep and the collector run are injectable so the cadence can be
 * unit-tested without real waiting; production uses the defaults.
 */
export async function newsScheduler(
  bot,
  config,
  db,
  signal,
  { now = () => Date.now(), sleep: sleepFn = cancellableSleep, runCollectors = runAllCollectors } = {},
) {
  const intervalSeconds = config.news_check_interval_minutes * 60;
  for (;;) {
    const startedAt = now();
    try {
      const statsList = await runCollectors({ config, db, bot });
      const sum = (key) => statsList.reduce((total, stats) => total + stats[key], 0);
      logger.info(
        `News scheduler finished: sources=${statsList.length} found=${sum("found")} ` +
          `duplicates=${sum("duplicates")} new=${sum("new")} sent=${sum("sent_to_moderation")} ` +
          `failed=${sum("failed")}`,
      );
    } catch (error) {
      logger.exception("News scheduler failed", error);
    }

    const elapsed = (now() - startedAt) / 1000;
    await sleepFn(Math.max(1.0, intervalSeconds - elapsed), signal);
  }
}

async function main() {
  setLogLevel("INFO");

  try {
    await run();
    logger.info("Bot stopped");
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.critical(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    // Anything else that reaches here happened during startup — a database the
    // container cannot write being the one that has actually bitten. Log it in
    // the usual format and exit non-zero so the container restarts and the
    // deploy's settle check fails, instead of serving a half-working bot.
    logger.critical(`Startup failed: ${error.message}`);
    logger.exception("Startup failure details", error);
    process.exit(1);
  }
}

// Only run when executed directly, so the tests can import this module.
if (import.meta.main) {
  await main();
}
