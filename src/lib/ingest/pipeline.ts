import fs from "node:fs";
import path from "node:path";

import { AppError } from "../core/errors";
import { newId, sha256Hex } from "../core/ids";
import { createLogger } from "../core/logger";
import { slugify, truncate } from "../core/text";
import { nowIso } from "../core/time";
import { uploadsDir } from "../core/env";
import { ensureExtractorsRegistered, extractFile } from "../extract";
import { htmlToText } from "../extract/html";
import { recordEvent } from "../db/repo/system";
import { upsertDocument, type PreparedChunk } from "../db/repo/documents";
import type { IngestResult, SourceKind } from "../types/domain";
import { chunkText, type ChunkOptions } from "./chunker";
import { applyEnrichment } from "./enrich";

const logger = createLogger("ingest");

export type IngestTextInput = {
  text: string;
  title?: string;
  sourceKind: SourceKind;
  sourceId: string;
  connectorId?: string | null;
  externalId?: string | null;
  url?: string | null;
  path?: string | null;
  mime?: string | null;
  author?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  meta?: Record<string, unknown>;
  tags?: string[];
  participants?: string[];
  topic?: string | null;
  force?: boolean;
  chunkOptions?: ChunkOptions;
  chunks?: PreparedChunk[];
  /** Skip the entity/tag graph update (bulk imports can opt out for speed). */
  skipEnrichment?: boolean;
};

