import { describe, expect, it } from "vitest";

import { chunkText, chunkMessages } from "@/lib/ingest/chunker";
import {
  buildFtsQuery,
  buildFtsQueryOr,
  estimateTokens,
  extractInlineTags,
  extractWikiLinks,
  foldDiacritics,
  foldForIndex,
  highlightSegments,
  snippetAround,
  slugify,
  tokenize,
} from "@/lib/core/text";
import { openSealed, seal } from "@/lib/crypto/secretbox";
import type { LexicalCandidate } from "@/lib/retrieval/lexical";
import type { SemanticCandidate } from "@/lib/retrieval/semantic";
import { recencyBonus, rrfFuse } from "./helpers/ranking";

function candidate(chunkId: string, score = 1): LexicalCandidate {
  return {
    chunkId,
    documentId: `doc_${chunkId}`,
    title: `title ${chunkId}`,
    sourceKind: "paste",
    sourceId: "paste",
    url: null,
    path: null,
    author: null,
    createdAt: null,
    updatedAt: null,
    ingestedAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
    text: `nội dung ${chunkId}`,
    headingPath: null,
    score,
  };
}

function semantic(chunkId: string, cosine = 2): SemanticCandidate {
  return { ...candidate(chunkId), cosine };
}

describe("Vietnamese-aware text folding", () => {
  it("folds diacritics so search works without accents", () => {
    expect(foldDiacritics("Báo cáo quý III đã xong")).toBe("Bao cao quy III da xong");
    expect(foldForIndex("ĐỔI MỚI")).toBe("doi moi");
    expect(foldDiacritics("đường Đà Nẵng")).toBe("duong Da Nang");
  });

  it("tokenises Vietnamese text and drops punctuation", () => {
    expect(tokenize("Họp với khách hàng A, ngày 12/03!")).toEqual([
      "hop",
      "voi",
      "khach",
      "hang",
      "a",
      "ngay",
      "12",
      "03",
    ]);
  });

  it("builds a safe FTS5 MATCH expression", () => {
    expect(buildFtsQuery("báo cáo", { prefixLast: false })).toBe('"bao" AND "cao"');
    expect(buildFtsQuery("báo", { prefixLast: true })).toBe('"bao"*');
    expect(buildFtsQueryOr("báo cáo")).toBe('"bao" OR "cao"');
    expect(buildFtsQuery("   ")).toBe("");
    // quotes must never escape the FTS string literal
    expect(buildFtsQuery('he said "hi"', { prefixLast: false })).toBe('"he" AND "said" AND "hi"');
  });
});

describe("snippets and highlights", () => {
  it("marks term hits accent-insensitively", () => {
    const segments = highlightSegments("Báo cáo quý 3 và bao cao khác", ["bao"]);
    const hits = segments.filter((segment) => segment.hit).map((segment) => foldForIndex(segment.text));
    expect(hits).toEqual(["bao", "bao"]);
  });

  it("returns a window around the first hit", () => {
    const text = `${"x".repeat(300)} bao cao ${"y".repeat(300)}`;
    const snippet = snippetAround(text, ["bao"], 80);
    expect(snippet).toContain("bao cao");
    expect(snippet.length).toBeLessThan(text.length);
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("extracts wiki links and inline tags", () => {
    expect(extractWikiLinks("Xem [[Dự án Alpha|ghi chú]] và [[Beta#phần 2]]")).toEqual(["Dự án Alpha", "Beta"]);
    expect(extractInlineTags("việc này #quan-trong và #du_an/alpha nhé")).toEqual(["quan-trong", "du_an/alpha"]);
  });

  it("slugifies Vietnamese titles", () => {
    expect(slugify("Báo cáo Q3 — Đổi mới")).toBe("bao-cao-q3-doi-moi");
    expect(estimateTokens("một hai ba bốn")).toBeGreaterThan(0);
  });
});

describe("chunker", () => {
  it("keeps markdown headings as heading paths", () => {
    const bodyA = "noi dung A ".repeat(12);
    const bodyB = "noi dung B ".repeat(12);
    const chunks = chunkText(`# A\n\n${bodyA}\n\n## B\n\n${bodyB}`, { targetChars: 40, maxChars: 400 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.headingPath).toBe("A");
    expect(chunks[1]?.headingPath).toBe("A › B");
  });

  it("never splits a code fence mid-block and records offsets", () => {
    const code = "```ts\nconst a = 1;\nconst b = 2;\n```";
    const chunks = chunkText(`Lời dẫn\n\n${code}\n\nSau đó`, { targetChars: 20, maxChars: 500 });
    const withCode = chunks.find((chunk) => chunk.text.includes("const b = 2;"));
    expect(withCode?.text).toContain("```ts");
    expect(withCode?.text).toContain("const a = 1;\nconst b = 2;");
    for (const chunk of chunks) {
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
    }
  });

  it("splits an oversized block into overlapping pieces", () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `Đoạn số ${index} với nội dung đủ dài để tách.`).join("\n\n");
    const chunks = chunkText(paragraphs, { targetChars: 200, maxChars: 260, overlapChars: 40 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.text.length <= 320)).toBe(true);
  });

  it("groups conversation messages without cutting a message", () => {
    const chunks = chunkMessages(
      Array.from({ length: 10 }, (_, index) => ({ author: `user${index}`, at: `2026-03-0${(index % 9) + 1}T10:00:00Z`, text: `tin nhắn ${index}` })),
      { targetChars: 80 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.split("\n").every((line) => line.includes("tin nhắn")))).toBe(true);
  });
});

describe("secret box", () => {
  it("round-trips JSON payloads and rejects tampered text", () => {
    const sealed = seal("super-secret-value");
    expect(sealed).not.toContain("super-secret-value");
    expect(openSealed(sealed)).toBe("super-secret-value");

    const tampered = `${sealed.slice(0, -3)}aaa`;
    expect(() => openSealed(tampered)).toThrow();
  });
});

describe("reciprocal rank fusion", () => {
  it("ranks chunks that appear in several retrievers first", () => {
    const fused = rrfFuse([
      { name: "keyword", items: [candidate("a"), candidate("b"), candidate("c")] },
      { name: "semantic", items: [semantic("c"), semantic("a"), semantic("d")] },
      { name: "trigram", items: [candidate("b"), candidate("d")] },
    ]);
    expect(fused[0]?.chunkId).toBe("a");
    expect(fused.map((entry) => entry.chunkId).sort()).toEqual(["a", "b", "c", "d"]);
    expect(fused[0]?.signals.bm25).toBe(1);
    expect(fused[0]?.signals.cosine).toBe(2);
    expect(fused[0]?.score).toBeGreaterThan(fused[3]?.score ?? 1);
  });

  it("rewards fresh content and treats old content as neutral", () => {
    expect(recencyBonus(new Date().toISOString())).toBeGreaterThan(0);
    expect(recencyBonus("2019-01-01T00:00:00.000Z")).toBe(0);
    expect(recencyBonus(null)).toBe(0);
  });
});
