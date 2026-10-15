import { AppError } from "../core/errors";
import { createLogger } from "../core/logger";
import { truncate } from "../core/text";
import { nowIso } from "../core/time";
import { chunkText } from "../ingest/chunker";
import { ingestText } from "../ingest/pipeline";
import { recordEvent } from "../db/repo/system";
import type { Connector, SyncRun } from "../types/domain";
import { ensureFreshToken } from "./oauth-config";
import {
  finishSyncRun,
  getConnector,
  listConnectors,
  startSyncRun,
  updateConnectorState,
  updateCursor,
} from "./store";
import { ensureProvidersRegistered, getProvider, listProviders } from "./index";
import type { Provider, SyncContext, SyncCursor, SyncPage } from "./types";

const logger = createLogger("connectors:runner");

export type SyncOptions = {
  /** Safety valves so a first sync on a huge mailbox cannot run forever. */
  maxPages?: number;
  maxItems?: number;
  fetchImpl?: typeof fetch;
  /** Overrides connector config for one run (used by tests and the CLI). */
  configOverride?: Record<string, unknown>;
  dryRun?: boolean;
};

export type SyncOutcome = {
  connectorId: string;
  provider: string;
  pages: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  items: number;
  status: SyncRun["status"];
  error: string | null;
  tookMs: number;
  samples: string[];
};

function connectorConfig(connector: Connector): Record<string, unknown> {
  return connector.config ?? {};
}

/** Cursors round-trip through JSON: keep only scalar values. */
function toCursor(input: Record<string, unknown>): SyncCursor {
  const cursor: SyncCursor = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      cursor[key] = value;
    }
  }
  return cursor;
}

/**
 * Pulls one connector page by page, indexing everything it returns.
 * Cursors are persisted per page, so an interrupted sync resumes instead of
 * re-fetching the whole mailbox.
 */
export async function syncConnector(connectorId: string, options: SyncOptions = {}): Promise<SyncOutcome> {
  ensureProvidersRegistered();
  const started = Date.now();
  const connector = getConnector(connectorId);
  if (!connector) throw new AppError("not_found", `Connector ${connectorId} not found`);
  const provider = getProvider(connector.provider);
  if (!provider) throw new AppError("bad_request", `Unknown provider ${connector.provider}`);

  const maxPages = Math.min(Math.max(options.maxPages ?? 5, 1), 50);
  const maxItems = Math.min(Math.max(options.maxItems ?? 250, 1), 5_000);
  const runId = startSyncRun(connector.id);

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let items = 0;
  let pages = 0;
  let cursor = toCursor(connector.cursor ?? {});
  let error: string | null = null;
  const samples: string[] = [];

  try {
    const { accessToken } = await ensureFreshToken(connector.id, provider, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    while (pages < maxPages && items < maxItems) {
      const context: SyncContext = {
        fetchImpl: options.fetchImpl ?? fetch,
        accessToken,
        credentials: {},
        config: { ...connectorConfig(connector), ...(options.configOverride ?? {}) },
        cursor,
        limit: Math.min(100, maxItems - items),
        since: connector.lastSyncAt,
        logger: (message, extra) => logger.debug(`[${connector.provider}] ${message}`, extra),
      };

      let page: SyncPage;
      try {
        page = await provider.syncPage(context);
      } catch (pageError) {
        error = pageError instanceof AppError ? pageError.message : String(pageError);
        break;
      }

      pages += 1;
      for (const doc of page.docs) {
        if (items >= maxItems) break;
        items += 1;
        if (options.dryRun) continue;
        const result = ingestText({
          text: doc.text,
          title: doc.title,
          sourceKind: "connector",
          sourceId: provider.id,
          connectorId: connector.id,
          externalId: doc.externalId,
          url: doc.url ?? null,
          path: null,
          mime: doc.mime ?? null,
          author: doc.author ?? null,
          createdAt: doc.createdAt ?? null,
          updatedAt: doc.updatedAt ?? null,
          meta: doc.meta ?? {},
          chunks: chunkText(doc.text),
        });
        if (result.status === "created") added += 1;
        else if (result.status === "updated") updated += 1;
        else if (result.status === "failed") failed += 1;
        else skipped += 1;
        if (samples.length < 5) samples.push(truncate(doc.title, 80));
      }

      cursor = page.cursor ?? cursor;
      if (!options.dryRun) updateCursor(connector.id, cursor);
      if (!page.hasMore || page.docs.length === 0) break;
    }
  } catch (syncError) {
    error = syncError instanceof AppError ? syncError.message : String(syncError);
    logger.warn("connector sync failed", { connectorId, error });
  }

  const status: SyncRun["status"] = error ? (items > 0 ? "partial" : "error") : "ok";
  const tookMs = Date.now() - started;

  finishSyncRun(runId, {
    status,
    added,
    updated,
    skipped,
    failed,
    error,
    detail: { pages, items, tookMs, samples },
  });
  updateConnectorState(connector.id, {
    status: error && items === 0 ? "error" : "connected",
    lastError: error,
    lastStatus: status,
    itemsSynced: connector.itemsSynced + added + updated,
    lastSyncAt: nowIso(),
  });
  recordEvent({
    kind: "connector.synced",
    title: `${provider.label}: +${added} mới, ${updated} cập nhật${error ? " (có lỗi)" : ""}`,
    connectorId: connector.id,
    detail: { status, pages, items, error },
  });

  return {
    connectorId: connector.id,
    provider: provider.id,
    pages,
    added,
    updated,
    skipped,
    failed,
    items,
    status,
    error,
    tookMs,
    samples,
  };
}

export async function syncEnabledConnectors(options: SyncOptions = {}): Promise<SyncOutcome[]> {
  const connectors = listConnectors().filter((connector) => connector.autoSync && connector.hasCredentials);
  const outcomes: SyncOutcome[] = [];
  for (const connector of connectors) {
    try {
      outcomes.push(await syncConnector(connector.id, options));
    } catch (error) {
      logger.warn("scheduled connector sync failed", {
        connectorId: connector.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

/** Providers that can run without an OAuth dance (pasted token). */
export function tokenProviders(): Provider[] {
  ensureProvidersRegistered();
  return listProviders().filter((provider) => provider.auth.kind === "token");
}

export function connectorHealth(connectorId: string): {
  connector: Connector;
  provider: Provider | null;
  ready: boolean;
  reason: string | null;
} {
  ensureProvidersRegistered();
  const connector = getConnector(connectorId);
  if (!connector) throw new AppError("not_found", `Connector ${connectorId} not found`);
  const provider = getProvider(connector.provider) ?? null;
  if (!provider) return { connector, provider: null, ready: false, reason: "provider not registered" };
  if (!connector.hasCredentials) {
    return {
      connector,
      provider,
      ready: false,
      reason: provider.auth.kind === "token" ? "chưa có thông tin đăng nhập" : "OAuth chưa hoàn tất",
    };
  }
  return { connector, provider, ready: true, reason: null };
}
