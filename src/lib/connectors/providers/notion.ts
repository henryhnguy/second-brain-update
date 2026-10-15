/**
 * Notion connector (read-only), using an internal integration token.
 *
 * `POST /v1/search` is the only listing Notion offers: it returns pages and
 * databases the integration has been shared with, sorted by `last_edited_time`
 * ascending so pages arrive oldest first and `start_cursor` walks forward. The
 * search API cannot filter by time, so a stored `lastEditedTime` is applied to
 * the results here — older items are skipped, and the boundary item is kept
 * (`>=`), because ingest de-duplicates by `externalId`.
 *
 * A page's text comes from its children (`GET /v1/blocks/{id}/children`), one
 * level deep: nested blocks (`has_children`) are not followed. At most
 * `MAX_CHILDREN_REQUESTS_PER_PAGE` block requests are spent per page, so one
 * `syncPage` call stays bounded; pages beyond that budget keep their title only.
 *
 * Cursor: `{ startCursor, lastEditedTime }` (read with `cursorString`).
 */

import { normalizeWhitespace } from "../../core/text";
import { normalizeLimit, requestJson } from "../http";
import type { ConnectorDoc, Provider, SyncContext, SyncCursor, SyncPage } from "../types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_LIMIT = 25;
const MAX_PAGE_SIZE = 100;
const CHILDREN_PAGE_SIZE = 100;
const MAX_CHILDREN_REQUESTS_PER_PAGE = 10;

type NotionUser = { id?: string; name?: string; type?: string };

type NotionParent = { type?: string; page_id?: string; database_id?: string; workspace?: boolean };

type NotionObject = {
  object?: string;
  id?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  created_by?: NotionUser;
  last_edited_by?: NotionUser;
  archived?: boolean;
  parent?: NotionParent;
};

/** Pages and databases differ only in `title` vs `properties`, both optional here. */
type NotionItem = NotionObject & { properties?: Record<string, unknown>; title?: unknown };

type SearchResponse = {
  object?: string;
  results?: NotionItem[];
  next_cursor?: string;
  has_more?: boolean;
};

type BlockChildrenResponse = {
  results?: NotionBlock[];
  next_cursor?: string;
  has_more?: boolean;
};

/** Notion blocks are open-ended: the payload sits under a key named after `type`. */
type NotionBlock = { type?: string; has_children?: boolean } & Record<string, unknown>;

export const notionProvider: Provider = {
  id: "notion",
  label: "Notion",
  description: "Syncs Notion pages and databases (read-only) into your personal memory.",
  category: "docs",
  docsUrl: "https://developers.notion.com/reference/post-search",
  auth: {
    kind: "token",
    tokenLabel: "Notion integration token",
    configFields: [{ key: "workspace", label: "Workspace name (optional)", required: false, placeholder: "My workspace" }],
    helpUrl: "https://www.notion.so/my-integrations",
  },
  defaultConfig: { includeDatabases: true },
  initialLookbackDays: 90,
  syncPage,
};

/** One page of search results, plus where the next run should resume. */
async function syncPage(ctx: SyncContext): Promise<SyncPage> {
  const limit = normalizeLimit(ctx.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE);
  const body: Record<string, unknown> = {
    sort: { direction: "ascending", timestamp: "last_edited_time" },
    page_size: limit,
  };
  const startCursor = cursorString(ctx, "startCursor");
  if (startCursor !== null) body.start_cursor = startCursor;

  const payload = await notionRequest<SearchResponse>(ctx, "POST", "/search", body);
  const bound = cursorString(ctx, "lastEditedTime");
  const includeDatabases = configBoolean(ctx, "includeDatabases") ?? true;
  const results = (payload.results ?? []).filter((item) => typeof item.id === "string");

  const docs: ConnectorDoc[] = [];
  let blockRequests = 0;
  for (const item of results) {
    if (docs.length >= limit) break;
    const edited = firstNonEmpty(item.last_edited_time);
    // ISO timestamps from one API compare lexicographically; `>=` keeps the boundary item.
    if (bound !== null && edited !== null && edited < bound) continue;

    if (item.object === "database") {
      if (includeDatabases) docs.push(databaseToDoc(item));
      continue;
    }

    let content = "";
    if (blockRequests < MAX_CHILDREN_REQUESTS_PER_PAGE) {
      blockRequests += 1;
      content = await loadPageContent(ctx, item.id ?? "");
    }
    docs.push(pageToDoc(item, content));
  }

  const nextCursor = firstNonEmpty(payload.next_cursor);
  const cursor: SyncCursor = {};
  if (nextCursor !== null) cursor["startCursor"] = nextCursor;
  const newest = newestLastEdited(results) ?? bound;
  if (newest !== null) cursor["lastEditedTime"] = newest;
  ctx.logger("notion: searched pages and databases", {
    listed: results.length,
    fetched: docs.length,
    blockRequests,
  });

  return {
    docs,
    cursor,
    hasMore: nextCursor !== null,
    stats: { listed: results.length, fetched: docs.length, blockRequests },
  };
}

