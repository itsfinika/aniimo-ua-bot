import { t } from "./services/i18n.js";

/**
 * aiogram-compatible callback-data packing.
 *
 * aiogram's `CallbackData` serialised a factory as `prefix:field1:field2`. That
 * format is reproduced byte-for-byte here on purpose: moderation messages
 * already sitting in the admin chat carry callback data written by the Python
 * version, and Telegram keeps those buttons alive indefinitely. A different
 * encoding would leave every pending draft with dead Approve/Edit/Reject buttons
 * after the switch-over.
 */
const SEPARATOR = ":";

function callbackFactory(prefix, fields) {
  return {
    prefix,
    fields,
    /** Serialise `values` (keyed by field name) into callback data. */
    pack(values) {
      const parts = fields.map((field) => {
        const value = values[field];
        if (value === null || value === undefined) return "";
        if (typeof value === "boolean") return value ? "1" : "0";
        return String(value);
      });
      return [prefix, ...parts].join(SEPARATOR);
    },
    /** Parse callback data, or return null when it belongs to another factory. */
    unpack(data) {
      const parts = String(data ?? "").split(SEPARATOR);
      if (parts.length !== fields.length + 1 || parts[0] !== prefix) {
        return null;
      }
      const values = {};
      fields.forEach((field, index) => {
        values[field] = parts[index + 1];
      });
      return values;
    },
  };
}

export const ModerationCallback = callbackFactory("submission", ["action", "submission_id"]);
export const ModerationPartCallback = callbackFactory("submission_part", [
  "action",
  "submission_id",
  "part_index",
]);
export const CollectorCallback = callbackFactory("collector", ["collector_id"]);
/**
 * Source picker for /redraft. It gets its OWN prefix rather than a `force` field
 * on CollectorCallback: `unpack` requires an exact field count, so widening the
 * collector callback would break every /fetch_news keyboard already sitting in
 * the admin chat from before the deploy.
 */
export const RedraftCallback = callbackFactory("recollect", ["collector_id"]);
/**
 * Inline moderation action on a mod-log entry (Telegram chat moderation).
 *
 * action: "del" | "mute" | "ban"; chat_id: the moderated chat the offence
 * happened in; user_id: the offending member; message_id: the offending message
 * to delete, 0 when it is already gone.
 */
export const ModLogActionCallback = callbackFactory("modact", [
  "action",
  "chat_id",
  "user_id",
  "message_id",
]);

/** Parse the integer fields aiogram's typed CallbackData produced. */
export function unpackModerationCallback(data) {
  const values = ModerationCallback.unpack(data);
  if (values === null) return null;
  const submissionId = toInt(values.submission_id);
  if (submissionId === null) return null;
  return { action: values.action, submission_id: submissionId };
}

export function unpackModerationPartCallback(data) {
  const values = ModerationPartCallback.unpack(data);
  if (values === null) return null;
  const submissionId = toInt(values.submission_id);
  const partIndex = toInt(values.part_index);
  if (submissionId === null || partIndex === null) return null;
  return { action: values.action, submission_id: submissionId, part_index: partIndex };
}

export function unpackCollectorCallback(data) {
  const values = CollectorCallback.unpack(data);
  if (values === null) return null;
  return { collector_id: values.collector_id };
}

export function unpackRedraftCallback(data) {
  const values = RedraftCallback.unpack(data);
  if (values === null) return null;
  return { collector_id: values.collector_id };
}

export function unpackModLogActionCallback(data) {
  const values = ModLogActionCallback.unpack(data);
  if (values === null) return null;
  const chatId = toInt(values.chat_id);
  const userId = toInt(values.user_id);
  const messageId = toInt(values.message_id);
  if (chatId === null || userId === null || messageId === null) return null;
  return { action: values.action, chat_id: chatId, user_id: userId, message_id: messageId };
}

function toInt(value) {
  if (!/^[+-]?\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function moderationKeyboard(submissionId) {
  return {
    inline_keyboard: [
      [
        button(t("buttons.approve"), ModerationCallback.pack({ action: "approve", submission_id: submissionId })),
        button(t("buttons.edit"), ModerationCallback.pack({ action: "edit", submission_id: submissionId })),
        button(t("buttons.reject"), ModerationCallback.pack({ action: "reject", submission_id: submissionId })),
      ],
    ],
  };
}

export function editPartKeyboard(submissionId, partCount) {
  const rows = [];
  let row = [];
  for (let partIndex = 1; partIndex <= partCount; partIndex += 1) {
    row.push(
      button(
        t("buttons.edit_part", { part_index: partIndex }),
        ModerationPartCallback.pack({
          action: "select",
          submission_id: submissionId,
          part_index: partIndex,
        }),
      ),
    );
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }

  if (row.length) {
    rows.push(row);
  }

  rows.push([
    button(
      t("buttons.add_part"),
      ModerationPartCallback.pack({ action: "add", submission_id: submissionId, part_index: 0 }),
    ),
  ]);
  return { inline_keyboard: rows };
}

export function saveDraftKeyboard(submissionId, partIndex) {
  return {
    inline_keyboard: [
      [
        button(
          t("buttons.save"),
          ModerationPartCallback.pack({
            action: "save",
            submission_id: submissionId,
            part_index: partIndex,
          }),
        ),
      ],
    ],
  };
}

/**
 * Inline actions under a mod-log entry: delete / mute / ban the offender.
 *
 * The delete button is included only when a message_id is known (e.g. a reported
 * message that still exists); auto-filter entries pass 0 because the offending
 * message has already been removed.
 */
export function modLogActionKeyboard(chatId, userId, messageId = 0) {
  const row = [];
  if (messageId) {
    row.push(
      button(
        t("buttons.modlog_delete"),
        ModLogActionCallback.pack({ action: "del", chat_id: chatId, user_id: userId, message_id: messageId }),
      ),
    );
  }
  row.push(
    button(
      t("buttons.modlog_mute"),
      ModLogActionCallback.pack({ action: "mute", chat_id: chatId, user_id: userId, message_id: 0 }),
    ),
  );
  row.push(
    button(
      t("buttons.modlog_ban"),
      ModLogActionCallback.pack({ action: "ban", chat_id: chatId, user_id: userId, message_id: 0 }),
    ),
  );
  return { inline_keyboard: [row] };
}

export function collectorSourceKeyboard(collectors) {
  return {
    inline_keyboard: collectors.map((collector) => [
      button(collector.button_text, CollectorCallback.pack({ collector_id: collector.collector_id })),
    ]),
  };
}

export function redraftSourceKeyboard(collectors) {
  return {
    inline_keyboard: collectors.map((collector) => [
      button(collector.button_text, RedraftCallback.pack({ collector_id: collector.collector_id })),
    ]),
  };
}

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}
