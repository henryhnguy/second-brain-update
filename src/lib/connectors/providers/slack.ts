/**
 * Slack connector (read-only).
 *
 * One page of one conversation is returned per `syncPage` call. Channels come
 * from `conversations.list`, narrowed to `ctx.config.channels` (ids, names or
 * `#name`) when the user configured a subset; a channel that cannot be read
 * (never joined, archived, deleted) is logged and skipped instead of failing
 * the whole sync.
 *
 * `conversations.history` is paged *backwards*: Slack returns the newest
 * messages inside `[oldest, latest]` first, so the cursor moves `latest` down to
 * the oldest message already returned (with `inclusive=false`). Advancing
 * `oldest` instead would skip everything in between. `oldest` holds the floor —
 * the previous sync, or a 30 day lookback on the first run — and declares a
 * 60 second overlap, so the boundary message is listed again rather than lost;
 * ingest de-duplicates by `externalId`.
 *
 * Cursor: `{ channel, channelIndex, latest, floor }` (read with `cursorString`
 * and `cursorNumber`). Messages that are thread replies are skipped in the
 * history listing and arrive inside the document of their thread root, whose
 * replies are fetched with `conversations.replies` — at most
 * `MAX_REPLY_CALLS_PER_PAGE` calls per page, so one page stays bounded.
 */

import { AppError } from "../../core/errors";
import { normalizeWhitespace } from "../../core/text";
import { toIso } from "../../core/time";
import { normalizeLimit, pagedRequest, requestJson } from "../http";
import type { ConnectorDoc, HttpFetch, OAuthConfig, Provider, SyncContext, SyncCursor, SyncPage } from "../types";

const SLACK_API = "https://slack.com/api";
const DEFAULT_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const CHANNEL_PAGE_LIMIT = 200;
const MAX_CHANNEL_PAGES = 5;
const USERS_LIMIT = 200;
const REPLY_LIMIT = 20;
const MAX_REPLY_CALLS_PER_PAGE = 10;
const MAX_TITLE_CHARS = 120;
const DEFAULT_LOOKBACK_DAYS = 30;
const FLOOR_OVERLAP_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const NOISY_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_purpose",
  "channel_topic",
  "channel_archive",
  "channel_unarchive",
  "bot_add",
  "bot_remove",
]);

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
  "invalid_token",
  "missing_scope",
  "no_permission",
]);

const UNREADABLE_CHANNEL_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "ekm_access_denied",
  "thread_not_found",
]);

// Slack's v2 flow is a confidential-client flow: the client secret travels in
// the token request body, so PKCE is not enabled here.
const SLACK_OAUTH: OAuthConfig = {
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  scopes: [
    "channels:read",
    "channels:history",
    "groups:read",
    "groups:history",
    "im:read",
    "im:history",
    "mpim:read",
    "mpim:history",
    "users:read",
  ],
  pkce: false,
  tokenEndpointAuth: "body_client_secret",
  clientIdEnv: "SB_SLACK_CLIENT_ID",
  clientSecretEnv: "SB_SLACK_CLIENT_SECRET",
};

type SlackEnvelope = { ok?: boolean; error?: string };

type SlackChannel = { id?: string; name?: string; is_private?: boolean; is_member?: boolean };

type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  text?: string;
  subtype?: string;
  reply_count?: number;
  reactions?: { name?: string; count?: number }[];
  files?: { id?: string; name?: string }[];
};

type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
};

type SlackChannelList = SlackEnvelope & {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
};

