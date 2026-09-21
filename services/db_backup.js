/**
 * Nightly on-server backup of the SQLite database.
 *
 * Once a day, at DATABASE_BACKUP_HOUR local time (ARTICLE_TIMEZONE), the bot
 * snapshots its SQLite file with `VACUUM INTO` — a consistent copy even while the
 * bot keeps writing — into the `backups/` folder next to the database file. In
 * production that folder lives on the persistent `botdata` volume, so snapshots
 * survive image upgrades; downloading them off the server is left to the operator
 * on purpose. The newest DATABASE_BACKUP_KEEP snapshots are kept, older ones are
 * pruned.
 *
 * Failures are contained exactly like in the news scheduler: any error is logged
 * and the loop simply waits for the next night.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DateTime, FixedOffsetZone, IANAZone } from "luxon";

import { cancellableSleep, createTask } from "./background.js";
import { getLogger } from "./logger.js";

const logger = getLogger("services.db_backup");

/** Start the nightly backup loop, or return null when the feature is off. */
export function startDbBackupScheduler(config) {
  if (!config.enable_database_backup) {
    logger.info("Nightly database backup is disabled (ENABLE_DATABASE_BACKUP).");
    return null;
  }

  logger.info(
    `Nightly database backup enabled: daily at ${String(config.database_backup_hour).padStart(2, "0")}:00 ` +
      `${config.article_timezone}, keeping the ${config.database_backup_keep} newest files in ` +
      `${backupsDirFor(config.database_path)}`,
  );
  return createTask("db-backup-scheduler", (signal) => backupLoop(config, signal));
}

async function backupLoop(config, signal) {
  const zone = resolveTimezone(config.article_timezone);
  let lastBackupDate = null;
  for (;;) {
    const now = DateTime.now().setZone(zone);
    const nextRun = nextRunAt(now, config.database_backup_hour);
    await cancellableSleep(Math.max(1.0, nextRun.diff(now).as("seconds")), signal);
    // The sleep follows the monotonic clock while nextRunAt reads the wall
    // clock: an NTP step backwards during the ~24 h sleep would re-run the same
    // night, so a calendar-date guard keeps the backup once-a-day.
    const runDate = DateTime.now().setZone(zone).toFormat("yyyy-MM-dd");
    if (runDate === lastBackupDate) {
      continue;
    }
    try {
      await runBackupOnce(config);
      lastBackupDate = runDate;
    } catch (error) {
      logger.exception("Nightly database backup failed; retrying next night.", error);
    }
  }
}

/** The next occurrence of `hour`:00 strictly after `now` (same tz). */
export function nextRunAt(now, hour) {
  let candidate = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (candidate <= now) {
    candidate = candidate.plus({ days: 1 });
  }
  return candidate;
}

function resolveTimezone(name) {
  if (IANAZone.isValidZone(name)) {
    return IANAZone.create(name);
  }
  logger.warning(`Unknown ARTICLE_TIMEZONE ${JSON.stringify(name)}; using UTC for the backup schedule.`);
  return FixedOffsetZone.utcInstance;
}

export function backupsDirFor(databasePath) {
  return path.join(path.dirname(databasePath), "backups");
}

/** Write one dated snapshot into backups/ and prune the oldest ones. */
export async function runBackupOnce(config) {
  const dbPath = config.database_path;
  if (!fs.existsSync(dbPath)) {
    logger.warning(`Database file ${dbPath} does not exist; skipping backup.`);
    return;
  }

  const backupsDir = backupsDirFor(config.database_path);
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = DateTime.utc().toFormat("yyyy-MM-dd");
  const stem = path.basename(dbPath, path.extname(dbPath));
  const final = path.join(backupsDir, `${stem}-backup-${stamp}.db`);
  // Snapshot to a temp name first so a crash mid-copy can never leave a
  // truncated file under the final, "looks like a valid backup" name.
  const tmp = `${final}.tmp`;
  try {
    vacuumInto(dbPath, tmp);
    fs.renameSync(tmp, final);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      logger.warning(`Could not remove temporary backup file ${tmp}`);
    }
  }

  const sizeKb = Math.max(1, Math.floor(fs.statSync(final).size / 1024));
  const pruned = pruneOldBackups(backupsDir, stem, { keep: config.database_backup_keep });
  logger.info(`Nightly database backup written: ${final} (${sizeKb} KB); pruned ${pruned} old file(s).`);
}

/**
 * Keep the `keep` newest snapshots, drop the rest; returns the removed count.
 *
 * The dated ISO filenames sort chronologically by name. Leftover `.tmp` files
 * from a crashed run are always garbage by the time this is called.
 */
export function pruneOldBackups(backupsDir, stem, { keep }) {
  let entries;
  try {
    entries = fs.readdirSync(backupsDir);
  } catch {
    return 0;
  }

  const prefix = `${stem}-backup-`;
  const snapshots = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".db")).sort();
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - Math.max(1, keep)));
  stale.push(...entries.filter((name) => name.startsWith(prefix) && name.endsWith(".db.tmp")));

  let removed = 0;
  for (const name of stale) {
    try {
      fs.unlinkSync(path.join(backupsDir, name));
      removed += 1;
    } catch {
      logger.warning(`Could not remove old backup ${path.join(backupsDir, name)}`);
    }
  }
  return removed;
}

/**
 * Write a consistent snapshot of `source` to `target` via VACUUM INTO.
 *
 * Runs on a dedicated connection so it is safe alongside the bot's own writes;
 * SQLite requires the target file to not exist yet. The generous busy timeout
 * lets the copy wait out a concurrent write transaction instead of failing with
 * "database is locked" once the file grows.
 */
export function vacuumInto(source, target) {
  fs.rmSync(target, { force: true });
  const connection = new DatabaseSync(source);
  try {
    connection.exec("PRAGMA busy_timeout = 30000");
    connection.prepare("VACUUM INTO ?").run(target);
  } finally {
    connection.close();
  }
}
