# Second Brain

A local-first personal knowledge and memory system. Capture notes, files, web pages, mail and
chat from the apps you already use, then search across all of it, ask questions with citations,
and automate the recurring write-ups (weekly digest, meeting brief, open loops).

Everything runs on your machine. The database is a single SQLite file, the encryption key stays
on disk next to it, and no source code here talks to a service you did not configure.

```
npm install
npm run dev          # http://localhost:4173
```

---

## What it does

**Capture anything**
- Markdown notes with `[[wiki links]]`, `#tags`, backlinks and a knowledge graph
- File upload: `.pdf`, `.docx`, `.xlsx`, `.xlsm`, `.pptx`, `.md`, `.txt`, `.html`, `.eml`, `.csv`
- Paste raw text, or save a URL (page text is extracted server-side)
- Folder sync: point it at an Obsidian vault or a documents folder and re-sync on change
- Import exports: `mbox`, `ics`, Notion zip, Slack zip, `.eml`
- Connectors: Gmail, Google Calendar, Outlook / Microsoft 365, Slack, Notion

**Find things again**
- Hybrid retrieval: SQLite FTS5 BM25 + a trigram index for typos and substrings + optional
  embedding cosine similarity, fused into one ranked list
- Diacritic-insensitive matching, so `bao cao` finds `Báo cáo` as well
- Filters by source, tag, connector and date, with facets on the result set

**Curate the memory**
- A memory map that groups everything by source and reports coverage: tagged, distilled, linked
- One-pagers from five templates (guideline, project, meeting, decision, generic), in English or
  Vietnamese, saved as notes linked back to their source and refreshed in place instead of duplicated
- A hygiene review — duplicates, broken wiki links, empty, untagged, stale and orphan documents —
  available as an API, a CLI command and the monthly **Brain review** play
- All three in one page at `/curate`

**Teach from it**
- **Studio**: pick sources and generate a **lesson** (objectives, core concepts, key terms, worked
  example, quiz, flashcards) or a **slide deck** with speaker notes
- Present the deck in the app with arrow keys; export it as Marp Markdown or a standalone HTML file
- Grounded in your own documents with `[n]` citations; deterministic without a model, written by one
  when configured
- Reachable at `/studio` and from the CLI (`studio lesson|slides`)

**Ask your memory**
- RAG chat that answers only from retrieved passages and cites them as `[1]`, `[2]`
- Token-by-token streaming, conversations kept in SQLite
- Works with no model configured at all: it falls back to an extractive answer built from the
  best matching passages, so the app is useful on first run

**Automate the recurring work**
- Plays: weekly digest, daily brief, meeting brief, open loops, find a document, topic dossier
- Deterministic Markdown output when no model is configured, model synthesis when there is one
- Background job worker for ingest, embedding backfill and scheduled connector syncs

**Reach it however you like**
- Web UI (11 pages), a REST API under `/api/v1`, and a CLI

---

## Requirements

- **Node.js 24+** (Node 22.5+ works with `--experimental-sqlite`). This project uses the built-in
  `node:sqlite` module, so there is no native build step and no database server to run.
- No model is required to start. Add one when you want summarised answers.

## Quickstart

```bash
git clone <your-fork-url> second-brain
cd second-brain
npm install
cp .env.example .env      # optional; the defaults work
npm run dev               # http://localhost:4173
```

Open the dashboard, type something into **Quick capture**, and it is searchable immediately.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 4173 |
| `start.bat` | Windows: install on first run, start the server and open the browser |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite |
| `npm run smoke` | End-to-end smoke test in a throwaway temp directory |
| `npm run cli -- <command>` | CLI, e.g. `npm run cli -- search "quarterly report"` |
| `npm run cli -- map` | Shelf map and coverage ratios |
| `npm run cli -- distill <documentId>` | Write a one-pager and save it as a linked note |
| `npm run cli -- review` | Knowledge hygiene report (exit 1 when high issues exist) |
| `npm run cli -- meta infer` | Fill `code`, `version`, `effectiveDate` from document titles |
| `npm run cli -- ingest list manifest.json` | Import an explicit list of files (spreadsheet-driven onboarding) |
| `npm run cli -- studio lesson --filter 01_Guidelines` | Build a lesson from a set of sources |
| `npm run cli -- studio slides --docs id,id` | Build a slide deck from named documents |

---

## Configuration

Settings can be set in `.env` **or** in the UI under **Settings** (values stored there win, and
they are sealed with the local key). Copy `.env.example` to `.env` to start from a template.

### Model provider

The AI layer speaks the **OpenAI-compatible** wire format — one code path that covers OpenAI,
OpenRouter, Groq, DeepSeek, Azure-style gateways, LM Studio and Ollama:

```bash
SB_AI_BASE_URL=https://api.openai.com/v1   # or http://localhost:11434/v1 for Ollama
SB_AI_CHAT_MODEL=gpt-4o-mini
SB_AI_EMBED_MODEL=text-embedding-3-small
```

The key itself (`SB_AI_API_KEY`) can live in `.env` or be pasted in **Settings**, where it is
stored sealed and only ever shown masked.

**Running fully local:**

```bash
# Ollama
ollama pull llama3.1 && ollama pull nomic-embed-text
SB_AI_BASE_URL=http://localhost:11434/v1
SB_AI_CHAT_MODEL=llama3.1
SB_AI_EMBED_MODEL=nomic-embed-text
```

