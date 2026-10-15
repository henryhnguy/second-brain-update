# Architecture

Second Brain is a single Next.js application backed by one SQLite file. There is no separate
server, queue or vector database to run: the UI, the REST API and the CLI are three front doors
onto the same library code.

```
                    ┌──────────── UI (React) ───────────┐
                    │  /api/v1/**  →  lib/api/router.ts  │
   CLI (tsx) ──────▶│                                    │
                    └───────────────┬────────────────────┘
                                    │
   capture ── extract ── chunk ── upsert ── enrich ── (embed) ── retrieve ── answer / play
                                    │
                       SQLite: documents · chunks · chunks_fts · chunks_trigram
                               embeddings · notes · tags · entities
                               conversations · messages · connectors · jobs · events
```

## Layers

| Layer | Responsibility |
| --- | --- |
| `lib/api` | Route table, auth, request parsing. `src/app/api/v1/[...path]/route.ts` is a thin adapter. |
| `lib/ingest` | The single write path: `ingestText` chunks, upserts, enriches and records an event. |
| `lib/extract` | One extractor per format (text, html, pdf, docx, eml), registered in a registry. |
| `lib/import` | Bulk importers (mbox, ICS, RFC822, Notion zip, Slack zip) that stream items into `ingestText`. |
| `lib/connectors` | Provider framework: OAuth plumbing, sealed credential storage, cursor-based sync. |
| `lib/retrieval` | Lexical (FTS5 BM25), trigram substring scan, semantic (cosine), and the fusion layer. |
| `lib/ai` | One OpenAI-compatible client, config resolution, prompts. |
| `lib/plays` | Deterministic digests plus optional model synthesis. |
| `lib/jobs` | Background worker for ingest, embedding backfill and scheduled syncs. |
| `lib/db` | Connection, migrations, repositories. The only layer that writes SQL. |

## Capture → index

1. **Extract.** Text arrives from a paste, a file, a URL fetch, an importer or a connector.
   Binary formats go through the matching extractor; `pdfjs-dist`, `mammoth` and `adm-zip` are
   externalised from the server bundle and loaded on demand.
2. **Chunk.** `lib/ingest/chunker.ts` is structure-aware:
   - Markdown headings become each chunk's `headingPath` (`Setup › Install`), and a heading is
     never flushed on its own — it stays glued to the first block of its body.
   - Code fences and tables stay atomic and are never split mid-block.
   - Oversized blocks are split further at paragraph or sentence boundaries with overlap.
   - A trailing scrap is merged backwards only within the same heading path, so a tail never
     gets relabelled with another section's heading.
   - Every chunk records `charStart`/`charEnd` so the UI can point at the exact source span.
   - Conversation-shaped sources use `chunkMessages`, which keeps whole messages together.
3. **Upsert.** `upsertDocument` de-duplicates by `(sourceKind, sourceId, externalId)` and by
   content hash, so re-syncing a connector updates instead of duplicating. Changed documents
   delete their old chunks and FTS rows and insert new ones.
4. **Enrich.** `applyEnrichment` extracts `#tags`, `[[wiki links]]`, people, topics and URLs, and
   updates the entity graph and backlinks used by the **Knowledge graph** page.
5. **Embed (optional).** Missing embeddings are backfilled by the worker or by
   `npm run cli -- index`. Without a configured embedding model, search still works.

## Retrieval

`lib/retrieval/hybrid.ts` fuses three sources into one ranked list:

- **Lexical** — FTS5 `bm25()` over the diacritic-folded chunk text. Queries are folded too, so
  `bao cao` matches `Báo cáo`. Prefix matching is applied to the last token.
- **Trigram** — a substring scan catches plurals, compounds and typos the tokeniser misses.
- **Semantic** — cosine similarity over stored embeddings, enabled only when embeddings exist.

Each candidate keeps its individual signals (`bm25`, `cosine`, `trigram`, `recency`, `pin`,
`sourceWeight`) so a result list can explain itself. Filters cover source, tag, connector, date
range and explicit document ids, and the response carries facets for the matched set.

## Answering

`lib/ai/chat.ts` streams a RAG turn: retrieve passages → build a numbered context → ask the model
→ emit citations `[1]`, `[2]`. Two properties matter:

- **Grounded by construction.** The system prompt forbids using anything outside the supplied
  sources and requires a citation on every claim; the model is told to answer in the language the
  user wrote in.
- **Useful without a model.** When no model is configured, or a model call fails, the app returns
  an extractive answer built from the best passages with the same citations. Nothing silently
  pretends a model answered.

## Plays

`lib/plays/engine.ts` gathers a window of memory, builds a deterministic Markdown digest
(grouped by topic, source and entity), and — only if a model is configured and the play opts in —
asks the model to synthesise it. Model failure falls back to the deterministic digest rather than
failing the run.

## Storage

One SQLite file via the built-in `node:sqlite` module (Node 24+), so there is no native build
step. `chunks_fts` is an FTS5 table mirroring `chunks` by rowid; `chunks_trigram` backs substring
search. Connector credentials are sealed with a key stored in `data/.secret`; the database only
ever holds ciphertext, and the API never returns the plaintext.

## Known limitations

- **Document titles are not in the full-text index.** `chunks_fts` indexes chunk text and heading
  paths, so a word that appears only in a document's title is not found by search. The fix is to
  fold the title into the indexed row (a `title_fold` column written at chunk-insert time) and
  re-index existing rows with `npm run cli -- index`.
- **One AI code path.** The model layer is OpenAI-compatible only; there is no dedicated Anthropic
  adapter yet.
- **Single-writer SQLite.** The app is built for one person on one machine. Running several
  instances against the same file is not supported.