type SlackHistoryPage = SlackEnvelope & {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

type SlackUserList = SlackEnvelope & { members?: SlackUser[] };

/** Everything a document needs beyond the raw message payload. */
type DocParts = { lines: string[]; author: string | null; replyCount: number; repliesFetched: number };

export const slackProvider: Provider = {
  id: "slack",
  label: "Slack",
  description: "Đồng bộ tin nhắn Slack (chỉ đọc) về bộ nhớ cá nhân.",
  category: "chat",
  docsUrl: "https://api.slack.com/methods/conversations.history",
  auth: {
    kind: "oauth2",
    oauth: SLACK_OAUTH,
    helpUrl: "https://api.slack.com/apps",
  },
  defaultConfig: { channels: [] },
  initialLookbackDays: DEFAULT_LOOKBACK_DAYS,
  syncPage,
};

/** One page of one conversation, plus where the next run should resume. */
async function syncPage(ctx: SyncContext): Promise<SyncPage> {
  const limit = normalizeLimit(ctx.limit, DEFAULT_LIMIT, MAX_HISTORY_LIMIT);
  const channels = await resolveChannels(ctx);
  const index = cursorNumber(ctx, "channelIndex") ?? 0;
  const pinned = cursorString(ctx, "channel");

  let channel = pinned === null ? channels[index] : channels.find((entry) => entry.id === pinned);
  if (pinned !== null && channel === undefined) {
    ctx.logger("slack: cursor points at a channel that is no longer listed", { channel: pinned });
    channel = { id: pinned, name: pinned };
  }
  if (channel === undefined || channel.id === undefined) {
    return { docs: [], cursor: {}, hasMore: false, stats: { channels: channels.length, listed: 0, fetched: 0, replies: 0 } };
  }

  const floor = cursorString(ctx, "floor") ?? defaultFloor(ctx);
  const latest = cursorString(ctx, "latest");
  const params = new URLSearchParams({
    channel: channel.id,
    limit: String(limit),
    oldest: floor,
    inclusive: "false",
  });
  if (latest !== null) params.set("latest", latest);

  let page: SlackHistoryPage;
  try {
    page = await slackRequest<SlackHistoryPage>(ctx, "conversations.history", params);
  } catch (error) {
    if (!isUnreadableChannel(error)) throw error;
    ctx.logger("slack: skipping a conversation that cannot be read", { channel: channel.id, error: messageOf(error) });
    return {
      docs: [],
      cursor: nextChannelCursor(channels, index),
      hasMore: index + 1 < channels.length,
      stats: { channels: channels.length, listed: 0, fetched: 0, replies: 0 },
    };
  }

  const messages = (page.messages ?? []).filter(isStorableMessage);
  const names = messages.length > 0 ? await loadUserNames(ctx) : new Map<string, string>();
  const docs: ConnectorDoc[] = [];
  let replyCalls = 0;

  for (const message of messages) {
    if (docs.length >= limit) break;
    const ts = firstNonEmpty(message.ts);
    if (ts === null) continue;
    const threadTs = firstNonEmpty(message.thread_ts);
    // Replies are covered by the document of their thread root.
    if (threadTs !== null && threadTs !== ts) continue;

    const isThreadRoot = threadTs === ts && (message.reply_count ?? 0) > 0;
    let replies: SlackMessage[] = [];
    if (isThreadRoot && replyCalls < MAX_REPLY_CALLS_PER_PAGE) {
      replyCalls += 1;
      replies = await loadReplies(ctx, channel.id, ts);
    }
    const lines = [messageLine(names, message), ...replies.map((reply) => messageLine(names, reply))];
    const parts: DocParts = {
      lines,
      author: displayName(names, message.user),
      replyCount: message.reply_count ?? 0,
      repliesFetched: replies.length,
    };
    docs.push(messageToDoc(ctx, channel, message, parts));
  }

  const consumed = oldestTimestamp(messages);
  const cursor: SyncCursor = {};
  let hasMore: boolean;
  if (messages.length >= limit && consumed !== null) {
    cursor["channel"] = channel.id;
    cursor["channelIndex"] = index;
    cursor["latest"] = consumed;
    cursor["floor"] = floor;
    hasMore = true;
  } else if (index + 1 < channels.length) {
    cursor["channelIndex"] = index + 1;
    hasMore = true;
  } else {
    hasMore = false;
  }

  ctx.logger("slack: listed messages", {
    channel: channel.id,
    listed: messages.length,
    fetched: docs.length,
    replies: replyCalls,
  });

  return {
    docs,
    cursor,
    hasMore,
    stats: { channels: channels.length, listed: messages.length, fetched: docs.length, replies: replyCalls },
  };
}

/** All visible conversations, narrowed by `ctx.config.channels` when set. */
async function resolveChannels(ctx: SyncContext): Promise<SlackChannel[]> {
  const body = new URLSearchParams({
    limit: String(CHANNEL_PAGE_LIMIT),
    exclude_archived: "true",
    types: "public_channel,private_channel",
  }).toString();

  const result = await pagedRequest<SlackChannelList>(
    ctx.fetchImpl,
    `${SLACK_API}/conversations.list`,
    { method: "POST", headers: slackHeaders(ctx.accessToken), body },
    {
      label: "slack conversations.list",
      maxPages: MAX_CHANNEL_PAGES,
      onPage: (page) => {
        if (page.ok === false) throw slackError("conversations.list", page.error);
        return true;
      },
      // Slack reads the paging cursor from the query string; the body is unchanged.
      next: (page) => {
        const cursor = firstNonEmpty(page.response_metadata?.next_cursor);
        return cursor === null ? null : `${SLACK_API}/conversations.list?cursor=${encodeURIComponent(cursor)}`;
      },
    },
  );

  const channels = result.pages
    .flatMap((page) => page.channels ?? [])
    .filter((channel): channel is SlackChannel & { id: string } => typeof channel.id === "string");
  const wanted = configList(ctx, "channels");
  if (wanted.length === 0) return channels;
  return channels.filter((channel) => matchesChannel(channel, wanted));
}

/** One `users.list` call per page; a failure leaves us with raw user ids. */
async function loadUserNames(ctx: SyncContext): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const page = await slackRequest<SlackUserList>(ctx, "users.list", new URLSearchParams({ limit: String(USERS_LIMIT) }));
    for (const member of page.members ?? []) {
      const id = firstNonEmpty(member.id);
      if (id === null) continue;
      const label =
        firstNonEmpty(member.profile?.display_name) ??
        firstNonEmpty(member.profile?.real_name) ??
        firstNonEmpty(member.real_name) ??
        firstNonEmpty(member.name) ??
        id;
      names.set(id, label);
    }
  } catch (error) {
    ctx.logger("slack: users.list failed, falling back to raw user ids", { error: messageOf(error) });
  }
  return names;
}

