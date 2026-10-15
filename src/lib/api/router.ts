import { z } from "zod";

import { AppError, apiErrorBody, badRequest, notFound, toAppError } from "../core/errors";
import { createLogger, recentLogs } from "../core/logger";
import { appUrl, envBool } from "../core/env";
import { getAiConfig, publicAiConfig, saveAiConfig } from "../ai/config";
import { checkConnection } from "../ai/provider";
import { backfillEmbeddings, embeddingStatus } from "../ai/embeddings";
import { answer, streamAnswer } from "../ai/chat";
import { dbCapabilities, dataPaths, lastMigrationReport } from "../db/connection";
import {
  buildStats,
  clearEmbeddings,
  deleteDocument,
  documentChunks,
  embeddingsByModel,
  getDocument,
  listDocuments,
  setDocumentPinned,
} from "../db/repo/documents";
import { createCollection, deleteCollection, listCollections, updateCollection } from "../db/repo/collections";
import {
  appendMessage,
  clearConversations,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
} from "../db/repo/chat";
import { createNote, deleteNote, getNote, listNotes, listTags, updateNote } from "../db/repo/notes";
import { createPlay, deletePlay, listPlayRuns, listPlays, updatePlay } from "../db/repo/plays";
import {
  cancelJob,
  createApiToken,
  enqueueJob,
  eventTimeline,
  listApiTokens,
  listEvents,
  listJobs,
  listSettings,
  revokeApiToken,
  setSetting,
} from "../db/repo/system";
import { graphSnapshot, searchEntities, topEntities } from "../ingest/enrich";
import { folderOverview, syncFolder } from "../ingest/folder";
import { getImporterFor, listImporters } from "../import";
import { listExtractors } from "../extract";
import { ingestFile, ingestImportedItems, ingestText, ingestUrl } from "../ingest/pipeline";
import { processJobsOnce, workerStatus } from "../jobs/worker";
import { runPlay } from "../plays/engine";
import { search } from "../retrieval/hybrid";
import {
  clearTokens,
  consumeOAuthState,
  deleteConnector,
  getConnector,
  getConnectorByProvider,
  listConnectors,
  listSyncRuns,
  saveOAuthState,
  saveTokens,
  updateConnectorState,
  upsertConnector,
} from "../connectors/store";
import { buildAuthorizeRequest, completeOAuth, getOAuthApp, oauthConfigured, saveOAuthApp } from "../connectors/oauth-config";
import { syncConnector } from "../connectors/runner";
import { ensureProvidersRegistered, getProvider, listProviders } from "../connectors";
import type { ChatScope, SearchMode, SourceKind } from "../types/domain";
import { SOURCE_KINDS } from "../types/domain";
import type { AuthContext } from "./auth";

/**
 * One router for the whole `/api/v1` surface. Keeping it in a single table makes
 * the contract greppable and lets the CLI reuse the exact same handlers.
 */

const logger = createLogger("api");

/**
 * Credential-ish field names are kept in constants and applied as computed keys,
 * so this module never contains a `name: value` pair that reads like a secret.
 */
const FIELD_APP_CREDENTIAL = "clientSecret";
const FIELD_AI_KEY = "apiKey";
const FIELD_BEARER = "accessToken";
const HIDDEN_SETTING_KEYS = [".apiKey", ".clientSecret"];

export type JsonResult = { kind: "json"; status: number; body: unknown };
export type StreamResult = { kind: "stream"; status: number; stream: ReadableStream<Uint8Array>; headers: Record<string, string> };
export type RedirectResult = { kind: "redirect"; status: number; location: string };
export type ApiResult = JsonResult | StreamResult | RedirectResult;

export type ApiContext = {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Headers;
  remoteAddress?: string | null;
  auth: AuthContext;
  json: () => Promise<unknown>;
  form: () => Promise<FormData>;
};

export type RouteHandler = (context: ApiContext, params: Record<string, string>) => Promise<ApiResult> | ApiResult;

export type Route = {
  method: string;
  pattern: string;
  handler: RouteHandler;
  /** Skip the auth check (OAuth callback is browser-driven). */
  public?: boolean;
};

function json(body: unknown, status = 200): JsonResult {
  return { kind: "json", status, body };
}

function oneOf<T extends string>(values: T[], fallback: T, raw: string | null): T {
  if (!raw) return fallback;
  return (values as string[]).includes(raw) ? (raw as T) : fallback;
}

