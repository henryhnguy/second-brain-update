import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { foldForIndex } from "@/lib/core/text";
import { resetKeyCache } from "@/lib/crypto/secretbox";
import { resetDb } from "@/lib/db/connection";
import { applyMigrations } from "@/lib/db/migrate";
import { MIGRATIONS } from "@/lib/db/migrations";
import { run } from "@/lib/db/sql";
import { search } from "@/lib/retrieval/hybrid";
import { removeTempDataDir } from "./helpers/env";

const LEGACY_DIRS: string[] = [];

/**
 * Builds a database exactly as an installation written before the title index
 * held it: migrations 1–2, one document, one chunk, and the old two-column
 * index rows. Titles were not indexed at all back then.
 */
function legacyDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-legacy-"));
  LEGACY_DIRS.push(dir);
  const file = path.join(dir, "brain.db");
  const raw = new DatabaseSync(file);

  applyMigrations(raw, MIGRATIONS.slice(0, 2), { trigram: true });

  const text = "Keep the enterprise tier at 40 USD per seat.";
  const folded = foldForIndex(text);

  run(
    raw,
    `INSERT INTO documents (id, source_kind, source_id, title, ingested_at, content_hash, chunk_count)
     VALUES ('doc_legacy', 'paste', 'paste', 'Pricing decision', ?, 'hash-legacy', 1)`,
    [new Date().toISOString()],
  );
  const inserted = run(
    raw,
    `INSERT INTO chunks (id, document_id, ord, text, text_fold, heading_path, heading_fold, char_start, char_end, token_estimate)
     VALUES ('chk_legacy', 'doc_legacy', 0, ?, ?, NULL, NULL, 0, ?, 9)`,
    [text, folded, text.length],
  );
  run(raw, "INSERT INTO chunks_fts (rowid, text_fold, heading_fold) VALUES (?, ?, '')", [
    inserted.lastInsertRowid,
    folded,
  ]);
  run(raw, "INSERT INTO chunks_trigram (rowid, text_fold) VALUES (?, ?)", [inserted.lastInsertRowid, folded]);

  raw.close();
  return dir;
}

function pointAt(dir: string): void {
  process.env.SB_DATA_DIR = dir;
  process.env.SB_DB_FILE = path.join(dir, "brain.db");
  process.env.SB_SECRET_FILE = path.join(dir, ".secret");
  process.env.SB_AI_MODE = "off";
  resetKeyCache();
  resetDb();
}

afterAll(() => {
  for (const dir of LEGACY_DIRS) removeTempDataDir(dir);
});

describe("title index migration", () => {
  it("makes an existing document findable by a word that only appears in its title", async () => {
    const dir = legacyDatabase();
    pointAt(dir);

    // Reopening runs migrations 3 and 4, which rebuild both indexes and fold
    // every stored title with the writer's own normalisation.
    const response = await search({ query: "pricing", mode: "hybrid", limit: 5 });

    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits[0]?.title).toBe("Pricing decision");
  });

  it("keeps body search working after the rebuild", async () => {
    const dir = legacyDatabase();
    pointAt(dir);

    const response = await search({ query: "enterprise tier", mode: "hybrid", limit: 5 });

    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits[0]?.snippet.toLowerCase()).toContain("enterprise");
  });
});
