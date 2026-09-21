import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { collapseWhitespace, strip, utcIsoSeconds, utcNowIso } from "./services/pyutils.js";

export const STATUS_PENDING = "pending";
export const STATUS_PUBLISHED = "published";
export const STATUS_REJECTED = "rejected";

/**
 * How long a statement waits for a lock another connection is holding.
 *
 * This MUST be set explicitly: `node:sqlite` defaults to zero and fails a busy
 * write immediately with "database is locked", whereas Python's `sqlite3` — what
 * this file was ported from — defaults to five seconds. Several things touch the
 * database at once (the five-minute collector tick, the weekly rubrics, an admin
 * command, the nightly backup), so without a wait the loser of any overlap just
 * errors out. `/cleanup` hit it first because VACUUM needs the whole file to
 * itself, but every write was exposed.
 */
export const BUSY_TIMEOUT_MS = 5000;

function openConnection(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Fail startup loudly when the database file cannot be written.
 *
 * A container that can read but not write the volume (a uid mismatch after an
 * image change is the way this happens) starts perfectly happily: every
 * `CREATE TABLE IF NOT EXISTS` above is a no-op on an existing schema and needs
 * no write at all. The bot then polls, answers commands, reports collector
 * stats — and silently loses every submission, because only the writes fail.
 *
 * Writing `user_version` back to the value it already holds is a real write
 * that changes nothing, so it surfaces the problem here instead of hours later
 * in a user's DM. Throwing aborts startup, which turns a silent outage into a
 * failed deploy.
 */
function assertWritable(db, dbPath) {
  const current = Number(db.prepare("PRAGMA user_version").get().user_version ?? 0);
  try {
    db.exec(`PRAGMA user_version = ${current}`);
  } catch (error) {
    throw new Error(
      `The database at ${dbPath} is not writable by this process (uid ${process.getuid?.() ?? "?"}): ` +
        `${error.message}. On the server this usually means the data volume is owned by a different ` +
        "uid than the container user - check the Dockerfile's USER against the volume's ownership.",
      { cause: error },
    );
  }
}

/**
 * SQLite persistence for submissions, their parts, tags, the seen-source memory
 * and the Telegram warning history.
 *
 * Every method opens its own short-lived connection, exactly as the Python
 * version did with `aiosqlite.connect(...)` per call: writes are brief, and not
 * holding a connection open keeps the nightly `VACUUM INTO` backup (which runs
 * on its own connection against the same file) from contending with a long-lived
 * handle. The methods are `async` even though `node:sqlite` is synchronous, so
 * every call site reads the same as before and the class stays swappable in tests.
 */
export class Database {
  constructor(dbPath) {
    this.path = dbPath;
  }

  async init() {
    const parent = path.dirname(this.path);
    if (parent && parent !== ".") {
      fs.mkdirSync(parent, { recursive: true });
    }

    const db = openConnection(this.path);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            username TEXT,
            message_type TEXT NOT NULL,
            original_text TEXT,
            draft_text TEXT,
            file_id TEXT,
            admin_message_id INTEGER,
            admin_media_message_id INTEGER,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            published_at TEXT
        )
      `);
      ensureColumn(db, "submissions", "admin_media_message_id", "INTEGER");
      ensureColumn(db, "submissions", "media_url", "TEXT");
      ensureColumn(db, "submissions", "media_type", "TEXT");
      ensureColumn(db, "submissions", "source_url", "TEXT");
      ensureColumn(db, "submissions", "source_type", "TEXT");
      ensureColumn(db, "submissions", "source_id", "TEXT");
      ensureColumn(db, "submissions", "article_date", "TEXT");
      ensureColumn(db, "submissions", "article_date_display", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS submission_parts (
            submission_id INTEGER NOT NULL,
            part_index INTEGER NOT NULL,
            message_type TEXT NOT NULL,
            text TEXT NOT NULL,
            file_id TEXT,
            media_url TEXT,
            media_type TEXT,
            admin_message_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (submission_id, part_index)
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_submission_parts_submission
        ON submission_parts (submission_id)
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS seen_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_url TEXT NOT NULL,
            title TEXT,
            article_date TEXT,
            first_seen_at TEXT NOT NULL
        )
      `);
      ensureColumn(db, "seen_sources", "article_date", "TEXT");
      // Why an item was recorded as seen: "queued" (a draft reached moderation)
      // or "duplicate" (another source had already told the same story). Rows
      // written before this column existed stay NULL and are reported as unknown.
      ensureColumn(db, "seen_sources", "outcome", "TEXT");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_sources_source
        ON seen_sources (source_type, source_id)
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_edit_states (
            admin_id INTEGER PRIMARY KEY,
            submission_id INTEGER NOT NULL,
            mode TEXT NOT NULL DEFAULT 'edit',
            part_index INTEGER,
            draft_message_id INTEGER,
            created_at TEXT NOT NULL
        )
      `);
      ensureColumn(db, "admin_edit_states", "mode", "TEXT NOT NULL DEFAULT 'edit'");
      ensureColumn(db, "admin_edit_states", "part_index", "INTEGER");
      ensureColumn(db, "admin_edit_states", "draft_message_id", "INTEGER");
      db.exec(`
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS submission_tags (
            submission_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (submission_id, tag_id)
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_submission_tags_submission
        ON submission_tags (submission_id)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_submission_tags_tag
        ON submission_tags (tag_id)
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS telegram_warnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            moderator_id INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_telegram_warnings_chat_user
        ON telegram_warnings (chat_id, user_id)
      `);
      assertWritable(db, this.path);
    } finally {
      db.close();
    }
  }

  async createSubmission({ user_id, username, message_type, original_text, file_id }) {
    const now = utcNowIso();
    const draftText = original_text || "";

    return this.#transaction((db) => {
      const cursor = db
        .prepare(
          `
          INSERT INTO submissions (
              user_id,
              username,
              message_type,
              original_text,
              draft_text,
              file_id,
              status,
              created_at,
              updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          user_id,
          username ?? null,
          message_type,
          original_text ?? null,
          draftText,
          file_id ?? null,
          STATUS_PENDING,
          now,
          now,
        );
      const submissionId = Number(cursor.lastInsertRowid);
      replaceSubmissionParts(
        db,
        submissionId,
        [
          {
            message_type,
            text: draftText,
            file_id: file_id ?? null,
            media_url: null,
            media_type: mediaTypeFor(message_type),
          },
        ],
        now,
      );
      return submissionId;
    });
  }

  /**
   * One album submission from a reader's own media group.
   *
   * Telegram delivers an album as separate messages that only share a
   * `media_group_id`, so the handler regroups them and stores ONE submission with
   * a part per item — otherwise five photos became five queue entries and five
   * single-photo posts. Items carry a `file_id` (Telegram already holds the file)
   * and their own `media_type`, so a photo-and-video album survives as one post.
   */
  async createUserAlbumSubmission({ user_id, username, original_text, items }) {
    const albumItems = [];
    const seen = new Set();
    for (const item of items ?? []) {
      const fileId = String(item?.file_id ?? "").trim();
      if (!fileId || seen.has(fileId)) continue;
      seen.add(fileId);
      albumItems.push({ file_id: fileId, media_type: String(item?.media_type ?? "photo") });
      if (albumItems.length >= 10) break; // Telegram's media-group maximum
    }
    if (!albumItems.length) {
      throw new Error("album submission requires at least one media item");
    }

    const now = utcNowIso();
    const caption = String(original_text ?? "").trim();

    return this.#transaction((db) => {
      const cursor = db
        .prepare(
          `
          INSERT INTO submissions (
              user_id, username, message_type, original_text, draft_text,
              file_id, media_type, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          user_id,
          username ?? null,
          "album",
          caption || null,
          caption,
          albumItems[0].file_id,
          albumItems[0].media_type,
          STATUS_PENDING,
          now,
          now,
        );
      const submissionId = Number(cursor.lastInsertRowid);
      replaceSubmissionParts(
        db,
        submissionId,
        albumItems.map((item, position) => ({
          message_type: "album",
          text: position === 0 ? caption : "",
          file_id: item.file_id,
          media_url: null,
          media_type: item.media_type,
        })),
        now,
      );
      return submissionId;
    });
  }

  async createAiNewsSubmission({
    username,
    original_text,
    draft_text,
    message_type,
    media_url,
    media_type,
    source_type,
    source_id,
    source_url,
    article_date,
    article_date_display,
    tags = null,
    draft_parts = null,
    additional_media_urls = null,
  }) {
    const now = utcNowIso();
    const normalizedDraftParts = normalizeTextParts(draft_parts ?? [draft_text]);
    const storedDraftText = partsToDraftText(normalizedDraftParts);
    const mediaUrls = normalizeMediaUrls(media_url, additional_media_urls ?? [], media_type);
    const primaryMediaUrl = mediaUrls.length ? mediaUrls[0] : null;
    const storedMediaType = primaryMediaUrl ? media_type : "none";
    const storedMessageType = primaryMediaUrl ? message_type : "text";

    return this.#transaction((db) => {
      const cursor = db
        .prepare(
          `
          INSERT INTO submissions (
              user_id,
              username,
              message_type,
              original_text,
              draft_text,
              file_id,
              media_url,
              media_type,
              source_url,
              source_type,
              source_id,
              article_date,
              article_date_display,
              status,
              created_at,
              updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          0,
          username,
          storedMessageType,
          original_text,
          storedDraftText,
          null,
          primaryMediaUrl,
          storedMediaType,
          source_url,
          source_type,
          source_id,
          article_date ?? null,
          article_date_display ?? null,
          STATUS_PENDING,
          now,
          now,
        );
      const submissionId = Number(cursor.lastInsertRowid);
      const partRows = [];
      normalizedDraftParts.forEach((partText, position) => {
        const index = position + 1;
        const partMediaUrl = index <= mediaUrls.length ? mediaUrls[index - 1] : null;
        const hasPartMedia = Boolean(partMediaUrl) && storedMediaType !== "none";
        const partMessageType = hasPartMedia ? storedMessageType : "text";
        partRows.push({
          message_type: partMessageType,
          text: partText,
          file_id: null,
          media_url: hasPartMedia ? partMediaUrl : null,
          media_type: hasPartMedia ? storedMediaType : "none",
        });
      });
      replaceSubmissionParts(db, submissionId, partRows, now);
      setSubmissionTags(db, submissionId, tags ?? [], now);
      return submissionId;
    });
  }

  /**
   * Create one `album` submission: a media group of up to 10 images plus a
   * single caption (stored on the first part), published as one grouped post.
   *
   * Unlike createAiNewsSubmission this keeps EVERY image (one per part) — the
   * 4-image / per-text-part cap there is wrong for a digest album.
   */
  async createAlbumSubmission({
    username,
    original_text,
    caption,
    image_urls,
    source_type,
    source_id,
    source_url,
    article_date = null,
    article_date_display = null,
    tags = null,
  }) {
    const now = utcNowIso();
    const images = [];
    const seen = new Set();
    for (const value of image_urls) {
      const url = String(value ?? "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      images.push(url);
      if (images.length >= 10) break;
    }
    if (!images.length) {
      throw new Error("album submission requires at least one image URL");
    }
    const trimmedCaption = caption.trim();

    return this.#transaction((db) => {
      const cursor = db
        .prepare(
          `
          INSERT INTO submissions (
              user_id, username, message_type, original_text, draft_text,
              file_id, media_url, media_type, source_url, source_type, source_id,
              article_date, article_date_display, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          0,
          username,
          "album",
          original_text,
          trimmedCaption,
          null,
          images[0],
          "photo",
          source_url,
          source_type,
          source_id,
          article_date ?? null,
          article_date_display ?? null,
          STATUS_PENDING,
          now,
          now,
        );
      const submissionId = Number(cursor.lastInsertRowid);
      const partRows = images.map((imageUrl, position) => ({
        message_type: "album",
        text: position === 0 ? trimmedCaption : "",
        file_id: null,
        media_url: imageUrl,
        media_type: "photo",
      }));
      replaceSubmissionParts(db, submissionId, partRows, now);
      setSubmissionTags(db, submissionId, tags ?? [], now);
      return submissionId;
    });
  }

  async setAdminMessageId(submissionId, adminMessageId) {
    await this.#execute(
      `
      UPDATE submissions
      SET admin_message_id = ?, updated_at = ?
      WHERE id = ?
      `,
      [adminMessageId, utcNowIso(), submissionId],
    );
  }

  async setAdminMediaMessageId(submissionId, adminMediaMessageId) {
    await this.#execute(
      `
      UPDATE submissions
      SET admin_media_message_id = ?, updated_at = ?
      WHERE id = ?
      `,
      [adminMediaMessageId ?? null, utcNowIso(), submissionId],
    );
  }

  async getSubmission(submissionId) {
    return this.#connect((db) => {
      const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(submissionId);
      if (row === undefined) {
        return null;
      }

      const submission = { ...row };
      submission.tags = getSubmissionTags(db, submissionId);
      submission.parts = getSubmissionParts(db, submission);
      return submission;
    });
  }

  async getLatestUserSubmission(userId) {
    return this.#connect((db) => {
      const row = db
        .prepare(
          `
          SELECT *
          FROM submissions
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        )
        .get(userId);
      return row === undefined ? null : { ...row };
    });
  }

  async isSourceSeen(sourceType, sourceId) {
    return this.#connect((db) => {
      const row = db
        .prepare(
          `
          SELECT 1
          FROM seen_sources
          WHERE source_type = ? AND source_id = ?
          LIMIT 1
        `,
        )
        .get(sourceType, sourceId);
      return row !== undefined;
    });
  }

  async markSourceSeen({ source_type, source_id, source_url, title, article_date, outcome = null }) {
    await this.#execute(
      `
      INSERT OR IGNORE INTO seen_sources (
          source_type,
          source_id,
          source_url,
          title,
          article_date,
          outcome,
          first_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [source_type, source_id, source_url, title ?? null, article_date ?? null, outcome, utcNowIso()],
    );
  }

  /**
   * What every source did since `since`, for the weekly report and /stats.
   *
   * Two tables answer different halves of the question. `seen_sources` knows what
   * was FOUND, including the items dropped as cross-source duplicates, which
   * never become submissions. `submissions` knows what happened after: queued,
   * published, rejected. The pending backlog is deliberately not time-bounded —
   * a draft waiting three weeks is exactly what the report should surface.
   */
  async collectActivity({ since }) {
    return this.#connect((db) => {
      const seen = db
        .prepare(
          `
          SELECT source_type, COALESCE(outcome, 'unknown') AS outcome, COUNT(*) AS total
          FROM seen_sources
          WHERE first_seen_at >= ?
          GROUP BY source_type, outcome
          `,
        )
        .all(since);
      const submissions = db
        .prepare(
          `
          SELECT COALESCE(source_type, '') AS source_type, status, COUNT(*) AS total
          FROM submissions
          WHERE created_at >= ?
          GROUP BY COALESCE(source_type, ''), status
          `,
        )
        .all(since);
      const backlog = db
        .prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS oldest FROM submissions WHERE status = ?`)
        .get(STATUS_PENDING);

      return {
        seen: seen.map((row) => ({
          source_type: String(row.source_type),
          outcome: String(row.outcome),
          total: Number(row.total),
        })),
        submissions: submissions.map((row) => ({
          source_type: String(row.source_type),
          status: String(row.status),
          total: Number(row.total),
        })),
        pending_total: Number(backlog?.total ?? 0),
        pending_oldest: backlog?.oldest ? String(backlog.oldest) : null,
      };
    });
  }

  async getLatestSeenArticleDate(sourceType) {
    return this.#connect((db) => {
      const row = db
        .prepare(
          `
          SELECT article_date
          FROM seen_sources
          WHERE source_type = ? AND article_date IS NOT NULL AND article_date != ''
          ORDER BY article_date DESC
          LIMIT 1
        `,
        )
        .get(sourceType);
      return row === undefined ? null : String(row.article_date);
    });
  }

  /**
   * Return distinct recently-seen titles, newest first, for cross-source dedup.
   *
   * The returned titles are compared against a new candidate's title. Identical
   * titles are collapsed and ordered by their most recent sighting; `limit` caps
   * the result so the comparison prompt stays bounded (`limit <= 0` returns
   * nothing). Pass `excludeSourceType` to omit a source's own titles — so a
   * candidate is only ever compared against OTHER sources, which is a no-op (and
   * thus harmless) while a single source is configured.
   */
  async getRecentSeenTitles({ limit, exclude_source_type = null }) {
    if (limit <= 0) {
      return [];
    }
    const conditions = ["title IS NOT NULL", "title != ''"];
    const params = [];
    if (exclude_source_type !== null && exclude_source_type !== undefined) {
      conditions.push("source_type != ?");
      params.push(exclude_source_type);
    }
    params.push(limit);
    return this.#connect((db) => {
      const rows = db
        .prepare(
          `
          SELECT title, MAX(first_seen_at) AS last_seen
          FROM seen_sources
          WHERE ${conditions.join(" AND ")}
          GROUP BY title
          ORDER BY last_seen DESC
          LIMIT ?
        `,
        )
        .all(...params);
      return rows.map((row) => String(row.title));
    });
  }

  async setSubmissionTags(submissionId, tagNames) {
    await this.#transaction((db) => {
      setSubmissionTags(db, submissionId, tagNames, utcNowIso());
    });
  }

  async getSubmissionTags(submissionId) {
    return this.#connect((db) => getSubmissionTags(db, submissionId));
  }

  async getAllTags() {
    return this.#connect((db) => {
      const rows = db
        .prepare(
          `
          SELECT name
          FROM tags
          ORDER BY name
        `,
        )
        .all();
      return rows.map((row) => String(row.name));
    });
  }

  async updateDraftText(submissionId, draftText) {
    const now = utcNowIso();
    await this.#transaction((db) => {
      db.prepare(
        `
        UPDATE submissions
        SET draft_text = ?, updated_at = ?
        WHERE id = ?
        `,
      ).run(draftText, now, submissionId);
      replaceSubmissionParts(
        db,
        submissionId,
        [
          {
            message_type: "text",
            text: draftText,
            file_id: null,
            media_url: null,
            media_type: "none",
          },
        ],
        now,
      );
    });
  }

  async getSubmissionPart(submissionId, partIndex) {
    const submission = await this.getSubmission(submissionId);
    if (submission === null) {
      return null;
    }

    for (const part of submission.parts ?? []) {
      if (Number(part.part_index) === partIndex) {
        return part;
      }
    }

    return null;
  }

  async setSubmissionPartAdminMessageId(submissionId, partIndex, adminMessageId) {
    await this.#execute(
      `
      UPDATE submission_parts
      SET admin_message_id = ?, updated_at = ?
      WHERE submission_id = ? AND part_index = ?
      `,
      [adminMessageId, utcNowIso(), submissionId, partIndex],
    );
  }

  async addSubmissionPart(submissionId, { message_type, text, file_id, media_url, media_type, admin_message_id }) {
    const now = utcNowIso();
    return this.#transaction((db) => {
      const row = db
        .prepare(
          `
          SELECT COALESCE(MAX(part_index), 0) + 1 AS next_part_index
          FROM submission_parts
          WHERE submission_id = ?
        `,
        )
        .get(submissionId);
      const partIndex = row !== undefined ? Number(row.next_part_index) : 1;
      db.prepare(
        `
        INSERT INTO submission_parts (
            submission_id,
            part_index,
            message_type,
            text,
            file_id,
            media_url,
            media_type,
            admin_message_id,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        submissionId,
        partIndex,
        message_type,
        text,
        file_id ?? null,
        media_url ?? null,
        media_type || mediaTypeFor(message_type),
        admin_message_id ?? null,
        now,
        now,
      );
      syncSubmissionDraftText(db, submissionId, now);
      return partIndex;
    });
  }

  async updateSubmissionPartText(submissionId, partIndex, text) {
    const now = utcNowIso();
    await this.#transaction((db) => {
      db.prepare(
        `
        UPDATE submission_parts
        SET text = ?, updated_at = ?
        WHERE submission_id = ? AND part_index = ?
        `,
      ).run(text, now, submissionId, partIndex);
      syncSubmissionDraftText(db, submissionId, now);
    });
  }

  async updateSubmissionContent(submissionId, { message_type, draft_text, file_id, admin_media_message_id }) {
    const now = utcNowIso();
    await this.#transaction((db) => {
      db.prepare(
        `
        UPDATE submissions
        SET message_type = ?,
            draft_text = ?,
            file_id = ?,
            admin_media_message_id = ?,
            media_url = NULL,
            media_type = ?,
            updated_at = ?
        WHERE id = ?
        `,
      ).run(
        message_type,
        draft_text,
        file_id ?? null,
        admin_media_message_id ?? null,
        message_type,
        now,
        submissionId,
      );
      replaceSubmissionParts(
        db,
        submissionId,
        [
          {
            message_type,
            text: draft_text,
            file_id: file_id ?? null,
            media_url: null,
            media_type: mediaTypeFor(message_type),
            admin_message_id: ["photo", "video", "document"].includes(message_type)
              ? (admin_media_message_id ?? null)
              : null,
          },
        ],
        now,
      );
    });
  }

  async markPublished(submissionId) {
    const now = utcNowIso();
    await this.#execute(
      `
      UPDATE submissions
      SET status = ?, updated_at = ?, published_at = ?
      WHERE id = ?
      `,
      [STATUS_PUBLISHED, now, now, submissionId],
    );
  }

  async markRejected(submissionId) {
    await this.#execute(
      `
      UPDATE submissions
      SET status = ?, updated_at = ?
      WHERE id = ?
      `,
      [STATUS_REJECTED, utcNowIso(), submissionId],
    );
  }

  async setAdminEditState(adminId, submissionId, { mode = "edit", part_index = null, draft_message_id = null } = {}) {
    await this.#execute(
      `
      INSERT OR REPLACE INTO admin_edit_states (
          admin_id,
          submission_id,
          mode,
          part_index,
          draft_message_id,
          created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [adminId, submissionId, mode, part_index, draft_message_id, utcNowIso()],
    );
  }

  async getAdminEditState(adminId) {
    return this.#connect((db) => {
      const row = db.prepare("SELECT * FROM admin_edit_states WHERE admin_id = ?").get(adminId);
      return row === undefined ? null : { ...row };
    });
  }

  async getLatestAdminEditState() {
    return this.#connect((db) => {
      const row = db
        .prepare(
          `
          SELECT *
          FROM admin_edit_states
          ORDER BY created_at DESC
          LIMIT 1
        `,
        )
        .get();
      return row === undefined ? null : { ...row };
    });
  }

  async clearAdminEditState(adminId) {
    await this.#execute("DELETE FROM admin_edit_states WHERE admin_id = ?", [adminId]);
  }

  /** Insert a Telegram chat warning and return the active count for that member. */
  async addTelegramWarning({ chat_id, user_id, moderator_id, reason }) {
    const now = utcNowIso();
    return this.#connect((db) => {
      db.prepare(
        `
        INSERT INTO telegram_warnings (chat_id, user_id, moderator_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
        `,
      ).run(chat_id, user_id, moderator_id, reason, now);
      const row = db
        .prepare("SELECT COUNT(*) AS total FROM telegram_warnings WHERE chat_id = ? AND user_id = ?")
        .get(chat_id, user_id);
      return row !== undefined ? Number(row.total) : 0;
    });
  }

  async listTelegramWarnings({ chat_id, user_id }) {
    return this.#connect((db) => {
      const rows = db
        .prepare(
          `
          SELECT moderator_id, reason, created_at
          FROM telegram_warnings
          WHERE chat_id = ? AND user_id = ?
          ORDER BY id ASC
        `,
        )
        .all(chat_id, user_id);
      return rows.map((row) => ({ ...row }));
    });
  }

  async clearTelegramWarnings({ chat_id, user_id }) {
    return this.#connect((db) => {
      const cursor = db
        .prepare("DELETE FROM telegram_warnings WHERE chat_id = ? AND user_id = ?")
        .run(chat_id, user_id);
      return Number(cursor.changes ?? 0);
    });
  }

  /** Every submission in the database, grouped by status. */
  async countSubmissionsByStatus() {
    return this.#connect((db) => {
      const rows = db.prepare("SELECT status, COUNT(*) AS total FROM submissions GROUP BY status").all();
      const counts = {};
      for (const row of rows) {
        counts[String(row.status)] = Number(row.total);
      }
      return counts;
    });
  }

  /**
   * How many submissions are older than the cutoff and eligible for cleanup.
   *
   * By default only `published` and `rejected` rows count: a pending submission
   * is still waiting for a decision. `includePending` widens it to every status,
   * for wiping a queue of abandoned drafts.
   */
  async countProcessedSubmissions({ older_than_days, include_pending = false }) {
    const cutoff = cleanupCutoff(older_than_days);
    const statuses = cleanupStatuses(include_pending);
    const placeholders = statuses.map(() => "?").join(",");
    return this.#connect((db) => {
      const row = db
        .prepare(
          `
          SELECT COUNT(*) AS total
          FROM submissions
          WHERE status IN (${placeholders}) AND updated_at < ?
        `,
        )
        .get(...statuses, cutoff);
      return row !== undefined ? Number(row.total) : 0;
    });
  }

  /**
   * Delete eligible submissions older than the cutoff, with their parts and tag
   * links. Returns how many submissions were removed.
   *
   * `seen_sources` is deliberately untouched: it is what stops a source from
   * re-queueing news the channel has already handled, so clearing it here would
   * flood the moderation chat with old items.
   */
  async deleteProcessedSubmissions({ older_than_days, include_pending = false }) {
    const cutoff = cleanupCutoff(older_than_days);
    const statuses = cleanupStatuses(include_pending);
    const statusPlaceholders = statuses.map(() => "?").join(",");
    return this.#transaction((db) => {
      const rows = db
        .prepare(
          `
          SELECT id FROM submissions
          WHERE status IN (${statusPlaceholders}) AND updated_at < ?
        `,
        )
        .all(...statuses, cutoff);
      const ids = rows.map((row) => Number(row.id));
      if (!ids.length) {
        return 0;
      }

      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM submission_tags WHERE submission_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM submission_parts WHERE submission_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM submissions WHERE id IN (${placeholders})`).run(...ids);
      // Tag rows are shared between submissions, so only drop the ones no
      // remaining submission points at.
      db.exec(`
        DELETE FROM tags
        WHERE id NOT IN (SELECT DISTINCT tag_id FROM submission_tags)
      `);
      return ids.length;
    });
  }

  /**
   * Reclaim the space freed by a delete — SQLite does not shrink the file on its
   * own, so without this a cleanup frees nothing on disk.
   */
  async vacuum() {
    await this.#connect((db) => {
      db.exec("VACUUM");
    });
  }

  sizeBytes() {
    try {
      return fs.statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  #connect(work) {
    const db = openConnection(this.path);
    try {
      return work(db);
    } finally {
      db.close();
    }
  }

  /**
   * Run `work` inside one transaction, mirroring the Python methods that queued
   * several statements before a single `db.commit()`. A throw rolls the whole
   * batch back rather than leaving, say, a submission row with no parts.
   */
  #transaction(work) {
    return this.#connect((db) => {
      db.exec("BEGIN");
      try {
        const result = work(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction was already unwound; the original error is what matters.
        }
        throw error;
      }
    });
  }

  #execute(query, params) {
    return this.#connect((db) => {
      db.prepare(query).run(...params);
    });
  }
}

function ensureColumn(db, tableName, columnName, columnType) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}

function setSubmissionTags(db, submissionId, tagNames, now) {
  const normalizedTags = normalizeTagNames(tagNames);
  db.prepare("DELETE FROM submission_tags WHERE submission_id = ?").run(submissionId);
  for (const tagName of normalizedTags) {
    db.prepare(
      `
      INSERT OR IGNORE INTO tags (name, created_at)
      VALUES (?, ?)
      `,
    ).run(tagName, now);
    const row = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName);
    if (row === undefined) {
      continue;
    }

    db.prepare(
      `
      INSERT OR IGNORE INTO submission_tags (submission_id, tag_id, created_at)
      VALUES (?, ?, ?)
      `,
    ).run(submissionId, Number(row.id), now);
  }
}

function getSubmissionTags(db, submissionId) {
  const rows = db
    .prepare(
      `
      SELECT tags.name
      FROM submission_tags
      JOIN tags ON tags.id = submission_tags.tag_id
      WHERE submission_tags.submission_id = ?
      ORDER BY tags.name
    `,
    )
    .all(submissionId);
  return rows.map((row) => String(row.name));
}

function replaceSubmissionParts(db, submissionId, parts, now) {
  db.prepare("DELETE FROM submission_parts WHERE submission_id = ?").run(submissionId);
  parts.forEach((part, position) => {
    const messageType = String(part.message_type || "text");
    db.prepare(
      `
      INSERT INTO submission_parts (
          submission_id,
          part_index,
          message_type,
          text,
          file_id,
          media_url,
          media_type,
          admin_message_id,
          created_at,
          updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      submissionId,
      position + 1,
      messageType,
      String(part.text || ""),
      part.file_id ?? null,
      part.media_url ?? null,
      part.media_type || mediaTypeFor(messageType),
      part.admin_message_id ?? null,
      now,
      now,
    );
  });
}