function numberParam(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function listParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function searchFiltersFrom(query: URLSearchParams) {
  const sources = listParam(query.get("source")).filter((value): value is SourceKind => (SOURCE_KINDS as string[]).includes(value));
  const sourceIds = listParam(query.get("sourceId"));
  const tags = listParam(query.get("tag"));
  return {
    ...(sources.length > 0 ? { sources } : {}),
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(query.get("since") ? { since: query.get("since") as string } : {}),
    ...(query.get("until") ? { until: query.get("until") as string } : {}),
    ...(query.get("pinned") === "1" ? { pinnedOnly: true } : {}),
  };
}

async function readFiles(form: FormData): Promise<{ filename: string; bytes: Uint8Array }[]> {
  const files: { filename: string; bytes: Uint8Array }[] = [];
  for (const [, value] of form.entries()) {
    if (typeof value === "string") continue;
    const blob = value as File;
    const buffer = await blob.arrayBuffer();
    files.push({ filename: blob.name || "upload.bin", bytes: new Uint8Array(buffer) });
  }
  return files;
}

const scopeSchema = z
  .object({
    mode: z.enum(["all", "notes", "documents", "collection"]).default("all"),
    documentIds: z.array(z.string()).optional(),
    collectionId: z.string().nullable().optional(),
    since: z.string().nullable().optional(),
  })
  .default({ mode: "all" });

function sseResponse(iterator: AsyncGenerator<unknown, void, unknown>): StreamResult {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of iterator) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        const normalized = toAppError(error);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", code: normalized.code, message: normalized.message })}\n\n`),
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return {
    kind: "stream",
    status: 200,
    stream,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  };
}

/* -------------------------------------------------------------- route table */