Set `SB_AI_MODE=off` to disable the model layer entirely — keyword and trigram search keep
working, and chat answers with citations pulled straight from your memory.

**Anthropic Claude:** there is no dedicated Anthropic adapter in this repository yet; the AI
layer is deliberately a single OpenAI-compatible path. Claude is reachable today through
OpenRouter (`SB_AI_BASE_URL=https://openrouter.ai/api/v1`) or any
Anthropic-compatible gateway, and a direct adapter is a self-contained addition if you want one.

### Connectors

OAuth connectors need your own app credentials, pasted in **Settings → Connectors** or supplied
through the environment. Per-provider client ids and secrets are read from
`SB_<PROVIDER>_CLIENT_ID` / `SB_<PROVIDER>_CLIENT_SECRET` (for example `SB_SLACK_CLIENT_ID`).
The public URL used to build the callback is `SB_PUBLIC_URL` (falls back to `SB_APP_URL`).
See [docs/connectors.md](docs/connectors.md) for how to register each app.

---

## Curating the memory

Capture fills the brain; the curator keeps it usable. Three deterministic jobs run on top of the
store, all reachable from `/curate`, the CLI and the API:

1. **Map** — documents grouped by source with coverage ratios (tagged, distilled, linked).
2. **Distil** — a one-page note per document, from five templates, linked back to its source and
   updated in place on a re-run.
3. **Review** — duplicates, broken wiki links, empty, untagged, stale and orphan documents, with
   suggested next actions. The monthly **Brain review** play renders the same report.

The full contract, including the template catalogue and metadata conventions, is in
[docs/curator.md](docs/curator.md). Everything works without a model; the deterministic output is
the fallback, not a placeholder.

---

## Teaching from memory

**Studio** (`/studio`) turns a chosen set of sources into something you can teach or present with:

- a **lesson** — learning objectives, core concepts per source, key terms, a worked example, a quiz
  and flashcards, every point carrying a `[n]` citation;
- a **slide deck** — title, agenda, one slide per source, takeaways and sources, with speaker notes —
  presentable in the app (arrow keys, `Esc`) and exportable as Marp Markdown or a single HTML file.

Sources can be named explicitly, resolved from a collection, or found with a search query. The
deterministic path selects, orders and labels real passages; a configured model rewrites the artifact
instead, and a failed model call falls back to the deterministic version. The full contract is in
[docs/studio.md](docs/studio.md).

---

## Your data stays yours

- Everything lives under `data/`: `brain.db`, uploaded `files/`, `backups/`, worker `state/`,
  and `.secret` — the key that seals stored credentials.
- `data/` is git-ignored. Never commit it: it holds your personal memory and its keys.
- The API is bound to loopback by default. If you expose it, set `SB_API_REQUIRE_TOKEN=1` and
  create an API token in **Settings**.
- Deleting `data/` is a full reset: the memory is the database.

---

## Project layout

```
src/
  app/                     Next.js App Router: pages + the /api/v1 catch-all route
  components/              UI shell, primitives, markdown renderer
  cli/                     CLI entry point
  lib/
    ai/                    provider client, config, prompts
    api/                   router, auth, request helpers
    connectors/            provider framework, OAuth plumbing, per-service providers
    crypto/                sealed storage for credentials
    curator/               memory map, one-pager distillation, hygiene review
    studio/                lesson and slide-deck generation, deck export formats
    db/                    connection, migrations, repositories
    extract/               PDF, DOCX, HTML, EML, text extractors
    import/                mbox, ICS, RFC822, Notion and Slack export importers
    ingest/                pipeline, structure-aware chunker, entity enrichment, folder scan
    jobs/                  background worker
    plays/                 play engine (weekly digest, meeting brief, …)
    retrieval/             lexical, trigram, semantic and hybrid fusion
    types/                 shared domain types
tests/                     Vitest suites (chunking, retrieval, extractors, API, importers)
docs/                      architecture, connector setup, API reference
scripts/                   smoke test
```

Deeper reading: [docs/architecture.md](docs/architecture.md) ·
[docs/api.md](docs/api.md) · [docs/connectors.md](docs/connectors.md) ·
[docs/curator.md](docs/curator.md) · [docs/studio.md](docs/studio.md) ·
[docs/deployment.md](docs/deployment.md)

---

## CLI

```bash
npm run cli -- help
npm run cli -- health                  # runtime + capability report
npm run cli -- doctor                  # diagnose configuration problems
npm run cli -- stats                   # what is in the memory
npm run cli -- search "quarterly report"
npm run cli -- ask "what did we decide about pricing?"
npm run cli -- add --title "Idea" --text "..."
npm run cli -- ingest ./docs           # file or folder
npm run cli -- sync                    # every connected source
npm run cli -- index                   # backfill missing embeddings
npm run cli -- play weekly_digest
npm run cli -- export --out backup.json
npm run cli -- jobs                    # background queue
```

## Testing

```bash
npm run typecheck
npm test
npm run smoke
```

The suite covers the chunker's structure handling, hybrid ranking, every extractor and importer,
the API router, and the notes lifecycle. Vietnamese-language behaviour (diacritic folding,
slugification) is covered on purpose — the retrieval layer is built to work with it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
