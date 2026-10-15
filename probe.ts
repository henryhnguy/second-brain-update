// scratch probe (deleted right after use)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-probe-"));
  process.env.SB_DATA_DIR = dir;
  process.env.SB_DB_FILE = path.join(dir, "brain.db");
  process.env.SB_SECRET_FILE = path.join(dir, ".secret");
  process.env.SB_AI_MODE = "off";

  const { ingestText } = await import("./src/lib/ingest/pipeline");
  const { graphSnapshot, topEntities } = await import("./src/lib/ingest/enrich");
  const { listTags } = await import("./src/lib/db/repo/notes");
  const { listExtractors } = await import("./src/lib/extract");
  const { listImporters } = await import("./src/lib/import");

  ingestText({
    text: "Trao đổi với an.nguyen@example.com về #du-an/alpha và [[Kế hoạch Q3]].\nNhắc lại: [[Kế hoạch Q3]] cần chốt trước thứ Sáu.",
    sourceKind: "paste",
    sourceId: "paste",
  });

  console.log("tags:", listTags().map((tag) => tag.slug));
  console.log("entities:", topEntities(30).map((entity) => `${entity.type}:${entity.name}(${entity.mentions})`));
  console.log("graph:", graphSnapshot(30).nodes.map((node) => `${node.type}:${node.label}@${node.weight}`));
  console.log("extractors:", listExtractors().map((extractor) => `${extractor.id}[${extractor.extensions.join(" ")}]`));
  console.log("importers:", listImporters().map((importer) => importer.id));
}

void main();
