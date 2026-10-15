/**
 * Gmail connector (read-only).
 *
 * Listing uses `users.messages.list` (optionally narrowed with the user's own
 * `q`), then `users.messages.get?format=full` per message. The body comes from
 * a depth-first MIME walk that prefers `text/plain` and falls back to a
 * stripped `text/html` part.
 *
 * Cursor: `{ pageToken, lastInternalDate }`. `pageToken` is the listing
 * continuation; `lastInternalDate` is the newest message we have stored, used
 * to rebuild the `after:` window on the next full listing. Gmail's `after:` is
 * second-granular, so the boundary message can be listed again — ingest
 * de-duplicates by `externalId`.
 */

import { AppError } from "../../core/errors";
import { toIso } from "../../core/time";
import { decodeHtmlEntities, htmlToText, normalizeLimit, requestJson } from "../http";
import type { ConnectorDoc, OAuthConfig, Provider, SyncContext, SyncPage } from "../types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_LIMIT = 25;
const MAX_PAGE_SIZE = 500;
const PLAIN_MIME = "text/plain";
const HTML_MIME = "text/html";

const GMAIL_OAUTH: OAuthConfig = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"],
  pkce: true,
  tokenEndpointAuth: "body_client_secret",
  clientIdEnv: "SB_GMAIL_CLIENT_ID",
  clientSecretEnv: "SB_GMAIL_CLIENT_SECRET",
  // `offline` + `consent` are what make Google hand back a refresh token.
  extraAuthParams: { access_type: "offline", prompt: "consent" },
};

type GmailHeader = { name?: string; value?: string };

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string };
  parts?: GmailPart[];
};

type GmailMessageRef = { id?: string; threadId?: string };

