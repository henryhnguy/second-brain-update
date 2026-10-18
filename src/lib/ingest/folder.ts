import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../core/logger";
import { AppError } from "../core/errors";
import { nowIso } from "../core/time";
import { getDocument } from "../db/repo/documents";
import { recordEvent } from "../db/repo/system";
import { all, get, num, run } from "../db/sql";
import { getDb } from "../db/connection";
import { TEXT_EXTENSIONS } from "../extract/types";
import type { IngestResult } from "../types/domain";
import { ingestFile } from "./pipeline";

const logger = createLogger("ingest:folder");

const SKIP_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".next",
  ".obsidian",
  ".trash",
  "dist",
  "build",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export const DEFAULT_FOLDER_EXTENSIONS: string[] = [...TEXT_EXTENSIONS, ".pdf", ".docx", ".xlsx", ".xlsm", ".pptx"];

export type FolderSyncOptions = {
  root: string;
  extensions?: string[];
  /** Stable identifier for this folder root; defaults to a slug of the path. */
  sourceId?: string;
  force?: boolean;
  limit?: number;
  onProgress?: (progress: { scanned: number; ingested: number; current: string }) => void;
  /** Injected for tests. */
  readFile?: (file: string) => Uint8Array;
};

export type FolderSyncReport = {
  root: string;
  sourceId: string;
  scanned: number;
  ingested: number;
  updated: number;
  skipped: number;
  failed: number;
  removed: number;
  errors: { file: string; error: string }[];
  tookMs: number;
  results: IngestResult[];
};

export function folderSourceId(root: string): string {
  const resolved = path.resolve(root).replace(/\\/g, "/");
  return `folder:${resolved}`;
}