async function loadReplies(ctx: SyncContext, channel: string, ts: string): Promise<SlackMessage[]> {
  try {
    const page = await slackRequest<SlackHistoryPage>(
      ctx,
      "conversations.replies",
      new URLSearchParams({ channel, ts, limit: String(REPLY_LIMIT) }),
    );
    return (page.messages ?? []).filter(isStorableMessage);
  } catch (error) {
    ctx.logger("slack: could not load thread replies", { channel, ts, error: messageOf(error) });
    return [];
  }
}

async function slackRequest<T extends SlackEnvelope>(
  ctx: SyncContext,
  method: string,
  params: URLSearchParams,
): Promise<T> {
  const page = await requestJson<T>(
    ctx.fetchImpl,
    `${SLACK_API}/${method}`,
    { method: "POST", headers: slackHeaders(ctx.accessToken), body: params.toString() },
    { label: `slack ${method}` },
  );
  if (page.ok === false) throw slackError(method, page.error);
  return page;
}

/** Slack answers HTTP 200 with `ok: false`; the payload code decides the mapping. */
function slackError(method: string, code: string | undefined): AppError {
  const reason = code ?? "unknown_error";
  const details = { slackError: reason, method };
  if (AUTH_ERRORS.has(reason)) {
    return new AppError("unauthorized", `Slack rejected the credentials (${reason}). Reconnect the Slack connector.`, {
      details,
    });
  }
  if (reason === "ratelimited") {
    return new AppError("rate_limited", "Slack rate limited the request. Retry later.", { details, retryable: true });
  }
  if (UNREADABLE_CHANNEL_ERRORS.has(reason)) {
    return new AppError("not_found", `Slack cannot read this conversation (${reason}).`, { details });
  }
  return new AppError("upstream_error", `Slack ${method} failed: ${reason}`, { details });
}

function messageToDoc(ctx: SyncContext, channel: SlackChannel & { id: string }, message: SlackMessage, parts: DocParts): ConnectorDoc {
  const ts = firstNonEmpty(message.ts) ?? "";
  const createdAt = slackTsToIso(ts);
  return {
    externalId: `${channel.id}:${ts}`,
    title: titleFor(message, channel),
    text: parts.lines.join("\n"),
    url: permalink(ctx, channel.id, ts),
    author: parts.author,
    createdAt,
    updatedAt: createdAt,
    meta: {
      channel: channel.id,
      channelName: channel.name ?? null,
      threadTs: firstNonEmpty(message.thread_ts),
      replyCount: parts.replyCount,
      repliesFetched: parts.repliesFetched,
      reactions: reactionCount(message),
    },
  };
}

