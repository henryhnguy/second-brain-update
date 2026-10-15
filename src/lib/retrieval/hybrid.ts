import { createLogger } from "../core/logger";
import { snippetAround, tokenize } from "../core/text";
import { getAiConfig } from "../ai/config";
import { embedOne } from "../ai/provider";
import type { Citation, ScoreSignals, SearchHit, SearchMode, SearchRequest, SearchResponse } from "../types/domain";
import { facetCounts, keywordSearch, tagFacetCounts, trigramSearch, type LexicalCandidate } from "./lexical";
import { embeddingModelCoverage, semanticSearch, type SemanticCandidate } from "./semantic";

const logger = createLogger("retrieval");

/**
 * Reciprocal-rank fusion of three retrievers. RRF avoids per-retriever score
 * normalisation, which matters because BM25 and cosine live on different scales.
 */
const RRF_K = 60;
const WEIGHTS = { keyword: 1, trigram: 0.45, semantic: 1.15 };

type Candidate = LexicalCandidate | SemanticCandidate;

export type Fused = {
  chunkId: string;
  candidate: Candidate;
  score: number;
  signals: ScoreSignals;
};

function isSemantic(candidate: Candidate): candidate is SemanticCandidate {
  return "cosine" in candidate;
}

export function recencyBonus(iso: string | null): number {
  if (!iso) return 0;
  const age = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(age) || age < 0) return 0.004;
  const days = age / 86_400_000;
  if (days < 7) return 0.02;
  if (days < 30) return 0.012;
  if (days < 365) return 0.004;
  return 0;
}

