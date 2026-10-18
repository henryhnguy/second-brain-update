import { beforeEach, describe, expect, it } from "vitest";

import {
  buildHealthReport,
  buildMasterIndex,
  distillDocument,
  DISTILL_TEMPLATES,
  renderIndexMarkdown,
  renderReviewMarkdown,
} from "@/lib/curator";
import { backlinksFor, createNote, getNote } from "@/lib/db/repo/notes";
import { ingestText } from "@/lib/ingest/pipeline";
import { useTempDataDir } from "./helpers/env";

/**
 * The curator is what turns the store into a second brain, so these tests focus
 * on the three promises: a truthful index, a useful one-pager and a review that
 * names the next action.
 */

beforeEach(() => {
  useTempDataDir();
});

function seedGuideline() {
  return ingestText({
    text: [
      "# Backpart Molding Best Practices",
      "",
      "Backpart molding keeps the heel counter and the toe box in shape before assembly.",
      "Always preheat the mold to the temperature in the specification before loading the upper.",
      "Do not overheat the counter: it becomes brittle and the bond fails in wear testing.",
      "When the upper uses hot melt, check the toe box after two minutes and adjust the press.",
      "Owners review this guideline every season and record the result in the quality log.",
    ].join("\n"),
    title: "MO - FTW.02 Backpart Molding",
    sourceKind: "upload",
    sourceId: "mo-ftw",
    tags: ["guideline"],
  });
}

describe("master index", () => {
  it("groups documents into shelves and reports coverage", () => {
    seedGuideline();
    ingestText({
      text: "Weekly engineering report for the assembly line, covering output and defects.",
      title: "Weekly report 12",
      sourceKind: "paste",
      sourceId: "reports",
    });

    const index = buildMasterIndex();
    expect(index.totals.documents).toBe(2);
    expect(index.totals.shelves).toBe(2);

    const guidelineShelf = index.shelves.find((shelf) => shelf.id === "mo-ftw");
    expect(guidelineShelf?.count).toBe(1);
    expect(guidelineShelf?.tagged).toBe(1);
    expect(guidelineShelf?.documents[0]?.title).toContain("Backpart");

    expect(index.coverage.tagged).toBeCloseTo(0.5, 5);
    expect(index.coverage.summarized).toBe(0);

    const markdown = renderIndexMarkdown(index);
    expect(markdown).toContain("## Shelves");
    expect(markdown).toContain("Mo Ftw");
  });
});

describe("health report", () => {
  it("finds duplicates, untagged documents and missing one-pagers", () => {
    seedGuideline();
    ingestText({
      text: "Duplicate body that was captured from two different places at once.",
      title: "Copy A",
      sourceKind: "paste",
      sourceId: "inbox",
    });
    ingestText({
      text: "Duplicate body that was captured from two different places at once.",
      title: "Copy B",
      sourceKind: "paste",
      sourceId: "archive",
    });

    const report = buildHealthReport();
    expect(report.counts.duplicate).toBe(1);
    expect(report.counts.untagged).toBeGreaterThanOrEqual(2);
    expect(report.counts.unsummarized).toBeGreaterThanOrEqual(3);
    expect(report.findings.some((finding) => finding.kind === "duplicate" && finding.severity === "high")).toBe(
      true,
    );

    const markdown = renderReviewMarkdown(report);
    expect(markdown).toContain("Brain review");
    expect(markdown).toContain("Coverage");
    expect(markdown).toContain("Duplicate content");
  });

  it("flags orphan notes and unresolved wiki links", () => {
    createNote({ markdown: "A loose thought with no tags and nothing pointing at it." });
    createNote({ markdown: "See [[A document that never existed]] for the old decision." });

    const report = buildHealthReport();
    expect(report.counts.orphan_note).toBeGreaterThanOrEqual(1);
    expect(report.counts.broken_link).toBeGreaterThanOrEqual(1);
    expect(report.findings.some((finding) => finding.kind === "broken_link")).toBe(true);
  });
});

describe("distill", () => {
  it("writes a one-pager, saves it as a linked note and updates it on a second run", async () => {
    const seeded = seedGuideline();
    const first = await distillDocument({
      documentId: seeded.documentId,
      template: "guideline",
      lang: "en",
    });

    expect(first.noteId).toBeTruthy();
    expect(first.markdown).toContain("## Purpose");
    expect(first.markdown).toContain("## Key rules");
    expect(first.markdown).toContain("## Source");
    expect(first.markdown).toContain("[[MO - FTW.02 Backpart Molding]]");

    const note = getNote(first.noteId as string);
    expect(note?.document.meta.kind).toBe("summary");
    expect(note?.document.meta.sourceDocumentId).toBe(seeded.documentId);

    const backlinks = backlinksFor(seeded.documentId);
    expect(backlinks.some((link) => link.documentId === first.noteId)).toBe(true);

    const second = await distillDocument({
      documentId: seeded.documentId,
      template: "guideline",
      lang: "en",
    });
    expect(second.noteId).toBe(first.noteId);
    expect(second.updated).toBe(true);

    const index = buildMasterIndex();
    expect(index.totals.summaries).toBe(1);
    expect(index.coverage.summarized).toBeCloseTo(1, 5);
  });

  it("switches section labels to Vietnamese", async () => {
    const seeded = seedGuideline();
    const result = await distillDocument({
      documentId: seeded.documentId,
      template: "guideline",
      lang: "vi",
      save: false,
    });
    expect(result.markdown).toContain("## Mục đích");
    expect(result.markdown).toContain("## Quy tắc chính");
    expect(result.noteId).toBeNull();
  });

  it("exposes the template catalogue", () => {
    expect(DISTILL_TEMPLATES.map((template) => template.id)).toEqual([
      "generic",
      "guideline",
      "project",
      "meeting",
      "decision",
    ]);
  });
});
