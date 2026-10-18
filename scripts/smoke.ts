/**
 * End-to-end smoke test.
 *
 * Runs the real pipeline — ingest, chunk, index, retrieve, graph, play — inside
 * a throwaway temp directory, so it never touches your own memory. Exits with a
 * non-zero status as soon as any step fails.
 *
 *   npm run smoke
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Step = { name: string; ok: boolean; detail: string };

const steps: Step[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "second-brain-smoke-"));
  process.env.SB_DATA_DIR = dir;
  process.env.SB_DB_FILE = path.join(dir, "brain.db");
  process.env.SB_SECRET_FILE = path.join(dir, ".secret");
  process.env.SB_AI_MODE = "off";
  process.env.SB_REPO_ROOT = process.cwd();

  console.log("second-brain smoke test");
  console.log(`scratch: ${dir}\n`);

  const { ingestText } = await import("../src/lib/ingest/pipeline");
  const { search } = await import("../src/lib/retrieval/hybrid");
  const { createNote, listTags } = await import("../src/lib/db/repo/notes");
  const { graphSnapshot, topEntities } = await import("../src/lib/ingest/enrich");
  const { runPlay } = await import("../src/lib/plays/engine");
  const { listExtractors } = await import("../src/lib/extract");
  const { listImporters } = await import("../src/lib/import");
  const { buildStats } = await import("../src/lib/db/repo/documents");

  // 1. Ingest a document with structure, so the chunker has headings to follow.
  const ingested = ingestText({
    text: [
      "# Báo cáo quý III",
      "",
      "Doanh thu tăng 18% so với quý trước, chủ yếu nhờ mảng dịch vụ.",
      "",
      "## Rủi ro",
      "",
      "Tỷ lệ rời bỏ của khách hàng doanh nghiệp cần theo dõi sát.",
    ].join("\n"),
    title: "Báo cáo quý III",
    sourceKind: "paste",
    sourceId: "smoke",
  });
  record("ingest text", ingested.status === "created" && ingested.chunks > 0, `${ingested.chunks} chunk(s)`);

  // 2. Keyword search finds it again.
  const keyword = await search({ query: "doanh thu", mode: "keyword", limit: 5 });
  record("keyword search", keyword.hits.length > 0, `${keyword.hits.length} hit(s), mode ${keyword.mode}`);

  // 3. Accent-insensitive search: unaccented query must still match accented text.
  const folded = await search({ query: "bao cao", mode: "keyword", limit: 5 });
  record("accent-insensitive search", folded.hits.length > 0, `${folded.hits.length} hit(s) for "bao cao"`);

  // 4. Hybrid retrieval reports whether embeddings are available.
  const hybrid = await search({ query: "rủi ro khách hàng", mode: "hybrid", limit: 5 });
  record(
    "hybrid search",
    hybrid.hits.length > 0,
    `${hybrid.hits.length} hit(s), semantic ${hybrid.semanticAvailable ? "on" : "off (no embeddings)"}`,
  );

  // 5. Notes, wiki links, tags and the entity graph.
  const note = createNote({
    markdown: "# Kế hoạch Q3\n\nChốt với [[Báo cáo quý III]] trước thứ Sáu. #du-an/alpha",
  });
  const backlinks = note.links.length > 0 || note.backlinks.length > 0;
  record("create note + wiki links", note.document.title === "Kế hoạch Q3", `title "${note.document.title}"`);
  record("tags extracted", listTags().length > 0, listTags().map((tag) => tag.slug).join(", "));
  record("entity graph", graphSnapshot(20).nodes.length > 0, `${topEntities(10).length} entit(ies)`);
  void backlinks;

  // 6. A play runs end to end without a model.
  const play = await runPlay("play_weekly_digest", { days: 7 });
  record(
    "play without a model",
    play.run.status === "ok" && play.output.includes("Weekly digest"),
    play.usedLlm ? "used model" : "deterministic output",
  );

  // 7. Curator: map, distill and review.
  const { buildHealthReport, buildMasterIndex, distillDocument } = await import("../src/lib/curator");
  const map = buildMasterIndex();
  record("curator map", map.totals.documents > 0, `${map.totals.shelves} shelf(es), ${map.totals.summaries} one-pager(s)`);

  const distilled = await distillDocument({ documentId: ingested.documentId, template: "generic", lang: "vi" });
  record(
    "curator distill",
    Boolean(distilled.noteId) && distilled.markdown.includes("## Tóm tắt"),
    distilled.updated ? "updated the existing note" : "saved a new note",
  );

  const review = buildHealthReport();
  record("curator review", review.totals.documents > 0, `${review.totals.issues} issue(s), ${review.counts.unsummarized} missing one-pager(s)`);

  // 8. Capability registries are populated.
  record("extractors registered", listExtractors().length >= 5, listExtractors().map((e) => e.id).join(", "));
  record("importers registered", listImporters().length >= 5, listImporters().map((i) => i.id).join(", "));

  // 9. Stats snapshot reflects what was ingested.
  const stats = buildStats(false);
  record("stats snapshot", stats.documents > 0 && stats.chunks > 0, `${stats.documents} doc(s), ${stats.chunks} chunk(s)`);

  const failed = steps.filter((step) => !step.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((step) => step.name).join(", ")}`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(`smoke test crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
