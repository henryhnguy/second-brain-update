import { beforeEach, describe, expect, it } from "vitest";

import { getArtifact, listArtifacts } from "@/lib/db/repo/artifacts";
import { ingestText } from "@/lib/ingest/pipeline";
import { generateArtifact } from "@/lib/studio";
import { slidesToMarp, slidesToStandaloneHtml } from "@/lib/studio/format";
import { useTempDataDir } from "./helpers/env";

beforeEach(() => {
  useTempDataDir();
});

function seedSources() {
  const molding = ingestText({
    text: [
      "# Backpart molding",
      "",
      "Backpart molding keeps the heel counter and the toe box in shape before assembly.",
      "Always preheat the mold to the temperature written in the specification before loading the upper.",
      "Do not overheat the counter, because it becomes brittle and the bond fails in wear testing.",
      "For example, a 10-second difference between air vents is enough to twist the heel.",
    ].join("\n"),
    title: "MO - FTW.02 Backpart Molding",
    sourceKind: "upload",
    sourceId: "01_Guidelines",
    tags: ["guideline"],
  });
  const stitching = ingestText({
    text: [
      "# Formstrip stitching",
      "",
      "The formstrip is stitched with a computer-controlled machine to keep the stitch length constant.",
      "Check the needle and the thread tension at the start of every shift and record the result.",
      "Never run the machine without the guard, and stop immediately if the stitch skips.",
    ].join("\n"),
    title: "MO - FTW.04 Formstrip Stitching",
    sourceKind: "upload",
    sourceId: "01_Guidelines",
  });
  return { molding, stitching };
}

describe("studio lessons", () => {
  it("builds a grounded lesson and stores it", async () => {
    const { molding, stitching } = seedSources();
    const artifact = await generateArtifact({
      kind: "lesson",
      documentIds: [molding.documentId, stitching.documentId],
      useLlm: false,
    });

    expect(artifact.kind).toBe("lesson");
    expect(artifact.documentIds).toHaveLength(2);
    expect(artifact.citations).toHaveLength(2);
    expect(artifact.markdown).toContain("## Learning objectives");
    expect(artifact.markdown).toContain("## Core concepts");
    expect(artifact.markdown).toContain("## Check your understanding");
    expect(artifact.markdown).toContain("## Flashcards");
    expect(artifact.markdown).toContain("[1]");
    expect(artifact.usedLlm).toBe(false);

    const stored = getArtifact(artifact.id);
    expect(stored?.markdown).toBe(artifact.markdown);
    expect(listArtifacts({ kind: "lesson" })).toHaveLength(1);
  });

  it("rejects an empty selection", async () => {
    await expect(generateArtifact({ kind: "lesson", documentIds: ["doc_missing"] })).rejects.toThrow(
      /No sources matched/i,
    );
  });
});

describe("studio slides", () => {
  it("builds a deck with a title slide, content slides and sources", async () => {
    const { molding, stitching } = seedSources();
    const artifact = await generateArtifact({
      kind: "slides",
      documentIds: [molding.documentId, stitching.documentId],
      maxSlides: 8,
      useLlm: false,
    });

    expect(artifact.kind).toBe("slides");
    expect(artifact.slides.length).toBeGreaterThanOrEqual(4);
    expect(artifact.slides.length).toBeLessThanOrEqual(8);
    expect(artifact.slides[0]?.title).toContain("Deck");
    expect(artifact.slides[1]?.title).toBe("Agenda");
    expect(artifact.slides.some((slide) => slide.title === "Sources")).toBe(true);
    expect(artifact.slides.some((slide) => (slide.notes ?? "").includes("[1]"))).toBe(true);
    expect(artifact.markdown).toContain("## Agenda");
  });

  it("formats a deck as Marp Markdown and a standalone HTML page", async () => {
    const { molding } = seedSources();
    const artifact = await generateArtifact({ kind: "slides", documentIds: [molding.documentId], useLlm: false });

    const marp = slidesToMarp(artifact.slides, artifact.title);
    expect(marp.startsWith("---\nmarp: true")).toBe(true);
    expect(marp).toContain("# Agenda");

    const html = slidesToStandaloneHtml(artifact.slides, "Deck <test>");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Deck &lt;test&gt;");
    expect(html).toContain("<section>");
  });
});