export function fuse(
  lists: { name: keyof typeof WEIGHTS; items: Candidate[] }[],
): Fused[] {
  const byChunk = new Map<string, Fused>();

  for (const list of lists) {
    list.items.forEach((candidate, index) => {
      const contribution = WEIGHTS[list.name] / (RRF_K + index + 1);
      const existing = byChunk.get(candidate.chunkId);
      if (existing) {
        existing.score += contribution;
        if (list.name === "keyword") existing.signals.bm25 = (candidate as LexicalCandidate).score;
        if (list.name === "trigram") existing.signals.trigram = (candidate as LexicalCandidate).score;
        if (list.name === "semantic") existing.signals.cosine = (candidate as SemanticCandidate).cosine;
        return;
      }
      const signals: ScoreSignals = {};
      if (list.name === "keyword") signals.bm25 = (candidate as LexicalCandidate).score;
      if (list.name === "trigram") signals.trigram = (candidate as LexicalCandidate).score;
      if (list.name === "semantic") signals.cosine = (candidate as SemanticCandidate).cosine;
      byChunk.set(candidate.chunkId, { chunkId: candidate.chunkId, candidate, score: contribution, signals });
    });
  }

  const fused = Array.from(byChunk.values());
  for (const entry of fused) {
    const { candidate } = entry;
    const bonus = recencyBonus(candidate.createdAt ?? candidate.updatedAt) + (candidate.pinned ? 0.03 : 0);
    entry.signals.recency = bonus;
    entry.signals.pin = candidate.pinned ? 1 : 0;
    entry.score += bonus;
  }
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

export type RetrievalDeps = {
  /** Injected in tests; defaults to the configured provider. */
  embedQuery?: (text: string) => Promise<Float32Array | null>;
};

async function defaultEmbedQuery(text: string): Promise<Float32Array | null> {
  const config = getAiConfig();
  if (!config.configured) return null;
  try {
    return await embedOne(text, { model: config.embedModel });
  } catch (error) {
    logger.warn("query embedding failed; continuing with keyword results", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function semanticIndexState(): { model: string; embedded: number; total: number; ready: boolean } {
  const config = getAiConfig();
  const coverage = embeddingModelCoverage(config.embedModel);
  return { model: config.embedModel, ...coverage, ready: coverage.embedded > 0 && config.configured };
}

/**
 * Main entry point used by the API, the chat orchestrator and the CLI.
 * Degrades gracefully: with no provider it returns keyword + trigram results.
 */
export async function search(request: SearchRequest, deps: RetrievalDeps = {}): Promise<SearchResponse> {
  const started = Date.now();
  const query = request.query.trim();
  const mode: SearchMode = request.mode ?? "hybrid";
  const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
  const offset = Math.max(request.offset ?? 0, 0);
  const filters = request.filters;
  const config = getAiConfig();
  const indexState = semanticIndexState();

  if (query.length === 0) {
    return {
      query,
      mode,
      semanticAvailable: indexState.ready,
      tookMs: Date.now() - started,
      total: 0,
      hits: [],
      facets: { sourceKind: {}, sourceId: {}, tags: {} },
    };
  }

  const keyword = keywordSearch(query, { limit: 80, filters });
  let trigram: LexicalCandidate[] = [];
  if (mode !== "semantic" && keyword.length < 8) {
    trigram = trigramSearch(query, { limit: 40, filters });
  }

  let semantic: SemanticCandidate[] = [];
  const semanticRequested = mode === "semantic" || mode === "hybrid";
  if (semanticRequested && indexState.ready && config.configured) {
    const embed = deps.embedQuery ?? defaultEmbedQuery;
    const vector = await embed(query);
    if (vector) {
      const candidateIds =
        mode === "hybrid"
          ? Array.from(new Set([...keyword, ...trigram].map((item) => item.chunkId)))
          : undefined;
      semantic = semanticSearch(vector, {
        limit: mode === "semantic" ? 80 : 120,
        filters,
        model: config.embedModel,
        ...(candidateIds && candidateIds.length > 0 ? { candidateChunkIds: candidateIds } : {}),
      });
      if (mode === "hybrid" && candidateIds && candidateIds.length > 0) {
        // Hybrid widens recall a little: also consider the global semantic top-K.
        const global = semanticSearch(vector, { limit: 40, filters, model: config.embedModel });
        const seen = new Set(semantic.map((item) => item.chunkId));
        for (const item of global) if (!seen.has(item.chunkId)) semantic.push(item);
      }
    }
  }

  const lists: { name: keyof typeof WEIGHTS; items: Candidate[] }[] = [];
  if (keyword.length > 0) lists.push({ name: "keyword", items: keyword });
  if (trigram.length > 0) lists.push({ name: "trigram", items: trigram });
  if (semantic.length > 0) lists.push({ name: "semantic", items: semantic });

  const fused = fuse(lists);

  // Roll chunk hits up to documents, keeping the best passage per document.
  const perDocument = new Map<string, Fused>();
  for (const entry of fused) {
    const current = perDocument.get(entry.candidate.documentId);
    if (!current || entry.score > current.score) perDocument.set(entry.candidate.documentId, entry);
  }
  const ranked = Array.from(perDocument.values()).sort((a, b) => b.score - a.score);
  const page = ranked.slice(offset, offset + limit);
  const terms = tokenize(query);

  const hits: SearchHit[] = page.map((entry) => {
    const candidate = entry.candidate;
    return {
      documentId: candidate.documentId,
      chunkId: candidate.chunkId,
      title: candidate.title,
      sourceKind: candidate.sourceKind,
      sourceId: candidate.sourceId,
      url: candidate.url,
      path: candidate.path,
      author: candidate.author,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      ingestedAt: candidate.ingestedAt,
      score: Number(entry.score.toFixed(6)),
      signals: entry.signals,
      snippet: snippetAround(candidate.text, terms, 240),
      headingPath: candidate.headingPath,
    };
  });

  return {
    query,
    mode,
    semanticAvailable: indexState.ready,
    tookMs: Date.now() - started,
    total: ranked.length,
    hits,
    facets: {
      sourceKind: facetCounts(filters).sourceKind,
      sourceId: facetCounts(filters).sourceId,
      tags: tagFacetCounts(filters),
    },
  };
}

/** Passages handed to the LLM, numbered so the answer can cite them. */
export async function retrievePassages(
  query: string,
  options: { filters?: SearchRequest["filters"]; limit?: number; deps?: RetrievalDeps } = {},
): Promise<{ citations: Citation[]; context: string }> {
  const response = await search(
    { query, mode: "hybrid", limit: options.limit ?? getAiConfig().contextChunks, filters: options.filters },
    options.deps ?? {},
  );
  const citations: Citation[] = [];
  const blocks: string[] = [];

  response.hits.forEach((hit, index) => {
    citations.push({
      index: index + 1,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      title: hit.title,
      sourceKind: hit.sourceKind,
      sourceId: hit.sourceId,
      url: hit.url,
      path: hit.path,
      createdAt: hit.createdAt,
      headingPath: hit.headingPath,
      snippet: hit.snippet,
      score: hit.score,
    });
    const when = hit.createdAt ? ` (${hit.createdAt.slice(0, 10)})` : "";
    blocks.push(
      `[${index + 1}] ${hit.title}${when} — source: ${hit.sourceId}${hit.headingPath ? ` › ${hit.headingPath}` : ""}\n${hit.snippet}`,
    );
  });

  return { citations, context: blocks.join("\n\n") };
}
