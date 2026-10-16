/**
 * Google Drive connector (read-only).
 *
 * `files.list` is asked for what matters — newest modification first, shared
 * drives included — and each file becomes a document:
 *
 * - Google Docs, Sheets and Slides are exported as text (plain text, CSV,
 *   plain text);
 * - files the app can decode directly (`text/*`, JSON) are downloaded as is;
 * - everything else (images, video, archives, Office binaries) is counted and
 *   skipped: those formats come in through the Import page from a local file.
 *
 * Cursor: `{ pageToken }`. The first sync walks the drive; every later sync adds
 * `modifiedTime > <previous sync>` to the query, so a delta run only lists what
 * changed. The sync runner's `maxPages`/`maxItems` valves bound a large drive,
 * and an interrupted listing resumes from the stored page token.
 */

import { AppError } from "../../core/errors";
import { normalizeWhitespace, truncate } from "../../core/text";
import { toIso } from "../../core/time";
import { decodeTextBytes } from "../../extract/text";
import { normalizeLimit, requestJson } from "../http";
import type { ConnectorDoc, OAuthConfig, Provider, SyncContext, SyncCursor, SyncPage } from "../types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DEFAULT_LIMIT = 25;
const MAX_PAGE_SIZE = 100;
/** One document's worth of text; a huge export must not fill the database. */
const MAX_TEXT_CHARS = 200_000;

/** Google-native formats, and the text flavour each is exported as. */
const EXPORTABLE: Record<string, { mime: string; label: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", label: "Google Doc" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", label: "Google Sheet" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", label: "Google Slides" },
};

const DRIVE_OAUTH: OAuthConfig = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/userinfo.email"],
  pkce: true,
  tokenEndpointAuth: "body_client_secret",
  clientIdEnv: "SB_GOOGLE_DRIVE_CLIENT_ID",
  clientSecretEnv: "SB_GOOGLE_DRIVE_CLIENT_SECRET",
  // `offline` + `consent` are what make Google hand back a refresh token.
  extraAuthParams: { access_type: "offline", prompt: "consent" },
};

const FILE_FIELDS =
  "nextPageToken,files(id,name,mimeType,description,modifiedTime,createdTime,webViewLink,size,owners(displayName,emailAddress),trashed)";

type DriveOwner = { displayName?: string; emailAddress?: string };

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  size?: string;
  owners?: DriveOwner[];
  trashed?: boolean;
};

type DriveListResponse = { files?: DriveFile[]; nextPageToken?: string };
type DriveAboutResponse = { user?: { displayName?: string; emailAddress?: string } };

export const googleDriveProvider: Provider = {
  id: "google_drive",
  label: "Google Drive",
  description: "Syncs Google Drive files (read-only) into your personal memory.",
  category: "docs",
  docsUrl: "https://developers.google.com/drive/api/reference/rest/v3/files/list",
  auth: {
    kind: "oauth2",
    oauth: DRIVE_OAUTH,
    helpUrl: "https://console.cloud.google.com/apis/credentials",
  },
  identify,
  syncPage,
};

/**
 * One page of files. A file that cannot be exported (permissions, a Google
 * format with no text flavour) is counted as skipped rather than failing the
 * page, which is the difference between a partial sync and no sync at all.
 */
async function syncPage(ctx: SyncContext): Promise<SyncPage> {
  const limit = normalizeLimit(ctx.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE);
  const pageToken = cursorString(ctx, "pageToken");

  const params = new URLSearchParams({
    pageSize: String(limit),
    orderBy: "modifiedTime desc",
    fields: FILE_FIELDS,
    q: buildQuery(ctx),
    // Shared drives are opt-in per request; without these two a shared drive
    // simply looks empty.
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
  });
  if (pageToken !== null) params.set("pageToken", pageToken);

  const payload = await requestJson<DriveListResponse>(
    ctx.fetchImpl,
    `${DRIVE_API}/files?${params.toString()}`,
    { method: "GET", headers: authHeaders(ctx.accessToken) },
    { label: "google_drive" },
  );

  const files = (payload.files ?? []).filter((file) => file.trashed !== true);
  const docs: ConnectorDoc[] = [];
  let skipped = 0;
  for (const file of files) {
    if (docs.length >= limit) break;
    const doc = await fileToDoc(ctx, file);
    if (doc === null) skipped += 1;
    else docs.push(doc);
  }

  const next = firstNonEmpty(payload.nextPageToken);
  const cursor: SyncCursor = {};
  if (next !== null) cursor["pageToken"] = next;
  ctx.logger("google_drive: listed files", { listed: files.length, fetched: docs.length, skipped });

  return {
    docs,
    cursor,
    hasMore: next !== null,
    stats: { listed: files.length, fetched: docs.length, skipped },
  };
}

