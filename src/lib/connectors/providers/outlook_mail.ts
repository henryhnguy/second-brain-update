/**
 * Outlook Mail connector (read-only), built on Microsoft Graph.
 *
 * Listing uses `/me/messages` with a `receivedDateTime ge …` filter, `$top` and
 * an explicit `$select` — Graph charges for the fields it has to materialise, so
 * asking for the ten we store is both faster and cheaper. Graph's `@odata.nextLink`
 * is followed verbatim on the next call: the link already carries the paging
 * token, so the filter is not recomputed while a listing is in flight.
 *
 * Cursor: `{ nextLink, lastReceivedDateTime }` (read with `cursorString`).
 * `lastReceivedDateTime` is the newest message we have returned (monotonically
 * non-decreasing across pages of one listing) and is what the next window
 * starts from. Because the filter uses `ge`, the boundary message can be listed
 * again — ingest de-duplicates by `externalId`.
 *
 * `body.content` is HTML for Outlook by default; it is stripped down to text.
 */

import { normalizeWhitespace } from "../../core/text";
import { toIso } from "../../core/time";
import { htmlToText, normalizeLimit, requestJson } from "../http";
import type { ConnectorDoc, OAuthConfig, Provider, SyncContext, SyncCursor, SyncPage } from "../types";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const DEFAULT_LIMIT = 25;
const MAX_TOP = 1000;
const MAX_RECIPIENTS = 20;

const SELECT_FIELDS = [
  "id",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "lastModifiedDateTime",
  "bodyPreview",
  "body",
  "webLink",
  "conversationId",
  "isDraft",
  "hasAttachments",
].join(",");

const GRAPH_OAUTH: OAuthConfig = {
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  // `offline_access` is what makes Microsoft hand back a refresh token.
  scopes: ["offline_access", "User.Read", "Mail.Read"],
  pkce: true,
  tokenEndpointAuth: "body_client_secret",
  clientIdEnv: "SB_OUTLOOK_CLIENT_ID",
  clientSecretEnv: "SB_OUTLOOK_CLIENT_SECRET",
};

type GraphEmailAddress = { name?: string; address?: string };
type GraphRecipient = { emailAddress?: GraphEmailAddress };

type GraphMessage = {
  id?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  webLink?: string;
  conversationId?: string;
  isDraft?: boolean;
  hasAttachments?: boolean;
};

type GraphMessagePage = {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
};

export const outlookMailProvider: Provider = {
  id: "outlook_mail",
  label: "Outlook Mail",
  description: "Đồng bộ email Outlook / Microsoft 365 (chỉ đọc) về bộ nhớ cá nhân.",
  category: "email",
  docsUrl: "https://learn.microsoft.com/graph/api/user-list-messages",
  auth: {
    kind: "oauth2",
    oauth: GRAPH_OAUTH,
    helpUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  },
  defaultConfig: {},
  initialLookbackDays: 30,
  syncPage,
};

/** One page of messages, plus where the next run should resume. */
async function syncPage(ctx: SyncContext): Promise<SyncPage> {
  const limit = normalizeLimit(ctx.limit, DEFAULT_LIMIT, MAX_TOP);
  const storedLink = cursorString(ctx, "nextLink");
  const payload = await graphRequest<GraphMessagePage>(ctx, storedLink ?? buildListUrl(ctx, limit));

  const rows = (payload.value ?? []).filter((message) => typeof message.id === "string");
  if (rows.length > limit) {
    ctx.logger("outlook_mail: Graph returned more messages than $top asked for", {
      requested: limit,
      received: rows.length,
    });
  }
  const docs = rows.slice(0, limit).map(messageToDoc);
  const following = firstNonEmpty(payload["@odata.nextLink"]);
  const bound = advanceBound(ctx, docs);

  const cursor: SyncCursor = {};
  if (following !== null) cursor["nextLink"] = following;
  if (bound !== null) cursor["lastReceivedDateTime"] = bound;
  ctx.logger("outlook_mail: listed messages", {
    listed: rows.length,
    fetched: docs.length,
    followingNextLink: following !== null,
  });

  return {
    docs,
    cursor,
    hasMore: following !== null,
    stats: { listed: rows.length, fetched: docs.length },
  };
}

/** First call of a listing: the window starts at the cursor, then at `ctx.since`. */
function buildListUrl(ctx: SyncContext, limit: number): string {
  const params = new URLSearchParams({ $top: String(limit), $select: SELECT_FIELDS });
  const bound = cursorString(ctx, "lastReceivedDateTime") ?? ctx.since;
  if (bound !== null) params.set("$filter", `receivedDateTime ge ${bound}`);
  return `${GRAPH_API}/me/messages?${params.toString()}`;
}

/**
 * Newest `receivedDateTime` seen so far. Graph returns the newest first, so a
 * later page must not pull the window backwards: this only ever moves forward.
 */
function advanceBound(ctx: SyncContext, docs: ConnectorDoc[]): string | null {
  let best = cursorString(ctx, "lastReceivedDateTime");
  let bestMs = best === null ? Number.NaN : Date.parse(best);
  for (const doc of docs) {
    if (typeof doc.createdAt !== "string") continue;
    const ms = Date.parse(doc.createdAt);
    if (Number.isNaN(ms)) continue;
    if (Number.isNaN(bestMs) || ms > bestMs) {
      best = doc.createdAt;
      bestMs = ms;
    }
  }
  return best;
}

async function graphRequest<T>(ctx: SyncContext, url: string): Promise<T> {
  return requestJson<T>(ctx.fetchImpl, url, { method: "GET", headers: authHeaders(ctx.accessToken) }, { label: "outlook_mail" });
}

function messageToDoc(message: GraphMessage): ConnectorDoc {
  const id = typeof message.id === "string" ? message.id : "";
  const received = toIso(message.receivedDateTime ?? null);
  const contentType = firstNonEmpty(message.body?.contentType)?.toLowerCase() ?? null;
  const raw = message.body?.content ?? "";
  const text = contentType === "html" ? htmlToText(raw) : raw.trim();
  const preview = normalizeWhitespace(message.bodyPreview ?? "");

  return {
    externalId: id,
    title: firstNonEmpty(message.subject) ?? "(no subject)",
    text: text.length > 0 ? text : preview,
    url: firstNonEmpty(message.webLink),
    author: addressLabel(message.from),
    createdAt: received,
    updatedAt: toIso(message.lastModifiedDateTime ?? null) ?? received,
    mime: contentType === "html" ? "text/html" : contentType === "text" ? "text/plain" : null,
    meta: {
      conversationId: message.conversationId ?? null,
      isDraft: message.isDraft ?? null,
      hasAttachments: message.hasAttachments ?? null,
      to: recipientsLabel(message.toRecipients),
      cc: recipientsLabel(message.ccRecipients),
    },
  };
}

function addressLabel(recipient: GraphRecipient | undefined): string | null {
  const emailAddress = recipient?.emailAddress;
  if (!emailAddress) return null;
  return firstNonEmpty(emailAddress.name) ?? firstNonEmpty(emailAddress.address);
}

function recipientsLabel(recipients: GraphRecipient[] | undefined): string | null {
  if (!recipients || recipients.length === 0) return null;
  const labels: string[] = [];
  for (const recipient of recipients.slice(0, MAX_RECIPIENTS)) {
    const label = firstNonEmpty(recipient.emailAddress?.address) ?? firstNonEmpty(recipient.emailAddress?.name);
    if (label !== null) labels.push(label);
  }
  return labels.length === 0 ? null : labels.join(", ");
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
}

function cursorString(ctx: SyncContext, key: string): string | null {
  const value = ctx.cursor[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
