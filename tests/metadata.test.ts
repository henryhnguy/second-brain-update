import { beforeEach, describe, expect, it } from "vitest";

import { applyInferredMetadata, inferMetadata } from "@/lib/curator/metadata";
import { getDocument, setDocumentMeta } from "@/lib/db/repo/documents";
import { ingestText } from "@/lib/ingest/pipeline";
import { useTempDataDir } from "./helpers/env";

describe("metadata inference", () => {
  beforeEach(() => {
    useTempDataDir();
  });

  it("reads the code, version and effective date from a guideline title", () => {
    expect(inferMetadata("MO - FTW.06 Product Engineering Guidelines_V3_03.18.2026.pdf")).toEqual({
      code: "MO-FTW.06",
      version: "V03",
      effectiveDate: "2026-03-18",
    });
  });

  it("handles the three spellings of a QMS code", () => {
    expect(inferMetadata("QMS-FTW.13 Chemical Management Guideline V02_31.07.2024.pdf")).toMatchObject({
      code: "QMS-FTW.13",
      version: "V02",
      effectiveDate: "2024-07-31",
    });
    expect(inferMetadata("QMS-FTW-02 Footwear Inspection Defect Guidelines_31.08.2023_V03.pdf")).toMatchObject({
      code: "QMS-FTW.02",
      effectiveDate: "2023-08-31",
      version: "V03",
    });
    expect(inferMetadata("QMS-FTW.06 Puma BPG Part 5 Bonding Gap Repair_V01_02.04.2024.pdf").code).toBe(
      "QMS-FTW.06",
    );
  });

  it("returns nothing for a title without a code", () => {
    expect(inferMetadata("Weekly engineering report 12")).toEqual({});
  });

  it("merges inferred metadata without overwriting existing values", () => {
    const created = ingestText({
      text: "Stockfit soles roughing and degreasing.",
      title: "MO - FTW.10 Stockfit Soles Roughing and Degreasing Best Practices_V1_05.27.2025.pdf",
      sourceKind: "folder",
      sourceId: "folder:test",
    });
    setDocumentMeta(created.documentId, { code: "MANUAL.01" });

    const report = applyInferredMetadata();
    expect(report.scanned).toBe(1);
    expect(report.updated).toBe(1);

    const meta = getDocument(created.documentId)?.meta ?? {};
    expect(meta.code).toBe("MANUAL.01");
    expect(meta.version).toBe("V01");
    expect(meta.effectiveDate).toBe("2025-05-27");

    const second = applyInferredMetadata();
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("does not write in dry-run mode", () => {
    const created = ingestText({
      text: "Pre-buffing and buffing.",
      title: "MO - FTW.11 Pre-buffing and Buffing Best Practices_V1_05.26.2025.pdf",
      sourceKind: "folder",
      sourceId: "folder:test",
    });
    const report = applyInferredMetadata({ dryRun: true });
    expect(report.updated).toBe(1);
    expect(getDocument(created.documentId)?.meta.code).toBeUndefined();
  });
});