async function notionRequest<T>(
  ctx: SyncContext,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const init: RequestInit = { method, headers: notionHeaders(ctx) };
  if (body !== undefined) init.body = JSON.stringify(body);
  return requestJson<T>(ctx.fetchImpl, `${NOTION_API}${path}`, init, { label: "notion" });
}

function notionHeaders(ctx: SyncContext): Record<string, string> {
  return {
    authorization: `Bearer ${ctx.accessToken}`,
    "notion-version": NOTION_VERSION,
    accept: "application/json",
    "content-type": "application/json",
  };
}

/** Plain text of the first (and by far most common) level of a page's blocks. */
async function loadPageContent(ctx: SyncContext, blockId: string): Promise<string> {
  if (blockId.length === 0) return "";
  const payload = await notionRequest<BlockChildrenResponse>(
    ctx,
    "GET",
    `/blocks/${encodeURIComponent(blockId)}/children?page_size=${CHILDREN_PAGE_SIZE}`,
  );
  const lines: string[] = [];
  for (const block of payload.results ?? []) {
    const text = normalizeWhitespace(collectRichText(blockPayload(block)));
    if (text.length > 0) lines.push(text);
  }
  return lines.join("\n");
}

function pageToDoc(page: NotionItem, content: string): ConnectorDoc {
  const id = page.id ?? "";
  const title = pageTitle(page) ?? "(untitled)";
  return {
    externalId: id,
    title,
    text: content.length > 0 ? content : title,
    url: firstNonEmpty(page.url),
    author: editorName(page),
    createdAt: toIsoOrNull(page.created_time),
    updatedAt: toIsoOrNull(page.last_edited_time),
    meta: {
      object: "page",
      ...parentMeta(page),
      archived: page.archived ?? null,
      properties: Object.keys(page.properties ?? {}),
    },
  };
}

function databaseToDoc(database: NotionItem): ConnectorDoc {
  const id = database.id ?? "";
  const title = normalizeWhitespace(collectRichText(database.title)) || "(untitled database)";
  const schema = databaseSchema(database);
  return {
    externalId: id,
    title,
    text: schema.length > 0 ? schema : title,
    url: firstNonEmpty(database.url),
    author: editorName(database),
    createdAt: toIsoOrNull(database.created_time),
    updatedAt: toIsoOrNull(database.last_edited_time),
    meta: {
      object: "database",
      ...parentMeta(database),
      archived: database.archived ?? null,
      properties: Object.keys(database.properties ?? {}),
    },
  };
}

/** Property names and types: the searchable shape of a database. */
function databaseSchema(database: NotionItem): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(database.properties ?? {})) {
    const kind = isRecord(value) && typeof value["type"] === "string" ? String(value["type"]) : "unknown";
    lines.push(`${name} (${kind})`);
  }
  return lines.join("\n");
}

/** The title property is the one whose `type` is `title`; its name is user defined. */
function pageTitle(page: NotionItem): string | null {
  for (const value of Object.values(page.properties ?? {})) {
    if (isRecord(value) && value["type"] === "title") {
      const text = normalizeWhitespace(collectRichText(value["title"]));
      if (text.length > 0) return text;
    }
  }
  return null;
}

/**
 * Pulls `plain_text` out of nested rich text (block payloads, titles, …).
 *
 * Arrays are free — they are how rich text and block lists nest — while every
 * object level costs one unit of depth, so the default of 2 already reaches
 * `rich_text[].plain_text` and `property.title[].plain_text` and stops there
 * instead of walking the whole payload.
 */
function collectRichText(value: unknown, depth = 2): string {
  if (depth < 0 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => collectRichText(item, depth)).join("");
  if (!isRecord(value)) return "";
  const plain = value["plain_text"];
  if (typeof plain === "string") return plain;
  return Object.values(value)
    .map((child) => collectRichText(child, depth - 1))
    .join("");
}

/** The payload of a block: `{ type: "paragraph", paragraph: { rich_text } }`. */
function blockPayload(block: NotionBlock): unknown {
  const type = firstNonEmpty(block.type);
  return type === null ? undefined : block[type];
}

function parentMeta(item: NotionItem): Record<string, unknown> {
  const parent = item.parent;
  return {
    parentType: parent?.type ?? null,
    parentId: parent?.page_id ?? parent?.database_id ?? null,
  };
}

function editorName(item: NotionItem): string | null {
  return firstNonEmpty(item.last_edited_by?.name) ?? firstNonEmpty(item.created_by?.name);
}

function newestLastEdited(items: NotionItem[]): string | null {
  let newest: string | null = null;
  let newestMs = Number.NaN;
  for (const item of items) {
    const edited = firstNonEmpty(item.last_edited_time);
    if (edited === null) continue;
    const ms = Date.parse(edited);
    if (Number.isNaN(ms)) continue;
    if (Number.isNaN(newestMs) || ms > newestMs) {
      newest = edited;
      newestMs = ms;
    }
  }
  return newest;
}

function toIsoOrNull(value: string | undefined): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configBoolean(ctx: SyncContext, key: string): boolean | null {
  const value = ctx.config[key];
  return typeof value === "boolean" ? value : null;
}

function cursorString(ctx: SyncContext, key: string): string | null {
  const value = ctx.cursor[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