function walk(root: string, extensions: Set<string>, onSkip: (dir: string) => void): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      onSkip(`cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.size > 0 && !extensions.has(ext)) continue;
      files.push(full);
    }
  }
  return files.sort();
}

function knownFileState(sourceId: string): Map<string, { mtime: number; size: number; documentId: string }> {
  const rows = all<{ external_id: string; meta: string; id: string }>(
    getDb(),
    "SELECT external_id, meta, id FROM documents WHERE source_id = ? AND deleted_at IS NULL",
    [sourceId],
  );
  const map = new Map<string, { mtime: number; size: number; documentId: string }>();
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.meta) as { mtime?: number; size?: number };
      if (typeof meta.mtime === "number") {
        map.set(String(row.external_id), {
          mtime: meta.mtime,
          size: typeof meta.size === "number" ? meta.size : -1,
          documentId: String(row.id),
        });
      }
    } catch {
      /* ignore malformed meta */
    }
  }
  return map;
}

/**
 * Incremental folder sync (Obsidian vault, `~/Documents`, a repo of notes…).
 * Unchanged files are skipped using mtime + size recorded in document meta.
 */
export async function syncFolder(options: FolderSyncOptions): Promise<FolderSyncReport> {
  const started = Date.now();
  const root = path.resolve(options.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new AppError("bad_request", `Folder does not exist or is not a directory: ${root}`);
  }

  const extensions = new Set((options.extensions ?? DEFAULT_FOLDER_EXTENSIONS).map((ext) => ext.toLowerCase()));
  const sourceId = options.sourceId ?? folderSourceId(root);
  const errors: { file: string; error: string }[] = [];
  const files = walk(root, extensions, (message) => errors.push({ file: root, error: message }));
  const known = knownFileState(sourceId);
  const results: IngestResult[] = [];

  let scanned = 0;
  let ingested = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    if (options.limit && results.length >= options.limit) break;
    scanned += 1;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      errors.push({ file, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      errors.push({ file, error: `skipped: ${Math.round(stat.size / 1024 / 1024)}MB exceeds the 32MB limit` });
      continue;
    }

    const rel = path.relative(root, file).replace(/\\/g, "/");
    const previous = known.get(rel);
    const unchanged =
      !options.force &&
      previous &&
      Math.abs(previous.mtime - stat.mtimeMs) < 1 &&
      (previous.size === stat.size || previous.size === -1);
    if (unchanged) {
      skipped += 1;
      continue;
    }

    options.onProgress?.({ scanned, ingested, current: rel });
    try {
      const bytes = options.readFile ? options.readFile(file) : new Uint8Array(fs.readFileSync(file));
      const result = await ingestFile({
        bytes,
        filename: path.basename(file),
        sourceId,
        sourceKind: "folder",
        externalId: rel,
        path: file,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        meta: { folderRoot: root, relPath: rel, mtime: stat.mtimeMs, size: stat.size },
        force: options.force ?? false,
      });
      results.push(result);
      if (result.status === "created") ingested += 1;
      else if (result.status === "updated") updated += 1;
      else if (result.status === "failed") {
        failed += 1;
        errors.push({ file, error: result.error ?? "ingest failed" });
      } else skipped += 1;
    } catch (error) {
      failed += 1;
      errors.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const removed = reconcileDeletions(sourceId, files, root);
  const tookMs = Date.now() - started;

  recordEvent({
    kind: "folder.synced",
    title: `Folder sync: ${ingested} new, ${updated} updated, ${removed} removed`,
    detail: { root, scanned, skipped, failed, tookMs },
  });
  logger.info("folder sync finished", { root, scanned, ingested, updated, skipped, failed, removed, tookMs });

  return {
    root,
    sourceId,
    scanned,
    ingested,
    updated,
    skipped,
    failed,
    removed,
    errors,
    tookMs,
    results,
  };
}

/** Marks documents whose file disappeared from the folder as deleted. */
function reconcileDeletions(sourceId: string, files: string[], root: string): number {
  const present = new Set(files.map((file) => path.relative(root, file).replace(/\\/g, "/")));
  const rows = all<{ id: string; external_id: string }>(
    getDb(),
    "SELECT id, external_id FROM documents WHERE source_id = ? AND deleted_at IS NULL",
    [sourceId],
  );
  let removed = 0;
  for (const row of rows) {
    if (present.has(String(row.external_id))) continue;
    run(getDb(), "UPDATE documents SET deleted_at = ?, status = 'deleted' WHERE id = ?", [nowIso(), row.id]);
    removed += 1;
  }
  return removed;
}

export function folderOverview(): {
  root: string;
  sourceId: string;
  documents: number;
  lastIngestAt: string | null;
}[] {
  const rows = all<{ source_id: string; c: number; at: string | null; meta: string }>(
    getDb(),
    `SELECT source_id, COUNT(*) AS c, MAX(ingested_at) AS at, MAX(meta) AS meta
     FROM documents WHERE source_kind = 'folder' AND deleted_at IS NULL GROUP BY source_id ORDER BY at DESC`,
  );
  return rows.map((row) => {
    let root = "";
    try {
      root = (JSON.parse(String(row.meta)) as { folderRoot?: string }).folderRoot ?? "";
    } catch {
      root = "";
    }
    return {
      root,
      sourceId: String(row.source_id),
      documents: num(row.c),
      lastIngestAt: row.at ? String(row.at) : null,
    };
  });
}

export function reconcileOrphans(): number {
  const orphans = get<{ c: number }>(
    getDb(),
    "SELECT COUNT(*) AS c FROM documents WHERE source_kind = 'folder' AND deleted_at IS NULL AND path IS NOT NULL",
  );
  const checked = num(orphans?.c);
  if (checked === 0) return 0;
  const rows = all<{ id: string; path: string }>(
    getDb(),
    "SELECT id, path FROM documents WHERE source_kind = 'folder' AND deleted_at IS NULL AND path IS NOT NULL",
  );
  let removed = 0;
  for (const row of rows) {
    if (fs.existsSync(String(row.path))) continue;
    run(getDb(), "UPDATE documents SET deleted_at = ?, status = 'deleted' WHERE id = ?", [nowIso(), row.id]);
    removed += 1;
  }
  return removed;
}

/** Re-indexes one folder document from the original bytes on disk. */
export async function reindexDocument(documentId: string): Promise<IngestResult> {
  const doc = getDocument(documentId);
  if (!doc) throw new AppError("not_found", `Document ${documentId} not found`);
  const storedPath = typeof doc.meta.storedPath === "string" ? doc.meta.storedPath : doc.path;
  if (!storedPath || !fs.existsSync(storedPath)) {
    throw new AppError("bad_request", "Original bytes are not available for this document.");
  }
  const bytes = new Uint8Array(fs.readFileSync(storedPath));
  const result = await ingestFile({
    bytes,
    filename: path.basename(storedPath),
    sourceId: doc.sourceId,
    sourceKind: doc.sourceKind,
    externalId: doc.externalId,
    path: doc.path,
    title: doc.title,
    keepOriginal: false,
    force: true,
  });
  return result;
}
