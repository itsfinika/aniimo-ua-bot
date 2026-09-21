import { t } from "../i18n.js";

/**
 * `FORCE_LATEST` re-drafts the newest listing item even though it is already in
 * `seen_sources`. It exists because a source that has been running for a while
 * has nothing new by definition, which leaves no way to check the pipeline
 * end-to-end after a change — /cleanup deliberately never clears `seen_sources`,
 * since that would re-queue every old article at once. It drafts exactly ONE
 * item and adds nothing to `seen_sources` that is not there already.
 */
export const CollectionMode = Object.freeze({
  MANUAL_LATEST: "manual_latest",
  SCHEDULED_SINCE_LAST: "scheduled_since_last",
  FORCE_LATEST: "force_latest",
});

/**
 * A collector's identity and UI copy.
 *
 * `title` and `button_text` are getters because the Python dataclass exposed
 * them as properties resolved through `t()` at access time — building them
 * eagerly would freeze the translations at import order instead.
 */
export function collectorDefinition({ collector_id, source_type, title_key, button_key }) {
  return Object.freeze({
    collector_id,
    source_type,
    title_key,
    button_key,
    get title() {
      return t(title_key);
    },
    get button_text() {
      return t(button_key);
    },
  });
}

export function collectionStats({ collector_id, source_type, source_title }) {
  return {
    collector_id,
    source_type,
    source_title,
    found: 0,
    duplicates: 0,
    new: 0,
    drafts_created: 0,
    sent_to_moderation: 0,
    failed: 0,
    errors: [],
  };
}

/**
 * A lightweight listing entry produced before the full article is fetched.
 *
 * `dedup_key` is the source-scoped identifier used for the first `isSourceSeen`
 * check; `payload` carries the source-specific summary object that `parseEntry`
 * needs to fetch and parse the full item.
 */
export function listingEntry(dedupKey, payload = null) {
  return Object.freeze({ dedup_key: dedupKey, payload });
}

/** Normalized, source-agnostic input for one moderation submission. */
export function draftCandidate({
  source_id,
  source_url,
  title,
  body_text,
  source_name,
  username,
  original_text,
  article_date = null,
  article_date_display = null,
  has_media = false,
  media_url = null,
  media_type = "none",
  additional_media_urls = null,
}) {
  return Object.freeze({
    source_id,
    source_url,
    title,
    body_text,
    source_name,
    username,
    original_text,
    article_date,
    article_date_display,
    has_media,
    media_url,
    media_type,
    additional_media_urls,
  });
}

export function emptyStats(definition) {
  return collectionStats({
    collector_id: definition.collector_id,
    source_type: definition.source_type,
    source_title: definition.title,
  });
}

export function formatCollectionReport(stats) {
  const lines = [
    t("collector_report.completed", { source: stats.source_title }),
    "",
    t("collector_report.found", { count: stats.found }),
    t("collector_report.duplicates", { count: stats.duplicates }),
    t("collector_report.new", { count: stats.new }),
    t("collector_report.drafts_created", { count: stats.drafts_created }),
    t("collector_report.sent_to_moderation", { count: stats.sent_to_moderation }),
    t("collector_report.failed", { count: stats.failed }),
  ];

  if (stats.errors.length) {
    lines.push("");
    lines.push(t("collector_report.errors_header"));
    lines.push(...stats.errors.slice(0, 5).map((error) => `- ${error}`));
  }

  return lines.join("\n");
}

export function formatCollectionReports(statsList) {
  if (statsList.length === 1) {
    return formatCollectionReport(statsList[0]);
  }

  const reports = [t("collector_report.all_completed")];
  reports.push(...statsList.map((stats) => formatCollectionReport(stats)));
  return reports.join("\n\n");
}