function getSubmissionParts(db, submission) {
  const submissionId = Number(submission.id);
  const rows = db
    .prepare(
      `
      SELECT *
      FROM submission_parts
      WHERE submission_id = ?
      ORDER BY part_index
    `,
    )
    .all(submissionId);
  if (rows.length) {
    const parts = rows.map((row) => ({ ...row }));
    for (const part of parts) {
      part.admin_media_message_id = adminMediaMessageIdForPart(part, submission);
      part.source_url = submission.source_url ?? null;
      part.source_type = submission.source_type ?? null;
    }
    return parts;
  }

  return [fallbackSubmissionPart(submission)];
}

function syncSubmissionDraftText(db, submissionId, now) {
  const rows = db
    .prepare(
      `
      SELECT text
      FROM submission_parts
      WHERE submission_id = ?
      ORDER BY part_index
    `,
    )
    .all(submissionId);
  const draftText = partsToDraftText(rows.map((row) => String(row.text ?? "")));
  db.prepare(
    `
    UPDATE submissions
    SET draft_text = ?, updated_at = ?
    WHERE id = ?
    `,
  ).run(draftText, now, submissionId);
}

export { utcNowIso as utcNow };

function cleanupStatuses(includePending) {
  if (includePending) {
    return [STATUS_PUBLISHED, STATUS_REJECTED, STATUS_PENDING];
  }
  return [STATUS_PUBLISHED, STATUS_REJECTED];
}