type GmailListResponse = {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

export const gmailProvider: Provider = {
  id: "gmail",
  label: "Gmail",
  description: "Đồng bộ email Gmail (chỉ đọc) về bộ nhớ cá nhân.",
  category: "email",
  docsUrl: "https://developers.google.com/gmail/api/reference/rest/v1/users.messages",
  auth: {
    kind: "oauth2",
    oauth: GMAIL_OAUTH,
    helpUrl: "https://console.cloud.google.com/apis/credentials",
  },
  defaultConfig: { q: "" },
  initialLookbackDays: 30,
  syncPage,
};

async function syncPage(ctx: SyncContext): Promise<SyncPage> {
  const limit = normalizeLimit(ctx.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE);
  const pageToken = cursorString(ctx, "pageToken");
  const query = buildListQuery(ctx, pageToken !== null);

  const params = new URLSearchParams({ maxResults: String(limit) });
  if (query) params.set("q", query);
  if (pageToken) params.set("pageToken", pageToken);

  const list = await gmailRequest<GmailListResponse>(ctx, `${GMAIL_API}/messages?${params.toString()}`);
  const refs = (list.messages ?? []).filter((ref): ref is { id: string } & GmailMessageRef => typeof ref.id === "string").slice(0, limit);
  ctx.logger("gmail: listed messages", { listed: refs.length, pageToken: pageToken !== null });

  const docs: ConnectorDoc[] = [];
  let newestInternalDate = Date.parse(cursorString(ctx, "lastInternalDate") ?? "") || null;
  for (const ref of refs) {
    const message = await gmailRequest<GmailMessage>(ctx, `${GMAIL_API}/messages/${encodeURIComponent(ref.id)}?format=full`);
    const doc = messageToDoc(message);
    docs.push(doc);
    const created = doc.createdAt ? Date.parse(doc.createdAt) : Number.NaN;
    if (!Number.isNaN(created) && (newestInternalDate === null || created > newestInternalDate)) newestInternalDate = created;
  }

  const nextPageToken = typeof list.nextPageToken === "string" && list.nextPageToken.length > 0 ? list.nextPageToken : null;
  return {
    docs,
    cursor: {
      pageToken: nextPageToken,
      lastInternalDate: newestInternalDate === null ? cursorString(ctx, "lastInternalDate") : toIso(newestInternalDate),
    },
    hasMore: nextPageToken !== null,
    stats: { listed: refs.length, fetched: docs.length },
  };
}

/**
 * The user's own filter plus a time window. `after:` is skipped while a
 * `pageToken` is in play: Gmail keeps the original result set for the token and
 * only requires that the same `q` is sent.
 */
function buildListQuery(ctx: SyncContext, hasPageToken: boolean): string {
  const parts: string[] = [];
  const configured = configString(ctx, "q");
  if (configured) parts.push(configured);
  if (!hasPageToken) {
    const after = windowStartSeconds(ctx);
    if (after !== null) parts.push(`after:${after}`);
  }
  return parts.join(" ");
}

/** Newest stored message, or the last sync, expressed as Unix seconds. */
function windowStartSeconds(ctx: SyncContext): number | null {
  const from = cursorString(ctx, "lastInternalDate") ?? ctx.since;
  if (!from) return null;
  const parsed = Date.parse(from);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

async function gmailRequest<T>(ctx: SyncContext, url: string): Promise<T> {
  try {
    return await requestJson<T>(ctx.fetchImpl, url, { method: "GET", headers: authHeaders(ctx.accessToken) }, { label: "gmail" });
  } catch (error) {
    throw describeGmailError(error);
  }
}

/**
 * Gmail needs two different user actions here: a stale token (401) is fixed by
 * reconnecting, a missing scope (403 `insufficientPermissions`) by granting it,
 * while `quotaExceeded` (403) is just a retry later.
 */
function describeGmailError(error: unknown): AppError {
  if (!(error instanceof AppError)) {
    return new AppError("upstream_error", error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (error.status === 401) {
    return new AppError("unauthorized", "Gmail rejected the access token (401). Reconnect the Gmail connector.", {
      details: { ...error.details },
      cause: error,
    });
  }
  if (error.status === 403) {
    const body = String(error.details?.["body"] ?? "");
    if (/insufficient|scope|permission|unauthorized/i.test(body)) {
      return new AppError("unauthorized", "Gmail denied the request (403): the connector is missing the gmail.readonly scope. Reconnect and grant it.", {
        details: { ...error.details },
        cause: error,
      });
    }
    return new AppError("rate_limited", "Gmail quota exceeded (403). Retry later or lower the sync limit.", {
      details: { ...error.details },
      cause: error,
      retryable: true,
    });
  }
  return error;
}

function messageToDoc(message: GmailMessage): ConnectorDoc {
  const headers = message.payload?.headers ?? [];
  const id = typeof message.id === "string" ? message.id : "";
  const body = extractBodyText(message.payload);
  const internalDate = Number(message.internalDate);
  const createdAt = message.internalDate !== undefined && Number.isFinite(internalDate) ? toIso(internalDate) : null;
  return {
    externalId: id,
    title: headerValue(headers, "subject") ?? "(no subject)",
    text: body.text,
    url: `https://mail.google.com/mail/u/0/#all/${id}`,
    author: headerValue(headers, "from"),
    createdAt,
    updatedAt: createdAt,
    mime: body.mime,
    meta: {
      threadId: message.threadId ?? null,
      labels: message.labelIds ?? [],
      snippet: message.snippet ?? null,
    },
  };
}

/**
 * Depth-first MIME walk: the first `text/plain` part wins, otherwise the first
 * `text/html` part is stripped down to text.
 */
export function extractBodyText(payload: GmailPart | undefined): { text: string; mime: string | null } {
  const plain = findPart(payload, PLAIN_MIME);
  if (plain?.body?.data !== undefined) {
    return { text: decodeBase64Url(plain.body.data).trim(), mime: PLAIN_MIME };
  }
  const html = findPart(payload, HTML_MIME);
  if (html?.body?.data !== undefined) {
    return { text: htmlToText(decodeBase64Url(html.body.data)), mime: HTML_MIME };
  }
  const inline = payload?.body?.data !== undefined ? decodeBase64Url(payload.body.data).trim() : "";
  return { text: payload?.mimeType === HTML_MIME ? htmlToText(inline) : decodeHtmlEntities(inline), mime: payload?.mimeType ?? null };
}

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && typeof part.body?.data === "string") return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function headerValue(headers: GmailHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (typeof header.name === "string" && header.name.toLowerCase() === wanted) {
      const value = header.value?.trim();
      if (value) return value;
    }
  }
  return null;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
}

function cursorString(ctx: SyncContext, key: string): string | null {
  const value = ctx.cursor[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function configString(ctx: SyncContext, key: string): string | null {
  const value = ctx.config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
