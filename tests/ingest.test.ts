import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { removeTempDataDir, useTempDataDir, writeFixture } from "./helpers/env";
import { getDocument, listDocuments, documentChunks, countChunks } from "@/lib/db/repo/documents";
import { createNote, getNote, listNotes, listTags, updateNote } from "@/lib/db/repo/notes";
import { syncFolder } from "@/lib/ingest/folder";
import { ingestFile, ingestText } from "@/lib/ingest/pipeline";
import { search } from "@/lib/retrieval/hybrid";
import { listEvents } from "@/lib/db/repo/system";
import { graphSnapshot } from "@/lib/ingest/enrich";

let dir = "";

beforeEach(() => {
  dir = useTempDataDir();
});

afterAll(() => {
  if (dir) removeTempDataDir(dir);
});

describe("ingest → index → search", () => {
  it("indexes text, finds it without accents, and returns a citation", async () => {
    const result = ingestText({
      text: "Báo cáo quý III\n\nDoanh thu tăng 18% so với quý trước, chủ yếu nhờ mảng dịch vụ.",
      title: "Báo cáo quý III",
      sourceKind: "paste",
      sourceId: "paste",
      tags: ["bao-cao"],
    });
    expect(result.status).toBe("created");
    expect(result.chunks).toBeGreaterThan(0);

    // No AI provider is configured in tests: keyword + trigram only.
    const response = await search({ query: "bao cao quy 3", mode: "hybrid", limit: 5 });
    expect(response.semanticAvailable).toBe(false);
    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits[0]?.title).toBe("Báo cáo quý III");
    expect(response.hits[0]?.snippet.toLowerCase()).toContain("doanh thu");
    expect(response.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("finds a document by a word that only appears in its title", async () => {
    ingestText({
      text: "Keep the enterprise tier at 40 USD per seat.",
      title: "Pricing decision",
      sourceKind: "paste",
      sourceId: "paste",
    });

    const response = await search({ query: "pricing", mode: "hybrid", limit: 5 });
    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits[0]?.title).toBe("Pricing decision");
  });

  it("is idempotent for unchanged content and re-indexes when the text changes", () => {
    const first = ingestText({
      text: "Nội dung ban đầu của tài liệu.",
      sourceKind: "paste",
      sourceId: "paste",
      externalId: "doc-1",
    });
    const again = ingestText({
      text: "Nội dung ban đầu của tài liệu.",
      sourceKind: "paste",
      sourceId: "paste",
      externalId: "doc-1",
    });
    expect(first.status).toBe("created");
    expect(again.status).toBe("skipped");
    expect(again.documentId).toBe(first.documentId);

    const chunksBefore = countChunks();
    const updated = ingestText({
      text: "Nội dung đã sửa: bổ sung thêm phần kết luận.",
      sourceKind: "paste",
      sourceId: "paste",
      externalId: "doc-1",
    });
    expect(updated.status).toBe("updated");
    expect(updated.documentId).toBe(first.documentId);
    // Old chunks are deleted before the new ones are written.
    expect(countChunks()).toBe(updated.chunks);
    expect(countChunks()).toBeLessThanOrEqual(chunksBefore + updated.chunks);
  });

  it("records activity events for new documents", () => {
    ingestText({ text: "Ghi chú nhỏ", sourceKind: "paste", sourceId: "paste" });
    const events = listEvents({ limit: 10 });
    expect(events.some((event) => event.kind === "document.ingested")).toBe(true);
  });

  it("builds tags and entities without any model call", () => {
    ingestText({
      text: "Trao đổi với an.nguyen@example.com về #du-an/alpha và [[Kế hoạch Q3]].\nNhắc lại: [[Kế hoạch Q3]] cần chốt trước thứ Sáu.",
      sourceKind: "paste",
      sourceId: "paste",
    });
    const tags = listTags();
    expect(tags.map((tag) => tag.slug)).toContain("du-an-alpha");
    const graph = graphSnapshot(30);
    expect(graph.nodes.some((node) => node.type === "email")).toBe(true);
    expect(graph.nodes.some((node) => node.label.toLowerCase().includes("kế hoạch q3"))).toBe(true);
  });
});

describe("file ingest", () => {
  it("extracts a markdown file and keeps a copy of the original", async () => {
    const file = writeFixture(dir, "notes/ke-hoach.md", "# Kế hoạch\n\n- Mục tiêu: ra mắt bản beta\n- Hạn: 30/11");
    const { readFileSync } = await import("node:fs");
    const result = await ingestFile({
      bytes: new Uint8Array(readFileSync(file)),
      filename: "ke-hoach.md",
      sourceId: "test-upload",
      sourceKind: "upload",
    });
    expect(result.status).toBe("created");
    // Markdown is handled by the plain-text extractor, which keeps it lossless.
    expect(result.via).toBe("text");
    expect(result.storedPath).not.toBeNull();
    expect(result.chunks).toBeGreaterThan(0);

    const document = getDocument(result.documentId);
    expect(document?.title).toContain("Kế hoạch");
    expect(document?.meta.via).toBe("text");
  });
});

describe("folder sync (Obsidian-style vault)", () => {
  it("syncs, skips unchanged files, updates edits and reconciles deletions", async () => {
    const root = path.join(dir, "vault");
    writeFixture(root, "alpha.md", "# Alpha\n\nGhi chú alpha về dự án.");
    writeFixture(root, "sub/beta.md", "# Beta\n\nGhi chú beta về khách hàng.");
    writeFixture(root, "skip.bin", "binary-ish content");

    const first = await syncFolder({ root });
    expect(first.ingested).toBe(2);
    expect(first.scanned).toBe(2);
    expect(first.failed).toBe(0);

    const second = await syncFolder({ root });
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(2);

    writeFixture(root, "alpha.md", "# Alpha\n\nNội dung alpha đã được sửa và mở rộng.");
    const third = await syncFolder({ root });
    expect(third.updated).toBe(1);
    expect(third.removed).toBe(0);

    const { rmSync } = await import("node:fs");
    rmSync(path.join(root, "sub", "beta.md"));
    const fourth = await syncFolder({ root });
    expect(fourth.removed).toBe(1);

    expect(listDocuments({ limit: 100 }).total).toBe(1);
  });

  it("rejects a folder that does not exist", async () => {
    await expect(syncFolder({ root: path.join(dir, "does-not-exist") })).rejects.toThrow(/does not exist/i);
  });
});

describe("notes", () => {
  it("creates, updates, tags and links notes", () => {
    const target = createNote({ markdown: "# Kế hoạch Q3\n\nNội dung kế hoạch.", tags: ["ke-hoach"] });
    expect(target.document.title).toBe("Kế hoạch Q3");

    const source = createNote({ markdown: "# Ghi chú họp\n\nXem [[Kế hoạch Q3]] trước khi họp." });
    expect(source.links.length).toBe(1);

    const refreshed = getNote(target.document.id);
    expect(refreshed?.backlinks.some((link) => link.documentId === source.document.id)).toBe(true);

    const updated = updateNote(source.document.id, { markdown: "# Ghi chú họp\n\nĐã chốt: không cần [[Kế hoạch Q3]] nữa." });
    expect(updated?.document.title).toBe("Ghi chú họp");

    const list = listNotes({ limit: 10 });
    expect(list.total).toBe(2);
    expect(list.items.every((item) => item.document.sourceKind === "note")).toBe(true);
  });

  it("re-chunks the note body after an edit", () => {
    const note = createNote({ markdown: "# A\n\nngắn" });
    const before = documentChunks(note.document.id).map((chunk) => chunk.text).join("\n");
    updateNote(note.document.id, { markdown: `${"# A\n\n"}${"nội dung dài hơn ".repeat(400)}` });
    const chunks = documentChunks(note.document.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("\n")).not.toBe(before);
    expect(getDocument(note.document.id)?.chunkCount).toBe(chunks.length);
  });
});

describe("entity identity", () => {
  it("merges two spellings that fold to the same name instead of failing the ingest", () => {
    // Identity is (type, folded name); the id is built from the original
    // spelling, so before the fix the second insert tripped the unique index.
    const first = ingestText({
      text: "Assembly notes for the RSX build.",
      title: "RSX notes",
      sourceKind: "upload",
      sourceId: "tests",
      tags: ["RSX"],
    });
    const second = ingestText({
      text: "Assembly notes for the RSX build, second revision.",
      title: "RSX notes v2",
      sourceKind: "upload",
      sourceId: "tests",
      tags: ["rsx"],
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(listDocuments().total).toBe(2);
  });
});
