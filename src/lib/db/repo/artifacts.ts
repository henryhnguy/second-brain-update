import { newId } from "../../core/ids";
import { nowIso } from "../../core/time";
import type { Artifact, ArtifactKind, ArtifactSlide, Citation } from "../../types/domain";
import { getDb } from "../connection";
import { all, get, jsonParse, num, run, str } from "../sql";

function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: str(row.id),
    kind: str(row.kind, "lesson") as ArtifactKind,
    title: str(row.title),
    documentIds: jsonParse<string[]>(row.document_ids, []),
    params: jsonParse<Record<string, unknown>>(row.params, {}),
    markdown: str(row.markdown),
    slides: jsonParse<ArtifactSlide[]>(row.slides, []),
    citations: jsonParse<Citation[]>(row.citations, []),
    usedLlm: num(row.used_llm) === 1,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function createArtifact(input: {
  kind: ArtifactKind;
  title: string;
  documentIds: string[];
  params: Record<string, unknown>;
  markdown: string;
  slides: ArtifactSlide[];
  citations: Citation[];
  usedLlm: boolean;
}): Artifact {
  const id = newId("art");
  const at = nowIso();
  run(
    getDb(),
    `INSERT INTO artifacts (id, kind, title, document_ids, params, markdown, slides, citations, used_llm, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.title,
      JSON.stringify(input.documentIds),
      JSON.stringify(input.params),
      input.markdown,
      JSON.stringify(input.slides),
      JSON.stringify(input.citations),
      input.usedLlm ? 1 : 0,
      at,
      at,
    ],
  );
  const artifact = getArtifact(id);
  if (!artifact) throw new Error("artifact creation failed");
  return artifact;
}

export function getArtifact(id: string): Artifact | null {
  const row = get<Record<string, unknown>>(getDb(), "SELECT * FROM artifacts WHERE id = ?", [id]);
  return row ? mapArtifact(row) : null;
}

export function listArtifacts(options: { kind?: ArtifactKind | null; limit?: number } = {}): Artifact[] {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  if (options.kind) {
    return all<Record<string, unknown>>(
      getDb(),
      "SELECT * FROM artifacts WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
      [options.kind, limit],
    ).map(mapArtifact);
  }
  return all<Record<string, unknown>>(
    getDb(),
    "SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?",
    [limit],
  ).map(mapArtifact);
}

export function deleteArtifact(id: string): boolean {
  return run(getDb(), "DELETE FROM artifacts WHERE id = ?", [id]).changes > 0;
}
