import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../core/logger";
import { getImporterFor } from "../import";
import { ensureExtractorsRegistered } from "../extract";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  jobCounts,
  requeueStaleJobs,
} from "../db/repo/system";
import type { Job, JobKind } from "../types/domain";
import { backfillEmbeddings } from "../ai/embeddings";
import { syncConnector } from "../connectors/runner";
import { runPlay } from "../plays/engine";
import { ingestFile, ingestImportedItems, ingestUrl } from "../ingest/pipeline";
import { reindexDocument, syncFolder } from "../ingest/folder";

const logger = createLogger("jobs");

export type JobResult = Record<string, unknown>;

async function runOneJob(job: Job): Promise<JobResult> {
  const payload = job.payload;
  switch (job.kind as JobKind) {
    case "ingest.file": {
      const filePath = String(payload.path ?? "");
      if (!filePath || !fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      const result = await ingestFile({
        bytes,
        filename: String(payload.filename ?? path.basename(filePath)),
        sourceId: String(payload.sourceId ?? "upload"),
        ...(typeof payload.sourceKind === "string" ? { sourceKind: payload.sourceKind as never } : {}),
        externalId: typeof payload.externalId === "string" ? payload.externalId : null,
        title: typeof payload.title === "string" ? payload.title : undefined,
        keepOriginal: payload.keepOriginal !== false,
        force: payload.force === true,
      });
      return { ...result };
    }
    case "ingest.url": {
      const result = await ingestUrl({
        url: String(payload.url ?? ""),
        tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : [],
      });
      return { ...result };
    }
    case "ingest.folder": {
      const report = await syncFolder({
        root: String(payload.root ?? ""),
        ...(Array.isArray(payload.extensions) ? { extensions: payload.extensions as string[] } : {}),
        force: payload.force === true,
      });
      return {
        scanned: report.scanned,
        ingested: report.ingested,
        updated: report.updated,
        skipped: report.skipped,
        failed: report.failed,
        removed: report.removed,
      };
    }
    case "ingest.importer": {
      ensureExtractorsRegistered();
      const filePath = String(payload.path ?? "");
      if (!filePath || !fs.existsSync(filePath)) throw new Error(`archive not found: ${filePath}`);
      const filename = String(payload.filename ?? path.basename(filePath));
      const importer = getImporterFor(filename);
      if (!importer) throw new Error(`no importer registered for ${filename}`);
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      const outcome = await ingestImportedItems(
        importer.parse({
          bytes,
          filename,
          ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
        }),
        {
          sourceId: String(payload.sourceId ?? importer.id),
          sourceKind: "importer",
          ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
        },
      );
      return { importer: importer.id, added: outcome.added, updated: outcome.updated, skipped: outcome.skipped, failed: outcome.failed };
    }
    case "embed.backfill": {
      const report = await backfillEmbeddings({
        limit: typeof payload.limit === "number" ? payload.limit : 200,
      });
      return { ...report };
    }
    case "connector.sync": {
      const connectorId = String(payload.connectorId ?? "");
      const outcome = await syncConnector(connectorId, {
        maxPages: typeof payload.maxPages === "number" ? payload.maxPages : 5,
        maxItems: typeof payload.maxItems === "number" ? payload.maxItems : 250,
      });
      return {
        added: outcome.added,
        updated: outcome.updated,
        pages: outcome.pages,
        status: outcome.status,
        error: outcome.error,
      };
    }
    case "play.run": {
      const playId = String(payload.playId ?? "");
      const params = typeof payload.params === "object" && payload.params !== null ? (payload.params as Record<string, unknown>) : {};
      const outcome = await runPlay(playId, params);
      return { runId: outcome.run.id, usedLlm: outcome.usedLlm, citations: outcome.citations.length };
    }
    case "maintenance.reindex": {
      const ids: string[] = Array.isArray(payload.documentIds) ? (payload.documentIds as string[]) : [];
      let reindexed = 0;
      const failures: string[] = [];
      for (const id of ids) {
        try {
          const result = await reindexDocument(id);
          if (result.status !== "failed") reindexed += 1;
          else failures.push(`${id}: ${result.error ?? "failed"}`);
        } catch (error) {
          failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { reindexed, failures };
    }
    default:
      throw new Error(`unsupported job kind: ${job.kind}`);
  }
}

export type ProcessSummary = { processed: number; failed: number; results: { jobId: string; kind: string; ok: boolean }[] };

/** Claims and runs queued jobs sequentially until the queue is empty or `limit` is hit. */
export async function processJobsOnce(limit = 5): Promise<ProcessSummary> {
  const summary: ProcessSummary = { processed: 0, failed: 0, results: [] };
  for (let index = 0; index < limit; index += 1) {
    const job = claimNextJob();
    if (!job) break;
    try {
      const result = await runOneJob(job);
      completeJob(job.id, result);
      summary.results.push({ jobId: job.id, kind: job.kind, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failJob(job.id, message);
      summary.failed += 1;
      summary.results.push({ jobId: job.id, kind: job.kind, ok: false });
      logger.warn("job failed", { jobId: job.id, kind: job.kind, error: message });
    }
    summary.processed += 1;
  }
  return summary;
}

type WorkerState = { timer: NodeJS.Timeout | null; running: boolean; intervalMs: number; lastRunAt: string | null; lastSummary: ProcessSummary | null };

const WORKER_KEY = "__second_brain_worker__";

function state(): WorkerState {
  const holder = globalThis as unknown as Record<string, WorkerState | undefined>;
  if (!holder[WORKER_KEY]) {
    holder[WORKER_KEY] = { timer: null, running: false, intervalMs: 5_000, lastRunAt: null, lastSummary: null };
  }
  return holder[WORKER_KEY] as WorkerState;
}

export function workerStatus(): { running: boolean; intervalMs: number; lastRunAt: string | null; queue: Record<string, number> } {
  const current = state();
  return { running: current.running, intervalMs: current.intervalMs, lastRunAt: current.lastRunAt, queue: jobCounts() };
}

/** Starts the in-process worker used by `npm run dev` and the Docker image. */
export function startWorker(intervalMs = 5_000): void {
  const current = state();
  if (current.timer) return;
  current.intervalMs = intervalMs;
  current.running = true;
  requeueStaleJobs();
  current.timer = setInterval(() => {
    if (state().running === false) return;
    void processJobsOnce(3)
      .then((summary) => {
        if (summary.processed > 0) {
          const currentState = state();
          currentState.lastRunAt = new Date().toISOString();
          currentState.lastSummary = summary;
        }
      })
      .catch((error) => logger.error("worker tick failed", { error: error instanceof Error ? error.message : String(error) }));
  }, intervalMs);
  if (typeof current.timer.unref === "function") current.timer.unref();
  logger.info("background worker started", { intervalMs });
}

export function stopWorker(): void {
  const current = state();
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
  current.running = false;
}

export function scheduleConnectorSync(connectorId: string, options: { maxItems?: number } = {}): string {
  return enqueueJob({
    kind: "connector.sync",
    payload: { connectorId, ...(options.maxItems ? { maxItems: options.maxItems } : {}) },
    priority: 2,
  });
}

export function scheduleFolderSync(root: string, options: { force?: boolean } = {}): string {
  return enqueueJob({ kind: "ingest.folder", payload: { root, force: options.force === true }, priority: 1 });
}

export function schedulePlayRun(playId: string, params: Record<string, unknown> = {}): string {
  return enqueueJob({ kind: "play.run", payload: { playId, params }, priority: 1 });
}

export function scheduleEmbeddingBackfill(limit = 400): string {
  return enqueueJob({ kind: "embed.backfill", payload: { limit }, priority: 0 });
}

export function scheduleReindex(documentIds: string[]): string {
  return enqueueJob({ kind: "maintenance.reindex", payload: { documentIds }, priority: 0 });
}

export { runOneJob };
