/**
 * Slack export importer.
 *
 * Reads a Slack workspace export ZIP: `users.json`, `channels.json` and one
 * `<channel>/YYYY-MM-DD.json` file per day. Every message — and every reply
 * inside a thread — becomes one item, so a thread can be read on its own.
 */

import AdmZip from "adm-zip";
import { toIso } from "../core/time";
import type { ImportedItem, Importer, ImporterInput } from "./types";

const DAY_FILE = /^\d{4}-\d{2}-\d{2}$/;

/** Slack bookkeeping entries that carry no user content. */
const SYSTEM_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "bot_add",
  "bot_remove",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return asArray(value)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

/** Slack timestamps are `seconds.microseconds` strings. */
function slackTime(value: string | null): string | null {
  if (value === null) return null;
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) return null;
  return toIso(Math.round(seconds * 1_000));
}

type SlackUser = { id: string; name: string };

function userNames(root: unknown): Map<string, string> {
  const names = new Map<string, string>();
  for (const user of asRecords(root)) {
    const id = asString(user.id);
    if (id === null) continue;
    const profile = asRecord(user.profile);
    const name =
      (profile ? asString(profile.display_name) : null) ??
      asString(user.real_name) ??
      asString(user.name) ??
      id;
    names.set(id, name);
  }
  return names;
}

function channelNames(root: unknown): Map<string, string> {
  const names = new Map<string, string>();
  for (const channel of asRecords(root)) {
    const id = asString(channel.id);
    const name = asString(channel.name);
    if (id !== null && name !== null) names.set(id, name);
  }
  return names;
}

type DayFile = {
  path: string;
  channel: string;
  date: string;
  entry: ReturnType<AdmZip["getEntries"]>[number];
};

/** `general/2024-01-02.json` or `export/general/2024-01-02.json`. */
function dayFileOf(entryName: string): { channel: string; date: string } | null {
  const segments = entryName.replace(/\.json$/i, "").split("/");
  const date = segments.pop();
  const channel = segments.pop();
  if (date === undefined || channel === undefined) return null;
  if (!DAY_FILE.test(date) || channel.length === 0) return null;
  return { channel, date };
}

export const slackZipImporter: Importer = {
  id: "slack_zip",
  label: "Slack export (ZIP)",
  extensions: [".zip"],
  description: "Slack workspace export: channels, day files, threads and user names.",

  async *parse(input: ImporterInput): AsyncGenerator<ImportedItem, void, unknown> {
    const zip = new AdmZip(Buffer.from(input.bytes));
    const entries = zip.getEntries();
    const limit = input.limit ?? Number.POSITIVE_INFINITY;

    const users = new Map<string, string>();
    const channels = new Map<string, string>();
    const dayFiles: DayFile[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      const base = name.split("/").pop() ?? name;
      if (base === "users.json" || base === "channels.json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(entry.getData().toString("utf8"));
        } catch {
          continue;
        }
        if (base === "users.json") {
          for (const [id, display] of userNames(parsed)) users.set(id, display);
        } else {
          for (const [id, display] of channelNames(parsed)) channels.set(id, display);
        }
        continue;
      }
      const day = dayFileOf(name);
      if (day !== null) dayFiles.push({ path: name, channel: day.channel, date: day.date, entry });
    }

    let produced = 0;
    const seen = new Set<string>();
    for (const file of dayFiles) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.entry.getData().toString("utf8"));
      } catch {
        input.onProgress?.(`skipped unreadable ${file.path}`, { items: produced });
        continue;
      }

      const label = channels.get(file.channel) ?? file.channel;
      for (const message of asRecords(parsed)) {
        if (produced >= limit) return;
        const subtype = asString(message.subtype);
        if (subtype !== null && SYSTEM_SUBTYPES.has(subtype)) continue;
        const ts = asString(message.ts);
        if (ts === null) continue;

        const authorId = asString(message.user);
        const author = (authorId !== null ? users.get(authorId) : null) ?? asString(message.username) ?? "unknown";
        const body = asString(message.text) ?? "";
        const files = asRecords(message.files)
          .map((file) => asString(file.name) ?? asString(file.title) ?? "file")
          .filter((file): file is string => file !== null);
        const replies = asRecords(message.replies).filter((reply) => asString(reply.ts) !== null);
        if (body.trim().length === 0 && replies.length === 0 && files.length === 0) continue;

        const threadTs = asString(message.thread_ts);
        const lines = [`${author}: ${body}`.trim()];
        for (const reply of replies) {
          const replyAuthorId = asString(reply.user);
          const replyAuthor =
            (replyAuthorId !== null ? users.get(replyAuthorId) : null) ?? asString(reply.username) ?? "unknown";
          lines.push(`${replyAuthor}: ${asString(reply.text) ?? ""}`.trim());
        }

        const externalId = `${file.channel}:${ts}`;
        if (!seen.has(externalId)) {
          seen.add(externalId);
          produced += 1;
          yield {
            externalId,
            title: `#${label} ${file.date}`,
            text: lines.join("\n"),
            author,
            createdAt: slackTime(ts),
            updatedAt: null,
            mime: "text/plain",
            path: file.path,
            meta: {
              channel: label,
              channelId: file.channel,
              date: file.date,
              ts,
              threadTs,
              isReply: threadTs !== null && threadTs !== ts,
              replies: replies.length,
              files,
            },
          };
        }

        for (const reply of replies) {
          const replyTs = asString(reply.ts);
          if (replyTs === null) continue;
          const replyId = `${file.channel}:${replyTs}`;
          if (seen.has(replyId) || produced >= limit) continue;
          seen.add(replyId);
          const replyAuthorId = asString(reply.user);
          const replyAuthor =
            (replyAuthorId !== null ? users.get(replyAuthorId) : null) ?? asString(reply.username) ?? "unknown";
          produced += 1;
          yield {
            externalId: replyId,
            title: `#${label} ${file.date} (thread)`,
            text: `${replyAuthor}: ${asString(reply.text) ?? ""}`.trim(),
            author: replyAuthor,
            createdAt: slackTime(replyTs),
            updatedAt: null,
            mime: "text/plain",
            path: file.path,
            meta: {
              channel: label,
              channelId: file.channel,
              date: file.date,
              ts: replyTs,
              threadTs: ts,
              isReply: true,
              replies: 0,
              files: [],
            },
          };
        }
      }
      input.onProgress?.(`parsed ${file.path}`, { items: produced });
    }
  },
};