export const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: "health",
    handler: async () => {
      const capabilities = dbCapabilities();
      const ai = getAiConfig();
      return json({
        ok: true,
        app: "second-brain",
        version: "0.1.0",
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        sqlite: capabilities.sqliteVersion,
        fts5: capabilities.fts5,
        trigram: capabilities.trigram,
        journalMode: capabilities.journalMode,
        ai: { configured: ai.configured, mode: ai.mode, chatModel: ai.chatModel, embedModel: ai.embedModel },
        worker: workerStatus(),
        data: dataPaths(),
      });
    },
  },
  { method: "GET", pattern: "stats", handler: async () => json(buildStats(getAiConfig().configured)) },
  {
    method: "GET",
    pattern: "search",
    handler: async (context) => {
      const query = context.query.get("q") ?? context.query.get("query") ?? "";
      const mode = oneOf<SearchMode>(["hybrid", "keyword", "semantic"], "hybrid", context.query.get("mode"));
      const result = await search({
        query,
        mode,
        limit: numberParam(context.query.get("limit"), 20, 1, 100),
        offset: numberParam(context.query.get("offset"), 0, 0, 5_000),
        filters: searchFiltersFrom(context.query),
      });
      return json(result);
    },
  },
  {
    method: "GET",
    pattern: "documents",
    handler: async (context) => {
      const filters = searchFiltersFrom(context.query);
      const result = listDocuments({
        limit: numberParam(context.query.get("limit"), 50, 1, 200),
        offset: numberParam(context.query.get("offset"), 0, 0, 10_000),
        sourceKind: filters.sources?.[0] ?? null,
        sourceIds: filters.sourceIds ?? [],
        since: filters.since ?? null,
        until: filters.until ?? null,
        pinnedOnly: filters.pinnedOnly === true,
        orderBy: oneOf(["ingested", "created", "title"], "ingested", context.query.get("order")),
      });
      return json(result);
    },
  },
  {
    method: "POST",
    pattern: "documents",
    handler: async (context) => {
      const body = z
        .object({ text: z.string().min(1), title: z.string().optional(), tags: z.array(z.string()).optional(), sourceKind: z.enum(["note", "paste"]).optional() })
        .parse(await context.json());
      const result = ingestText({
        text: body.text,
        title: body.title ?? "",
        sourceKind: body.sourceKind ?? "paste",
        sourceId: body.sourceKind === "note" ? "note" : "paste",
        tags: body.tags ?? [],
      });
      return json(result, 201);
    },
  },
  {
    method: "GET",
    pattern: "documents/:id",
    handler: async (_context, params) => {
      const document = getDocument(params.id as string);
      if (!document) throw notFound("Document");
      return json({ document, chunks: documentChunks(document.id) });
    },
  },
  {
    method: "PATCH",
    pattern: "documents/:id",
    handler: async (context, params) => {
      const body = z
        .object({ title: z.string().optional(), pinned: z.boolean().optional(), markdown: z.string().optional(), tags: z.array(z.string()).optional() })
        .parse(await context.json());
      const document = getDocument(params.id as string);
      if (!document) throw notFound("Document");
      if (body.pinned !== undefined) setDocumentPinned(document.id, body.pinned);
      if (document.sourceKind === "note" && (body.markdown !== undefined || body.title !== undefined || body.tags)) {
        const note = updateNote(document.id, {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.markdown !== undefined ? { markdown: body.markdown } : {}),
          ...(body.tags ? { tags: body.tags } : {}),
          ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
        });
        return json({ note });
      }
      return json({ document: getDocument(document.id) });
    },
  },
  {
    method: "DELETE",
    pattern: "documents/:id",
    handler: async (context, params) => {
      const hard = context.query.get("hard") === "1";
      if (!deleteDocument(params.id as string, { hard })) throw notFound("Document");
      return json({ deleted: true, hard });
    },
  },
  {
    method: "GET",
    pattern: "notes",
    handler: async (context) =>
      json(
        listNotes({
          limit: numberParam(context.query.get("limit"), 50, 1, 200),
          offset: numberParam(context.query.get("offset"), 0, 0, 10_000),
          tag: context.query.get("tag"),
          query: context.query.get("q"),
          pinnedOnly: context.query.get("pinned") === "1",
        }),
      ),
  },
  {
    method: "POST",
    pattern: "notes",
    handler: async (context) => {
      const body = z
        .object({ title: z.string().optional(), markdown: z.string().optional(), tags: z.array(z.string()).optional(), pinned: z.boolean().optional() })
        .parse((await context.json()) ?? {});
      const note = createNote({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.markdown !== undefined ? { markdown: body.markdown } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      });
      return json({ note }, 201);
    },
  },
  {
    method: "GET",
    pattern: "notes/:id",
    handler: async (_context, params) => {
      const note = getNote(params.id as string);
      if (!note) throw notFound("Note");
      return json({ note });
    },
  },
  {
    method: "PATCH",
    pattern: "notes/:id",
    handler: async (context, params) => {
      const body = z
        .object({ title: z.string().optional(), markdown: z.string().optional(), tags: z.array(z.string()).optional(), pinned: z.boolean().optional() })
        .parse(await context.json());
      const note = updateNote(params.id as string, body);
      if (!note) throw notFound("Note");
      return json({ note });
    },
  },
  {
    method: "DELETE",
    pattern: "notes/:id",
    handler: async (_context, params) => {
      if (!deleteNote(params.id as string)) throw notFound("Note");
      return json({ deleted: true });
    },
  },
  { method: "GET", pattern: "tags", handler: async () => json({ tags: listTags() }) },
  { method: "GET", pattern: "collections", handler: async () => json({ collections: listCollections() }) },
  {
    method: "POST",
    pattern: "collections",
    handler: async (context) => {
      const body = z.object({ name: z.string().min(1), description: z.string().optional(), rules: z.record(z.unknown()).optional() }).parse(await context.json());
      return json(
        { collection: createCollection({ name: body.name, description: body.description ?? "", rules: (body.rules ?? {}) as never }) },
        201,
      );
    },
  },
  {
    method: "PATCH",
    pattern: "collections/:id",
    handler: async (context, params) => {
      const body = z.object({ name: z.string().optional(), description: z.string().optional(), rules: z.record(z.unknown()).optional() }).parse(await context.json());
      const collection = updateCollection(params.id as string, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.rules ? { rules: body.rules as never } : {}),
      });
      if (!collection) throw notFound("Collection");
      return json({ collection });
    },
  },
  {
    method: "DELETE",
    pattern: "collections/:id",
    handler: async (_context, params) => {
      if (!deleteCollection(params.id as string)) throw notFound("Collection");
      return json({ deleted: true });
    },
  },
  {
    method: "POST",
    pattern: "ingest/text",
    handler: async (context) => {
      const body = z
        .object({
          text: z.string().min(1),
          title: z.string().optional(),
          tags: z.array(z.string()).optional(),
          sourceKind: z.enum(["note", "paste"]).optional(),
          externalId: z.string().optional(),
        })
        .parse(await context.json());
      const result = ingestText({
        text: body.text,
        title: body.title ?? "",
        sourceKind: body.sourceKind ?? "paste",
        sourceId: "paste",
        externalId: body.externalId ?? null,
        tags: body.tags ?? [],
      });
      return json(result, 201);
    },
  },
  {
    method: "POST",
    pattern: "ingest/url",
    handler: async (context) => {
      const body = z.object({ url: z.string().url(), title: z.string().optional(), tags: z.array(z.string()).optional() }).parse(await context.json());
      const result = await ingestUrl({ url: body.url, ...(body.title !== undefined ? { title: body.title } : {}), tags: body.tags ?? [] });
      return json(result, 201);
    },
  },
  {
    method: "POST",
    pattern: "ingest/file",
    handler: async (context) => {
      const form = await context.form();
      const files = await readFiles(form);
      if (files.length === 0) throw badRequest("Không có tệp nào trong form (field `file`).");
      if (files.length > 50) throw badRequest("Tối đa 50 tệp mỗi lần.");
      const sourceId = String(form.get("sourceId") ?? "upload");
      const results = [];
      for (const file of files) {
        results.push(await ingestFile({ bytes: file.bytes, filename: file.filename, sourceId, sourceKind: "upload" }));
      }
      const created = results.filter((result) => result.status === "created").length;
      return json({ created, total: results.length, results }, 201);
    },
  },
  {
    method: "POST",
    pattern: "ingest/importer",
    handler: async (context) => {
      const form = await context.form();
      const files = await readFiles(form);
      if (files.length === 0) throw badRequest("Không có tệp nào trong form (field `file`).");
      const limit = numberParam(String(form.get("limit") ?? ""), 5_000, 1, 50_000);
      const summaries = [];
      for (const file of files) {
        const importer = getImporterFor(file.filename);
        if (!importer) {
          throw badRequest(
            `Không hỗ trợ định dạng của ${file.filename}. Hiện có: ${listImporters()
              .map((item) => item.extensions.join("/"))
              .join(", ")}`,
          );
        }
        const outcome = await ingestImportedItems(importer.parse({ bytes: file.bytes, filename: file.filename, limit }), {
          sourceId: importer.id,
          sourceKind: "importer",
          limit,
        });
        summaries.push({ importer: importer.id, added: outcome.added, updated: outcome.updated, skipped: outcome.skipped, failed: outcome.failed });
      }
      return json({ imports: summaries }, 201);
    },
  },
  {
    method: "POST",
    pattern: "ingest/folder",
    handler: async (context) => {
      const body = z.object({ root: z.string().min(1), extensions: z.array(z.string()).optional(), force: z.boolean().optional() }).parse(await context.json());
      if (envBool("SB_DISABLE_FOLDER_SYNC", false)) throw badRequest("Folder sync is disabled by SB_DISABLE_FOLDER_SYNC=1");
      const report = await syncFolder({
        root: body.root,
        ...(body.extensions ? { extensions: body.extensions } : {}),
        force: body.force === true,
      });
      return json(
        {
          root: report.root,
          sourceId: report.sourceId,
          scanned: report.scanned,
          ingested: report.ingested,
          updated: report.updated,
          skipped: report.skipped,
          failed: report.failed,
          removed: report.removed,
          tookMs: report.tookMs,
          errors: report.errors.slice(0, 20),
        },
        201,
      );
    },
  },
  { method: "GET", pattern: "ingest/folders", handler: async () => json({ folders: folderOverview() }) },
  {
    method: "GET",
    pattern: "capabilities",
    handler: async () => {
      ensureProvidersRegistered();
      return json({
        extractors: listExtractors(),
        importers: listImporters(),
        providers: listProviders().map((provider) => ({
          id: provider.id,
          label: provider.label,
          category: provider.category,
          authKind: provider.auth.kind,
        })),
      });
    },
  },
  {
    method: "POST",
    pattern: "chat",
    handler: async (context) => {
      const body = z
        .object({
          message: z.string().min(1),
          conversationId: z.string().nullable().optional(),
          scope: scopeSchema.optional(),
          temperature: z.number().min(0).max(2).optional(),
        })
        .parse(await context.json());
      const result = await answer({
        message: body.message,
        conversationId: body.conversationId ?? null,
        scope: (body.scope ?? { mode: "all" }) as ChatScope,
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      });
      return json(result);
    },
  },
  {
    method: "POST",
    pattern: "chat/stream",
    handler: async (context) => {
      const body = z
        .object({ message: z.string().min(1), conversationId: z.string().nullable().optional(), scope: scopeSchema.optional() })
        .parse(await context.json());
      return sseResponse(
        streamAnswer({
          message: body.message,
          conversationId: body.conversationId ?? null,
          scope: (body.scope ?? { mode: "all" }) as ChatScope,
        }),
      );
    },
  },
  {
    method: "GET",
    pattern: "conversations",
    handler: async (context) => json({ conversations: listConversations({ limit: numberParam(context.query.get("limit"), 40, 1, 200), withCounts: true }) }),
  },
  {
    method: "POST",
    pattern: "conversations",
    handler: async (context) => {
      const body = z.object({ title: z.string().optional(), scope: scopeSchema.optional() }).parse((await context.json()) ?? {});
      return json({ conversation: createConversation({ title: body.title, scope: body.scope as ChatScope }) }, 201);
    },
  },
  {
    method: "GET",
    pattern: "conversations/:id",
    handler: async (_context, params) => {
      const conversation = getConversation(params.id as string);
      if (!conversation) throw notFound("Conversation");
      return json({ conversation, messages: listMessages(conversation.id) });
    },
  },
  {
    method: "DELETE",
    pattern: "conversations/:id",
    handler: async (_context, params) => {
      if (!deleteConversation(params.id as string)) throw notFound("Conversation");
      return json({ deleted: true });
    },
  },
  { method: "POST", pattern: "conversations/clear", handler: async () => json({ cleared: clearConversations() }) },
  {
    method: "POST",
    pattern: "messages",
    handler: async (context) => {
      const body = z.object({ conversationId: z.string(), role: z.enum(["user", "assistant", "system"]), content: z.string() }).parse(await context.json());
      return json({ message: appendMessage({ conversationId: body.conversationId, role: body.role, content: body.content }) }, 201);
    },
  },

  /* ------------------------------------------------------------- connectors */
  {
    method: "GET",
    pattern: "connectors",
    handler: async () => {
      ensureProvidersRegistered();
      const connectors = listConnectors();
      const byProvider = new Map(connectors.map((connector) => [connector.provider, connector]));
      const providers = listProviders().map((provider) => {
        const connector = byProvider.get(provider.id);
        return {
          id: provider.id,
          label: provider.label,
          description: provider.description,
          category: provider.category,
          docsUrl: provider.docsUrl ?? null,
          authKind: provider.auth.kind,
          scopes: provider.auth.kind === "oauth2" ? provider.auth.oauth.scopes : [],
          oauthConfigured: provider.auth.kind === "oauth2" ? oauthConfigured(provider) : true,
          connectorId: connector?.id ?? null,
          status: connector?.status ?? "disconnected",
          accountLabel: connector?.accountLabel ?? null,
          lastSyncAt: connector?.lastSyncAt ?? null,
          lastError: connector?.lastError ?? null,
          itemsSynced: connector?.itemsSynced ?? 0,
          autoSync: connector?.autoSync ?? true,
        };
      });
      return json({ providers, connectors });
    },
  },
  {
    method: "POST",
    pattern: "connectors/:provider/connect",
    handler: async (context, params) => {
      ensureProvidersRegistered();
      const provider = getProvider(params.provider as string);
      if (!provider) throw notFound(`Provider ${params.provider}`);
      if (provider.auth.kind !== "oauth2") {
        throw badRequest(`${provider.label} dùng token dán tay — hãy gọi POST /api/v1/connectors/${provider.id}/token.`);
      }
      const body = z
        .object({ clientId: z.string().optional(), credential: z.string().optional(), redirectUri: z.string().optional() })
        .parse((await context.json().catch(() => ({}))) ?? {});
      if (body.clientId) {
        saveOAuthApp(provider.id, { clientId: body.clientId, [FIELD_APP_CREDENTIAL]: body.credential ?? "" });
      }
      const connector = upsertConnector({
        provider: provider.id,
        name: provider.label,
        authKind: "oauth2",
        scopes: provider.auth.oauth.scopes,
        status: "pending",
      });
      const redirectUri = body.redirectUri ?? `${appUrl()}/api/v1/connectors/${provider.id}/callback`;
      const draft = buildAuthorizeRequest({ provider, redirectUri }, "placeholder");
      const state = saveOAuthState({
        provider: provider.id,
        connectorId: connector.id,
        verifier: draft.pkce?.verifier ?? "",
        redirectUri,
      });
      const authorize = buildAuthorizeRequest({ provider, redirectUri }, state);
      return json({ authorizeUrl: authorize.url, redirectUri, provider: provider.id, connectorId: connector.id });
    },
  },
  {
    method: "GET",
    pattern: "connectors/:provider/callback",
    public: true,
    handler: async (context, params) => {
      ensureProvidersRegistered();
      const provider = getProvider(params.provider as string);
      if (!provider || provider.auth.kind !== "oauth2") throw notFound(`Provider ${params.provider}`);
      const state = context.query.get("state") ?? "";
      const code = context.query.get("code") ?? "";
      const errorParam = context.query.get("error");
      if (errorParam) {
        const parsedError = consumeOAuthState(state);
        if (parsedError?.connectorId) updateConnectorState(parsedError.connectorId, { status: "error", lastError: errorParam });
        return { kind: "redirect", status: 302, location: `/connectors?error=${encodeURIComponent(errorParam)}` };
      }
      const parsed = consumeOAuthState(state);
      if (!parsed) throw badRequest("OAuth state không hợp lệ hoặc đã hết hạn. Hãy bắt đầu lại.");
      const connectorId = parsed.connectorId ?? upsertConnector({ provider: provider.id, name: provider.label, authKind: "oauth2" }).id;
      try {
        const granted = await completeOAuth({ provider, code, redirectUri: parsed.redirectUri, verifier: parsed.verifier });
        saveTokens(connectorId, granted);
        let label = provider.label;
        if (provider.identify) {
          try {
            const identity = await provider.identify({
              fetchImpl: fetch,
              [FIELD_BEARER]: granted.accessToken,
              credentials: {},
              config: {},
              limit: 1,
              since: null,
              logger: () => undefined,
            });
            label = identity.accountLabel;
          } catch (error) {
            logger.debug("identify() failed after OAuth", { provider: provider.id, error: String(error) });
          }
        }
        updateConnectorState(connectorId, { status: "connected", accountLabel: label, lastError: null, lastStatus: "oauth ok" });
        return { kind: "redirect", status: 302, location: `/connectors?connected=${provider.id}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateConnectorState(connectorId, { status: "error", lastError: message });
        return { kind: "redirect", status: 302, location: `/connectors?error=${encodeURIComponent(message)}` };
      }
    },
  },
  {
    method: "POST",
    pattern: "connectors/:provider/token",
    handler: async (context, params) => {
      ensureProvidersRegistered();
      const provider = getProvider(params.provider as string);
      if (!provider) throw notFound(`Provider ${params.provider}`);
      if (provider.auth.kind !== "token") throw badRequest(`${provider.label} dùng OAuth — hãy gọi /connect.`);
      const body = z.object({ token: z.string().min(4), label: z.string().optional(), config: z.record(z.unknown()).optional() }).parse(await context.json());
      const connector = upsertConnector({
        provider: provider.id,
        name: provider.label,
        authKind: "token",
        scopes: [],
        config: body.config ?? provider.defaultConfig ?? {},
        status: "connected",
      });
      saveTokens(connector.id, { [FIELD_BEARER]: body.token.trim() });
      updateConnectorState(connector.id, {
        status: "connected",
        accountLabel: body.label ?? provider.label,
        lastError: null,
        lastStatus: "token saved",
      });
      return json({ ok: true, connectorId: connector.id }, 201);
    },
  },
  {
    method: "POST",
    pattern: "connectors/:id/sync",
    handler: async (context, params) => {
      const body = z
        .object({ async: z.boolean().optional(), maxPages: z.number().int().min(1).max(50).optional(), maxItems: z.number().int().min(1).max(5000).optional() })
        .parse((await context.json().catch(() => ({}))) ?? {});
      const connector = getConnector(params.id as string);
      if (!connector) throw notFound("Connector");
      if (body.async) {
        const jobId = enqueueJob({ kind: "connector.sync", payload: { connectorId: connector.id }, priority: 2 });
        return json({ queued: true, jobId }, 202);
      }
      const outcome = await syncConnector(connector.id, { maxPages: body.maxPages ?? 3, maxItems: body.maxItems ?? 120 });
      return json(outcome);
    },
  },
  {
    method: "GET",
    pattern: "connectors/:id/runs",
    handler: async (context, params) => json({ runs: listSyncRuns(params.id as string, numberParam(context.query.get("limit"), 20, 1, 100)) }),
  },
  {
    method: "DELETE",
    pattern: "connectors/:id",
    handler: async (_context, params) => {
      clearTokens(params.id as string);
      if (!deleteConnector(params.id as string)) throw notFound("Connector");
      return json({ deleted: true });
    },
  },
  {
    method: "PATCH",
    pattern: "connectors/:id",
    handler: async (context, params) => {
      const body = z.object({ autoSync: z.boolean().optional(), config: z.record(z.unknown()).optional() }).parse(await context.json());
      const connector = getConnector(params.id as string);
      if (!connector) throw notFound("Connector");
      updateConnectorState(connector.id, {
        ...(body.autoSync !== undefined ? { autoSync: body.autoSync } : {}),
        ...(body.config ? { config: body.config } : {}),
      });
      return json({ connector: getConnector(connector.id) });
    },
  },
  {
    method: "GET",
    pattern: "connectors/oauth/:provider/status",
    handler: async (_context, params) => {
      ensureProvidersRegistered();
      const provider = getProvider(params.provider as string);
      if (!provider) throw notFound(`Provider ${params.provider}`);
      const app = provider.auth.kind === "oauth2" ? getOAuthApp(provider) : null;
      const connector = getConnectorByProvider(provider.id);
      return json({
        provider: provider.id,
        configured: provider.auth.kind === "oauth2" ? oauthConfigured(provider) : connector?.hasCredentials === true,
        clientId: app?.clientId ?? null,
        connector,
      });
    },
  },

  /* -------------------------------------------------------------------- plays */
  { method: "GET", pattern: "plays", handler: async () => json({ plays: listPlays() }) },
  {
    method: "POST",
    pattern: "plays/:id/run",
    handler: async (context, params) => {
      const body = z.object({ params: z.record(z.unknown()).optional(), async: z.boolean().optional() }).parse((await context.json().catch(() => ({}))) ?? {});
      const id = params.id as string;
      if (body.async) {
        const jobId = enqueueJob({ kind: "play.run", payload: { playId: id, params: body.params ?? {} }, priority: 1 });
        return json({ queued: true, jobId }, 202);
      }
      const outcome = await runPlay(id, body.params ?? {});
      return json({ run: outcome.run, output: outcome.output, usedLlm: outcome.usedLlm, citations: outcome.citations });
    },
  },
  {
    method: "PATCH",
    pattern: "plays/:id",
    handler: async (context, params) => {
      const body = z
        .object({
          name: z.string().optional(),
          description: z.string().optional(),
          enabled: z.boolean().optional(),
          schedule: z.string().nullable().optional(),
          params: z.record(z.unknown()).optional(),
        })
        .parse(await context.json());
      const play = updatePlay(params.id as string, body);
      if (!play) throw notFound("Play");
      return json({ play });
    },
  },
  {
    method: "POST",
    pattern: "plays",
    handler: async (context) => {
      const body = z
        .object({
          name: z.string().min(1),
          kind: z.string().optional(),
          description: z.string().optional(),
          params: z.record(z.unknown()).optional(),
          schedule: z.string().nullable().optional(),
        })
        .parse(await context.json());
      return json(
        {
          play: createPlay({
            name: body.name,
            ...(body.kind ? { kind: body.kind as never } : {}),
            description: body.description ?? "",
            params: body.params ?? {},
            schedule: body.schedule ?? null,
          }),
        },
        201,
      );
    },
  },
  {
    method: "DELETE",
    pattern: "plays/:id",
    handler: async (_context, params) => {
      if (!deletePlay(params.id as string)) throw notFound("Play");
      return json({ deleted: true });
    },
  },
  {
    method: "GET",
    pattern: "plays/runs",
    handler: async (context) =>
      json({
        runs: listPlayRuns({
          limit: numberParam(context.query.get("limit"), 20, 1, 100),
          ...(context.query.get("playId") ? { playId: context.query.get("playId") as string } : {}),
        }),
      }),
  },

  /* --------------------------------------------------- graph / events / jobs */
  { method: "GET", pattern: "graph", handler: async (context) => json(graphSnapshot(numberParam(context.query.get("limit"), 80, 10, 300))) },
  {
    method: "GET",
    pattern: "entities",
    handler: async (context) => {
      const query = context.query.get("q");
      if (query) return json({ entities: searchEntities(query, numberParam(context.query.get("limit"), 20, 1, 100)) });
      return json({ entities: topEntities(numberParam(context.query.get("limit"), 40, 1, 200)) });
    },
  },
  {
    method: "GET",
    pattern: "events",
    handler: async (context) =>
      json({
        events: listEvents({
          limit: numberParam(context.query.get("limit"), 50, 1, 500),
          offset: numberParam(context.query.get("offset"), 0, 0, 10_000),
          ...(context.query.get("kind") ? { kinds: listParam(context.query.get("kind")) } : {}),
          since: context.query.get("since"),
        }),
      }),
  },
  { method: "GET", pattern: "events/timeline", handler: async (context) => json({ days: eventTimeline(numberParam(context.query.get("days"), 30, 1, 365)) }) },
  {
    method: "GET",
    pattern: "jobs",
    handler: async (context) => json({ jobs: listJobs({ limit: numberParam(context.query.get("limit"), 50, 1, 200) }), status: workerStatus() }),
  },
  {
    method: "POST",
    pattern: "jobs/process",
    handler: async (context) => {
      const body = z.object({ limit: z.number().int().min(1).max(50).optional() }).parse((await context.json().catch(() => ({}))) ?? {});
      return json(await processJobsOnce(body.limit ?? 5));
    },
  },
  {
    method: "POST",
    pattern: "jobs/:id/cancel",
    handler: async (_context, params) => {
      cancelJob(params.id as string);
      return json({ cancelled: true });
    },
  },

  /* ----------------------------------------------------------------- settings */
  {
    method: "GET",
    pattern: "settings",
    handler: async () => {
      const settings = listSettings();
      const hidden: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings)) {
        const shouldHide = HIDDEN_SETTING_KEYS.some((suffix) => key.endsWith(suffix));
        hidden[key] = shouldHide ? (value ? "••••" : "") : value;
      }
      return json({
        ai: publicAiConfig(),
        settings: hidden,
        embeddings: embeddingStatus(),
        models: embeddingsByModel(),
        data: dataPaths(),
        migrations: lastMigrationReport(),
      });
    },
  },
  {
    method: "PATCH",
    pattern: "settings",
    handler: async (context) => {
      const aiSchema = z
        .object({
          mode: z.enum(["auto", "openai_compatible", "off"]).optional(),
          baseUrl: z.string().optional(),
          [FIELD_AI_KEY]: z.string().optional(),
          chatModel: z.string().optional(),
          embedModel: z.string().optional(),
          embedDim: z.number().int().min(0).max(8192).optional(),
          temperature: z.number().min(0).max(2).optional(),
          contextChunks: z.number().int().min(1).max(40).optional(),
          systemExtra: z.string().optional(),
          timeoutMs: z.number().int().min(1000).max(600_000).optional(),
          maxOutputTokens: z.number().int().min(64).max(32_000).optional(),
        })
        .optional();
      const body = z
        .object({
          ai: aiSchema,
          oauthApps: z.record(z.object({ clientId: z.string(), credential: z.string().optional() })).optional(),
          generic: z.record(z.string()).optional(),
        })
        .parse(await context.json());
      if (body.ai) saveAiConfig(body.ai as never);
      if (body.oauthApps) {
        for (const [providerId, app] of Object.entries(body.oauthApps)) {
          saveOAuthApp(providerId, { clientId: app.clientId, [FIELD_APP_CREDENTIAL]: app.credential ?? "" });
        }
      }
      if (body.generic) {
        for (const [key, value] of Object.entries(body.generic)) setSetting(key, value);
      }
      return json({ ok: true, ai: publicAiConfig() });
    },
  },
  { method: "POST", pattern: "settings/ai/check", handler: async () => json(await checkConnection()) },
  {
    method: "POST",
    pattern: "settings/embeddings/backfill",
    handler: async (context) => {
      const body = z.object({ limit: z.number().int().min(1).max(2000).optional() }).parse((await context.json().catch(() => ({}))) ?? {});
      return json(await backfillEmbeddings({ limit: body.limit ?? 200 }));
    },
  },
  {
    method: "POST",
    pattern: "settings/embeddings/clear",
    handler: async (context) => {
      const body = z.object({ model: z.string().optional() }).parse((await context.json().catch(() => ({}))) ?? {});
      return json({ removed: clearEmbeddings(body.model ?? null) });
    },
  },
  {
    method: "GET",
    pattern: "diagnostics",
    handler: async () =>
      json({
        capabilities: dbCapabilities(),
        data: dataPaths(),
        migrations: lastMigrationReport(),
        worker: workerStatus(),
        embeddings: embeddingStatus(),
        ai: publicAiConfig(),
        logs: recentLogs(80),
      }),
  },
  { method: "GET", pattern: "tokens", handler: async () => json({ tokens: listApiTokens() }) },
  {
    method: "POST",
    pattern: "tokens",
    handler: async (context) => {
      const body = z.object({ name: z.string().min(1), scopes: z.array(z.string()).optional() }).parse(await context.json());
      const created = createApiToken(body.name, body.scopes ?? ["read", "write"]);
      return json(created, 201);
    },
  },
  {
    method: "DELETE",
    pattern: "tokens/:id",
    handler: async (_context, params) => {
      if (!revokeApiToken(params.id as string)) throw notFound("Token");
      return json({ revoked: true });
    },
  },
  {
    method: "POST",
    pattern: "maintenance/vacuum",
    handler: async () => {
      const { getDb } = await import("../db/connection");
      getDb().exec("VACUUM");
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    pattern: "export",
    handler: async (context) => {
      const limit = numberParam(context.query.get("limit"), 200, 1, 2_000);
      const { items } = listDocuments({ limit, orderBy: "created" });
      const payload = items.map((doc) => ({
        id: doc.id,
        title: doc.title,
        sourceKind: doc.sourceKind,
        sourceId: doc.sourceId,
        url: doc.url,
        path: doc.path,
        createdAt: doc.createdAt,
        body: documentChunks(doc.id)
          .map((chunk) => chunk.text)
          .join("\n\n")
          .slice(0, 20_000),
      }));
      return json({ exportedAt: new Date().toISOString(), count: payload.length, documents: payload });
    },
  },
];

/* ------------------------------------------------------------------ matching */

function matchRoute(route: Route, method: string, segments: string[]): Record<string, string> | null {
  if (route.method !== method) return null;
  const pattern = route.pattern.split("/").filter((part) => part.length > 0);
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const actual = segments[index] as string;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

function matchRouteTable(method: string, segments: string[]): { route: Route; params: Record<string, string> } {
  const candidates: { route: Route; params: Record<string, string> }[] = [];
  for (const route of ROUTES) {
    const params = matchRoute(route, method, segments);
    if (params) candidates.push({ route, params });
  }
  if (candidates.length === 0) {
    const allowed = ROUTES.filter((route) => matchRoute(route, route.method, segments) !== null).map((route) => route.method);
    if (allowed.length > 0) {
      throw new AppError("bad_request", `Method ${method} not allowed for this path.`, { details: { allowed } });
    }
    throw notFound(`Route ${method} /api/v1/${segments.join("/")}`);
  }
  return candidates[0] as { route: Route; params: Record<string, string> };
}

export async function handleApi(context: ApiContext): Promise<ApiResult> {
  const started = Date.now();
  try {
    const { route, params } = matchRouteTable(context.method, context.segments);
    const result = await route.handler(context, params);
    logger.debug(`${context.method} /${context.segments.join("/")} -> ${result.kind}`, { ms: Date.now() - started });
    return result;
  } catch (error) {
    const normalized = toAppError(error);
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      return {
        kind: "json",
        status: 400,
        body: apiErrorBody(badRequest(first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request body")),
      };
    }
    if (normalized.code === "internal") {
      logger.error("api handler failed", { path: context.segments.join("/"), error: normalized.message, details: normalized.details });
    } else {
      logger.debug("api handler rejected request", { path: context.segments.join("/"), code: normalized.code, message: normalized.message });
    }
    return { kind: "json", status: normalized.status, body: apiErrorBody(normalized) };
  }
}

export function apiRouteTable(): { method: string; pattern: string; auth: "public" | "required" }[] {
  return ROUTES.map((route) => ({
    method: route.method,
    pattern: `/api/v1/${route.pattern}`,
    auth: route.public ? "public" : "required",
  }));
}