/**
 * Timestamps older than this are eligible for cleanup.
 * `0` means "everything already processed", so the cutoff is now.
 */
function cleanupCutoff(olderThanDays) {
  const days = Math.max(0, olderThanDays);
  return utcIsoSeconds(Date.now() - days * 24 * 60 * 60 * 1000);
}

function normalizeTagNames(tagNames) {
  const normalizedTags = [];
  const seen = new Set();
  for (const tagName of tagNames) {
    let normalized = collapseWhitespace(String(tagName).trim().toLowerCase());
    normalized = strip(normalized, "#,.;:!?'\"()[]{}");
    if (!normalized || seen.has(normalized) || normalized.length > 40) {
      continue;
    }

    seen.add(normalized);
    normalizedTags.push(normalized);

    if (normalizedTags.length >= 12) {
      break;
    }
  }

  return normalizedTags;
}

function normalizeTextParts(parts) {
  const normalized = parts.map((part) => String(part ?? "").trim()).filter(Boolean);
  return normalized.length ? normalized : [""];
}

function partsToDraftText(parts) {
  return parts.filter(Boolean).join("\n\n").trim();
}

function normalizeMediaUrls(primaryMediaUrl, additionalMediaUrls, mediaType) {
  if (mediaType === "none") {
    return [];
  }

  const normalizedUrls = [];
  const seen = new Set();
  for (const value of [primaryMediaUrl, ...additionalMediaUrls]) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedUrls.push(normalized);

    if (normalizedUrls.length >= 4) {
      break;
    }
  }

  return normalizedUrls;
}

function mediaTypeFor(messageType) {
  return ["photo", "video", "document"].includes(messageType) ? messageType : "none";
}

function adminMediaMessageIdForPart(part, submission) {
  const messageType = String(part.message_type || "text");
  if (!["photo", "video", "document"].includes(messageType)) {
    return null;
  }

  if (Number(part.part_index || 0) === 1) {
    return submission.admin_media_message_id ?? null;
  }

  return part.admin_message_id ?? null;
}

function fallbackSubmissionPart(submission) {
  const messageType = String(submission.message_type || "text");
  return {
    submission_id: Number(submission.id),
    part_index: 1,
    message_type: messageType,
    text: String(submission.draft_text || submission.original_text || ""),
    file_id: submission.file_id ?? null,
    media_url: submission.media_url ?? null,
    media_type: submission.media_type || mediaTypeFor(messageType),
    admin_message_id: submission.admin_media_message_id ?? null,
    admin_media_message_id: submission.admin_media_message_id ?? null,
    source_url: submission.source_url ?? null,
    source_type: submission.source_type ?? null,
    created_at: submission.created_at ?? null,
    updated_at: submission.updated_at ?? null,
  };
}