function titleFor(message: SlackMessage, channel: SlackChannel): string {
  const text = normalizeWhitespace(message.text ?? "");
  if (text.length === 0) return `#${channel.name ?? channel.id ?? "slack"}`;
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}

/** One `<name>: <content>` line, as required by the stored text format. */
function messageLine(names: Map<string, string>, message: SlackMessage): string {
  const name = displayName(names, message.user) ?? firstNonEmpty(message.username) ?? "unknown";
  return `${name}: ${messageBody(message)}`;
}

function messageBody(message: SlackMessage): string {
  const text = firstNonEmpty(message.text);
  if (text !== null) return normalizeWhitespace(text);
  const files = message.files?.length ?? 0;
  return files > 0 ? `[${files} file(s)]` : "[no content]";
}

function displayName(names: Map<string, string>, userId: string | undefined): string | null {
  const id = firstNonEmpty(userId);
  if (id === null) return null;
  return names.get(id) ?? id;
}

function reactionCount(message: SlackMessage): number {
  let total = 0;
  for (const reaction of message.reactions ?? []) total += reaction.count ?? 1;
  return total;
}

/** `https://<team>.slack.com/...` needs the workspace slug, which is a credential field. */
function permalink(ctx: SyncContext, channel: string, ts: string): string | null {
  const team = credentialString(ctx, "team");
  if (team === null) return null;
  return `https://${team}.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function isStorableMessage(message: SlackMessage): boolean {
  if (firstNonEmpty(message.ts) === null) return false;
  const subtype = firstNonEmpty(message.subtype);
  return subtype === null || !NOISY_SUBTYPES.has(subtype);
}

/** Oldest `ts` of the page: the new exclusive `latest` for the next call. */
function oldestTimestamp(messages: SlackMessage[]): string | null {
  let oldest: string | null = null;
  let oldestSeconds = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    const ts = firstNonEmpty(message.ts);
    if (ts === null) continue;
    const seconds = Number.parseFloat(ts);
    if (!Number.isFinite(seconds) || seconds >= oldestSeconds) continue;
    oldest = ts;
    oldestSeconds = seconds;
  }
  return oldest;
}

function defaultFloor(ctx: SyncContext): string {
  const since = ctx.since === null ? Number.NaN : Date.parse(ctx.since);
  const base = Number.isNaN(since) ? Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS : since;
  return formatSlackTs(base - FLOOR_OVERLAP_MS);
}

function formatSlackTs(ms: number): string {
  return (ms / 1000).toFixed(6);
}

function slackTsToIso(ts: string): string | null {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? toIso(Math.round(seconds * 1000)) : null;
}

function nextChannelCursor(channels: SlackChannel[], index: number): SyncCursor {
  const cursor: SyncCursor = {};
  if (index + 1 < channels.length) cursor["channelIndex"] = index + 1;
  return cursor;
}

function matchesChannel(channel: SlackChannel, wanted: string[]): boolean {
  const id = firstNonEmpty(channel.id);
  const name = firstNonEmpty(channel.name);
  return wanted.some((entry) => {
    const needle = entry.startsWith("#") ? entry.slice(1) : entry;
    return (id !== null && needle === id) || (name !== null && needle === name);
  });
}

/** `channels` may be a list or a comma separated string in the stored config. */
function configList(ctx: SyncContext, key: string): string[] {
  const value = ctx.config[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return [];
}

function slackHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" };
}

function isUnreadableChannel(error: unknown): boolean {
  return error instanceof AppError && error.code === "not_found";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cursorString(ctx: SyncContext, key: string): string | null {
  const value = ctx.cursor[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cursorNumber(ctx: SyncContext, key: string): number | null {
  const value = ctx.cursor[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function credentialString(ctx: SyncContext, key: string): string | null {
  const value = ctx.credentials[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