/**
 * Everything that is not a folder and not in the bin; once a sync has completed,
 * only files modified since then. Drive indexes `modifiedTime`, so a delta run
 * stays small even on a large drive.
 */
function buildQuery(ctx: SyncContext): string {
  const clauses = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
  const since = toIso(ctx.since ?? null);
  if (since !== null) clauses.push(`modifiedTime > '${since}'`);
  return clauses.join(" and ");
}

/** One file as a document; null for a format the app cannot read. */
async function fileToDoc(ctx: SyncContext, file: DriveFile): Promise<ConnectorDoc | null> {
  const id = firstNonEmpty(file.id);
  if (id === null) return null;
  const mime = firstNonEmpty(file.mimeType) ?? "";
  const exportable = EXPORTABLE[mime];
  const decodable = exportable !== undefined || mime.startsWith("text/") || mime === "application/json";
  if (!decodable) return null;

  const text = await fetchFileText(ctx, id, mime, exportable?.mime ?? null);
  if (text === null || text.trim().length === 0) return null;

  const title = firstNonEmpty(file.name) ?? "(untitled)";
  const description = normalizeWhitespace(file.description ?? "");
  const owner = file.owners?.[0];
  const author = firstNonEmpty(owner?.displayName) ?? firstNonEmpty(owner?.emailAddress);
  const modified = toIso(file.modifiedTime ?? null);

  const lines = [title];
  if (exportable !== undefined) lines.push(`Format: ${exportable.label} (exported as ${exportable.mime})`);
  if (description.length > 0) lines.push(description);
  if (author !== null) lines.push(`Owner: ${author}`);
  if (modified !== null) lines.push(`Modified: ${modified}`);
  lines.push("", text);

  return {
    externalId: id,
    title,
    text: lines.join("\n"),
    url: firstNonEmpty(file.webViewLink),
    author,
    createdAt: toIso(file.createdTime ?? null),
    updatedAt: modified,
    mime: exportable?.mime ?? mime,
    meta: {
      driveMimeType: mime,
      size: firstNonEmpty(file.size),
      exported: exportable !== undefined,
      description: description.length > 0 ? description : null,
    },
  };
}

/** Exports a Google-native file, or downloads one that is already text. */
async function fetchFileText(
  ctx: SyncContext,
  id: string,
  mime: string,
  exportMime: string | null,
): Promise<string | null> {
  const url =
    exportMime !== null
      ? `${DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`;

  let response: Response;
  try {
    response = await ctx.fetchImpl(url, { method: "GET", headers: authHeaders(ctx.accessToken) });
  } catch (error) {
    ctx.logger("google_drive: download failed", { id, error: messageOf(error) });
    return null;
  }
  if (!response.ok) {
    // A single file the token cannot export is routine on a shared drive; it
    // must not abort the page.
    ctx.logger("google_drive: unreadable file", { id, mime, status: response.status });
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return truncate(decodeTextBytes(bytes).text, MAX_TEXT_CHARS);
}

/** Names the account behind the token, for the connector list in the UI. */
async function identify(ctx: Omit<SyncContext, "cursor">): Promise<{ accountLabel: string; extra?: Record<string, unknown> }> {
  const payload = await requestJson<DriveAboutResponse>(
    ctx.fetchImpl,
    `${DRIVE_API}/about?fields=user(displayName,emailAddress)`,
    { method: "GET", headers: authHeaders(ctx.accessToken) },
    { label: "google_drive" },
  );
  const email = firstNonEmpty(payload.user?.emailAddress);
  const name = firstNonEmpty(payload.user?.displayName);
  return {
    accountLabel: email ?? name ?? "Google Drive",
    extra: { displayName: name },
  };
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

function messageOf(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