/** Chunk + index + enrich. The single write path for every source. */
export function ingestText(input: IngestTextInput): IngestResult {
  const text = input.text ?? "";
  const chunks = input.chunks ?? chunkText(text, input.chunkOptions ?? {});
  try {
    const outcome = upsertDocument({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      connectorId: input.connectorId ?? null,
      externalId: input.externalId ?? null,
      title: input.title ?? "",
      text,
      url: input.url ?? null,
      path: input.path ?? null,
      mime: input.mime ?? null,
      author: input.author ?? null,
      createdAt: input.createdAt ?? null,
      updatedAt: input.updatedAt ?? null,
      meta: input.meta ?? {},
      chunks,
      force: input.force ?? false,
    });

    if (outcome.status !== "skipped" && !input.skipEnrichment) {
      applyEnrichment(outcome.documentId, {
        text,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.participants ? { participants: input.participants } : {}),
        topic: input.topic ?? null,
      });
    }

    if (outcome.status === "created") {
      recordEvent({
        kind: "document.ingested",
        title: truncate(input.title ?? text.slice(0, 80), 120),
        documentId: outcome.documentId,
        connectorId: input.connectorId ?? null,
        detail: { sourceId: input.sourceId, chunks: outcome.chunks, sourceKind: input.sourceKind },
      });
    } else if (outcome.status === "updated") {
      recordEvent({
        kind: "document.updated",
        title: truncate(input.title ?? text.slice(0, 80), 120),
        documentId: outcome.documentId,
        connectorId: input.connectorId ?? null,
        detail: { sourceId: input.sourceId, chunks: outcome.chunks },
      });
    }

    const docTitle = upsertDocumentTitleHint(input.title, text);
    return {
      documentId: outcome.documentId,
      status: outcome.status,
      chunks: outcome.chunks,
      title: docTitle,
    };
  } catch (error) {
    logger.error("ingest failed", { sourceId: input.sourceId, error: error instanceof Error ? error.message : String(error) });
    return {
      documentId: "",
      status: "failed",
      chunks: 0,
      title: input.title ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function upsertDocumentTitleHint(title: string | undefined, text: string): string {
  if (title && title.trim().length > 0) return truncate(title.trim(), 120);
  const first = text.split("\n").find((line) => line.trim().length > 0) ?? "Untitled";
  return truncate(first.replace(/^#{1,6}\s*/, "").trim(), 120);
}

export function ensureUploadsDir(): string {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Keeps the original bytes so a document can be re-indexed without re-upload. */
export function saveUploadedFile(bytes: Uint8Array, filename: string): string {
  const dir = ensureUploadsDir();
  const stamp = newId("ing").slice(4, 18);
  const safe = `${stamp}-${slugify(filename, 60)}`;
  const target = path.join(dir, safe);
  fs.writeFileSync(target, bytes);
  return target;
}

export type IngestFileInput = {
  bytes: Uint8Array;
  filename: string;
  mime?: string | null;
  sourceKind?: SourceKind;
  sourceId: string;
  connectorId?: string | null;
  externalId?: string | null;
  url?: string | null;
  path?: string | null;
  title?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: string | null;
  meta?: Record<string, unknown>;
  tags?: string[];
  participants?: string[];
  force?: boolean;
  keepOriginal?: boolean;
  skipEnrichment?: boolean;
};

export type IngestFileResult = IngestResult & { warnings: string[]; via: string; storedPath: string | null };

/** Extract text from one file and index it. */
export async function ingestFile(input: IngestFileInput): Promise<IngestFileResult> {
  ensureExtractorsRegistered();
  const filename = input.filename;
  let extract;
  try {
    extract = await extractFile({ bytes: input.bytes, filename, mime: input.mime ?? null });
  } catch (error) {
    logger.error("extraction failed", { filename, error: error instanceof Error ? error.message : String(error) });
    return {
      documentId: "",
      status: "failed",
      chunks: 0,
      title: filename,
      warnings: [],
      via: "none",
      storedPath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let storedPath: string | null = null;
  if (input.keepOriginal ?? true) {
    try {
      storedPath = saveUploadedFile(input.bytes, filename);
    } catch (error) {
      logger.warn("could not keep a copy of the upload", {
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result = ingestText({
    text: extract.text,
    sourceKind: input.sourceKind ?? "upload",
    sourceId: input.sourceId,
    connectorId: input.connectorId ?? null,
    externalId: input.externalId ?? input.path ?? filename,
    title: input.title ?? extract.title ?? filename,
    url: input.url ?? null,
    path: input.path ?? filename,
    mime: input.mime ?? extract.mime,
    author: input.author ?? null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null,
    meta: { ...(input.meta ?? {}), ...extract.meta, storedPath, via: extract.via, hash: sha256Hex(input.bytes).slice(0, 16) },
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.participants ? { participants: input.participants } : {}),
    force: input.force ?? false,
    ...(input.skipEnrichment ? { skipEnrichment: true } : {}),
  });

  return { ...result, warnings: extract.warnings, via: extract.via, storedPath };
}

export type IngestUrlInput = {
  url: string;
  title?: string;
  tags?: string[];
  force?: boolean;
  fetchImpl?: typeof fetch;
};

export type IngestUrlResult = IngestResult & { warnings: string[]; finalUrl: string };

/** Fetches a page and stores a readable text version of it. */
export async function ingestUrl(input: IngestUrlInput): Promise<IngestUrlResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new AppError("bad_request", `Not a valid absolute URL: ${input.url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError("bad_request", "Only http(s) URLs can be captured.");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timed out")), 30_000);
  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "second-brain/0.1 (+local personal knowledge base)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
  } catch (error) {
    throw new AppError("upstream_error", `Could not fetch ${parsed.toString()}: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new AppError("upstream_error", `Fetching ${parsed.toString()} returned ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const warnings: string[] = [];
  let text = body;
  let title = input.title ?? null;

  if (contentType.includes("html") || /<html[\s>]/i.test(body.slice(0, 500))) {
    const converted = htmlToText(body);
    text = converted.text;
    title = input.title ?? converted.title;
    if (text.trim().length < 200) warnings.push("page yielded very little text (javascript-heavy page?)");
  } else if (contentType && !contentType.startsWith("text/") && !contentType.includes("json")) {
    warnings.push(`unsupported content type ${contentType}; stored raw body`);
  }

  const finalUrl = response.url || parsed.toString();
  const result = ingestText({
    text,
    title: title ?? parsed.hostname,
    sourceKind: "url",
    sourceId: parsed.hostname,
    externalId: finalUrl,
    url: finalUrl,
    path: null,
    mime: contentType || null,
    meta: { fetchedAt: nowIso(), contentType, requestedUrl: input.url },
    tags: input.tags ?? [],
    force: input.force ?? false,
  });

  return { ...result, warnings, finalUrl };
}

/** Indexes everything an importer yields (mbox, Slack/Notion export, ICS…). */
export async function ingestImportedItems(
  items: AsyncIterable<{
    externalId: string;
    title: string;
    text: string;
    url?: string | null;
    author?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    mime?: string | null;
    path?: string | null;
    meta?: Record<string, unknown>;
  }>,
  origin: {
    sourceId: string;
    sourceKind?: SourceKind;
    connectorId?: string | null;
    tags?: string[];
    force?: boolean;
    onProgress?: (count: number, title: string) => void;
    limit?: number;
  },
): Promise<{ results: IngestResult[]; added: number; updated: number; skipped: number; failed: number }> {
  const results: IngestResult[] = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for await (const item of items) {
    if (origin.limit && results.length >= origin.limit) break;
    const result = ingestText({
      text: item.text,
      title: item.title,
      sourceKind: origin.sourceKind ?? "importer",
      sourceId: origin.sourceId,
      connectorId: origin.connectorId ?? null,
      externalId: item.externalId,
      url: item.url ?? null,
      path: item.path ?? null,
      mime: item.mime ?? null,
      author: item.author ?? null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? null,
      meta: item.meta ?? {},
      tags: origin.tags ?? [],
      force: origin.force ?? false,
      skipEnrichment: false,
    });
    results.push(result);
    if (result.status === "created") added += 1;
    else if (result.status === "updated") updated += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
    origin.onProgress?.(results.length, item.title);
  }

  recordEvent({
    kind: "importer.completed",
    title: `Imported ${results.length} items from ${origin.sourceId}`,
    detail: { added, updated, skipped, failed },
  });
  return { results, added, updated, skipped, failed };
}
