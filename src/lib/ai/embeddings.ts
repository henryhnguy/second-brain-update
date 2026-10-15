import { aiNotConfigured } from "../core/errors";
import { createLogger } from "../core/logger";
import { chunksMissingEmbeddings, upsertEmbedding } from "../db/repo/documents";
import { getAiConfig } from "./config";
import { embedTexts } from "./provider";
import { embeddingModelCoverage } from "../retrieval/semantic";

const logger = createLogger("ai:embeddings");

export type BackfillReport = {
  model: string;
  embedded: number;
  remaining: number;
  total: number;
  tookMs: number;
};

/** Local, explicit backfill: nothing is ever embedded without being asked for. */
export async function backfillEmbeddings(
  options: { limit?: number; batchSize?: number; fetchImpl?: typeof fetch } = {},
): Promise<BackfillReport> {
  const config = getAiConfig();
  if (!config.configured) throw aiNotConfigured();
  const started = Date.now();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2_000);
  const pending = chunksMissingEmbeddings(config.embedModel, limit);

  if (pending.length === 0) {
    const coverage = embeddingModelCoverage(config.embedModel);
    return { model: config.embedModel, embedded: 0, remaining: 0, total: coverage.total, tookMs: Date.now() - started };
  }

  const result = await embedTexts(
    pending.map((chunk) => chunk.text),
    {
      model: config.embedModel,
      ...(config.embedDim > 0 ? { dim: config.embedDim } : {}),
      ...(options.batchSize ? { batchSize: options.batchSize } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      config,
    },
  );

  let embedded = 0;
  pending.forEach((chunk, index) => {
    const vector = result.vectors[index];
    if (!vector || vector.length === 0) return;
    upsertEmbedding(chunk.id, result.model || config.embedModel, vector);
    embedded += 1;
  });

  const coverage = embeddingModelCoverage(config.embedModel);
  const remaining = Math.max(coverage.total - coverage.embedded, 0);
  logger.info("embedding backfill", { embedded, remaining, model: config.embedModel });
  return {
    model: config.embedModel,
    embedded,
    remaining,
    total: coverage.total,
    tookMs: Date.now() - started,
  };
}

export function embeddingStatus(): { model: string; embedded: number; total: number; ready: boolean; configured: boolean } {
  const config = getAiConfig();
  const coverage = embeddingModelCoverage(config.embedModel);
  return {
    model: config.embedModel,
    embedded: coverage.embedded,
    total: coverage.total,
    ready: coverage.embedded > 0,
    configured: config.configured,
  };
}

/** Embeddings for documents that have none yet (used after a connector sync). */
export async function embedDocumentChunks(
  documentId: string,
  options: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<number> {
  const config = getAiConfig();
  if (!config.configured) return 0;
  const pending = chunksMissingEmbeddings
    ? chunksMissingEmbeddings(config.embedModel, options.limit ?? 500).filter((chunk) => chunk.documentId === documentId)
    : [];
  if (pending.length === 0) return 0;
  const result = await embedTexts(
    pending.map((chunk) => chunk.text),
    { model: config.embedModel, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), config },
  );
  let embedded = 0;
  pending.forEach((chunk, index) => {
    const vector = result.vectors[index];
    if (!vector) return;
    upsertEmbedding(chunk.id, config.embedModel, vector);
    embedded += 1;
  });
  return embedded;
}
