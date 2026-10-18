import { beforeEach, describe, expect, it } from "vitest";

import { handleApi, type ApiContext } from "@/lib/api/router";
import { useTempDataDir } from "./helpers/env";

/**
 * The API is exercised through the same router the HTTP route uses, with an
 * in-memory context — so these tests cover routing, validation and the error
 * envelope without booting a server.
 */

function makeContext(method: string, requestPath: string, options: { body?: unknown; query?: string } = {}): ApiContext {
  const segments = requestPath.split("/").filter((part) => part.length > 0);
  const url = new URL(`http://localhost/api/v1/${segments.join("/")}${options.query ?? ""}`);
  return {
    method,
    segments,
    query: url.searchParams,
    headers: new Headers(),
    remoteAddress: "127.0.0.1",
    auth: { mode: "loopback" },
    json: async () => options.body ?? null,
    form: async () => new FormData(),
  };
}

async function call(
  method: string,
  requestPath: string,
  options: { body?: unknown; query?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const result = await handleApi(makeContext(method, requestPath, options));
  if (result.kind !== "json") throw new Error(`expected a JSON result, received ${result.kind}`);
  return { status: result.status, body: result.body };
}

beforeEach(() => {
  useTempDataDir();
});

describe("api router", () => {
  it("reports capabilities on /health", async () => {
    const { status, body } = await call("GET", "health");
    const payload = body as { ok: boolean; fts5: boolean; sqlite: string; worker: { running: boolean } };
    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.fts5).toBe(true);
    expect(payload.sqlite).toMatch(/\d+\.\d+/);
  });

  it("returns an empty but valid stats snapshot", async () => {
    const { body } = await call("GET", "stats");
    const payload = body as { documents: number; chunks: number; aiConfigured: boolean; bySource: unknown[] };
    expect(payload.documents).toBe(0);
    expect(payload.chunks).toBe(0);
    expect(payload.aiConfigured).toBe(false);
    expect(Array.isArray(payload.bySource)).toBe(true);
  });

  it("ingests text over the API and finds it again", async () => {
    const created = await call("POST", "ingest/text", {
      body: { text: "Biên bản họp với khách hàng A về gói dịch vụ mới.", title: "Biên bản A", tags: ["khach-hang"] },
    });
    expect(created.status).toBe(201);
    const documentId = (created.body as { documentId: string }).documentId;
    expect(documentId.length).toBeGreaterThan(5);

    const found = await call("GET", "search", { query: "?q=bien ban khach hang" });
    const hits = (found.body as { hits: { documentId: string; title: string }[]; total: number }).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.documentId).toBe(documentId);

    const detail = await call("GET", `documents/${documentId}`);
    const payload = detail.body as { document: { title: string }; chunks: unknown[] };
    expect(payload.document.title).toBe("Biên bản A");
    expect(payload.chunks.length).toBeGreaterThan(0);
  });

  it("exposes the curator map and distils a document over the API", async () => {
    const created = await call("POST", "ingest/text", {
      body: {
        text: "Backpart molding keeps the heel counter in shape. Do not overheat the counter.",
        title: "MO - FTW.02 Backpart Molding",
        tags: ["guideline"],
      },
    });
    const documentId = (created.body as { documentId: string }).documentId;

    const index = await call("GET", "curator/index");
    expect(index.status).toBe(200);
    expect((index.body as { totals: { documents: number } }).totals.documents).toBe(1);
    expect((index.body as { coverage: { tagged: number } }).coverage.tagged).toBeCloseTo(1, 5);

    const health = await call("GET", "curator/health");
    expect(health.status).toBe(200);
    expect((health.body as { totals: { documents: number } }).totals.documents).toBe(1);

    const distilled = await call("POST", "curator/distill", {
      body: { documentId, template: "guideline", lang: "vi", save: true },
    });
    expect(distilled.status).toBe(200);
    const payload = distilled.body as { markdown: string; noteId: string | null };
    expect(payload.markdown).toContain("## Mục đích");
    expect(payload.noteId).toBeTruthy();
  });

  it("stores document metadata used by the curator", async () => {
    const created = await call("POST", "ingest/text", {
      body: { text: "Product engineering guideline for the assembly line.", title: "MO - FTW.06" },
    });
    const documentId = (created.body as { documentId: string }).documentId;

    const patched = await call("PATCH", `documents/${documentId}`, {
      body: { meta: { code: "MO-FTW.06", version: "V3", status: "active" } },
    });
    expect(patched.status).toBe(200);

    const detail = await call("GET", `documents/${documentId}`);
    const meta = (detail.body as { document: { meta: Record<string, unknown> } }).document.meta;
    expect(meta.code).toBe("MO-FTW.06");
    expect(meta.status).toBe("active");
  });

  it("validates request bodies and returns the error envelope", async () => {
    const invalid = await call("POST", "ingest/text", { body: {} });
    expect(invalid.status).toBe(400);
    const envelope = invalid.body as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("bad_request");
    expect(envelope.error.message.length).toBeGreaterThan(3);
  });

  it("returns 404 for unknown routes and missing documents", async () => {
    const unknown = await call("GET", "does/not/exist");
    expect(unknown.status).toBe(404);

    const missing = await call("GET", "documents/doc_missing");
    expect(missing.status).toBe(404);
  });

  it("runs the notes lifecycle", async () => {
    const created = await call("POST", "notes", { body: { markdown: "# Ý tưởng\n\nỨng dụng nhỏ cho đội.", tags: ["y-tuong"] } });
    expect(created.status).toBe(201);
    const noteId = (created.body as { note: { document: { id: string } } }).note.document.id;

    const patched = await call("PATCH", `notes/${noteId}`, {
      body: { markdown: "# Ý tưởng\n\nỨng dụng nhỏ cho đội, thêm phần ngân sách.", title: "Ý tưởng v2" },
    });
    expect((patched.body as { note: { document: { title: string } } }).note.document.title).toBe("Ý tưởng v2");

    const list = await call("GET", "notes", { query: "?limit=10" });
    expect((list.body as { items: unknown[] }).items.length).toBe(1);

    const removed = await call("DELETE", `notes/${noteId}`);
    expect((removed.body as { deleted: boolean }).deleted).toBe(true);
  });

  it("answers from memory without a configured model", async () => {
    await call("POST", "ingest/text", { body: { text: "Ngân sách dự án Alpha là 120 triệu, chốt ngày 12/03.", title: "Ngân sách Alpha" } });
    const chat = await call("POST", "chat", { body: { message: "Ngân sách dự án Alpha là bao nhiêu?" } });
    expect(chat.status).toBe(200);
    const payload = chat.body as { usedLlm: boolean; content: string; citations: { title: string }[]; conversationId: string };
    expect(payload.usedLlm).toBe(false);
    expect(payload.content).toContain("no model configured");
    expect(payload.citations.length).toBeGreaterThan(0);
    expect(payload.citations[0]?.title).toBe("Ngân sách Alpha");

    const conversation = await call("GET", `conversations/${payload.conversationId}`);
    const messages = (conversation.body as { messages: { role: string }[] }).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("lists the connector catalogue and the enabled extractors", async () => {
    const connectors = await call("GET", "connectors");
    const providers = (connectors.body as { providers: { id: string; authKind: string }[] }).providers;
    expect(providers.map((provider) => provider.id)).toEqual(["gmail", "google_calendar", "google_drive", "outlook_mail", "slack", "notion"]);
    expect(providers.find((provider) => provider.id === "notion")?.authKind).toBe("token");
    expect(providers.find((provider) => provider.id === "gmail")?.authKind).toBe("oauth2");
    expect(providers.find((provider) => provider.id === "google_drive")?.authKind).toBe("oauth2");

    const capabilities = await call("GET", "capabilities");
    const payload = capabilities.body as { extractors: { id: string; extensions: string[] }[]; importers: { id: string }[] };
    expect(payload.extractors.map((extractor) => extractor.id)).toEqual(["text", "html", "pdf", "docx", "eml"]);
    expect(payload.extractors.some((extractor) => extractor.extensions.includes(".md"))).toBe(true);
    expect(payload.importers.map((importer) => importer.id).sort()).toEqual(["eml", "ics", "mbox", "notion_zip", "slack_zip"]);
  });

  it("queues and runs a play without a model", async () => {
    await call("POST", "ingest/text", { body: { text: "Việc cần làm: gửi báo giá cho khách hàng B trước thứ Sáu.", title: "Việc tuần này" } });
    const plays = await call("GET", "plays");
    const ids = (plays.body as { plays: { id: string }[] }).plays.map((play) => play.id);
    expect(ids).toContain("play_weekly_digest");

    const run = await call("POST", "plays/play_weekly_digest/run", { body: { params: { days: 7 } } });
    const payload = run.body as { output: string; usedLlm: boolean; run: { status: string } };
    expect(payload.usedLlm).toBe(false);
    expect(payload.output).toContain("Weekly digest");
    expect(payload.run.status).toBe("ok");

    const history = await call("GET", "plays/runs", { query: "?limit=5" });
    expect((history.body as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
  });

  it("exposes jobs, events and settings for the UI", async () => {
    const jobs = await call("GET", "jobs");
    expect((jobs.body as { status: { queue: Record<string, number> } }).status).toBeTruthy();

    const events = await call("GET", "events", { query: "?limit=5" });
    expect(Array.isArray((events.body as { events: unknown[] }).events)).toBe(true);

    const settings = await call("GET", "settings");
    const payload = settings.body as { ai: { configured: boolean }; data: { database: string } };
    expect(payload.ai.configured).toBe(false);
    expect(payload.data.database.length).toBeGreaterThan(0);
  });
});
