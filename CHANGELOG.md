# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Curator — map, distill, review.** The store could capture and answer, but nothing turned it into
  a second brain: there was no inventory, no short version of a long document and no way to see what
  had rotted. Three deterministic jobs close that gap. `buildMasterIndex()` groups documents by
  source into shelves and reports the coverage ratios the rest of the feature builds on (tagged,
  distilled, linked). `distillDocument()` writes a one-page note from one document using one of five
  templates (generic, guideline, project, meeting, decision), in English or Vietnamese, saves it with
  `{ kind: "summary", sourceDocumentId }` metadata and links it back with a `[[wiki link]]`; a second
  run updates the same note instead of creating a duplicate. `buildHealthReport()` lists duplicates
  by content hash, empty or failed documents, unresolved wiki links, documents without a one-pager,
  orphan notes, untagged, stale and oversized documents, each with a severity. Exposed at
  `/api/v1/curator/{index,health,templates,distill}`, on a new **Curate** page, and in the CLI as
  `map`, `distill` and `review`. The built-in **Brain review** play renders the review as Markdown on
  a monthly schedule. `createNote()` gained an optional `meta` field so summary notes can record
  their source. `PATCH /api/v1/documents/:id` now merges a `meta` patch, so codes, versions and
  owners can be recorded without touching the content. Covered by eight new tests (six in
  `curator.test.ts`, two API cases); the full suite (103 tests) passes.
- **OOXML extractors and corpus onboarding.** `.xlsx`/`.xlsm` and `.pptx` are extracted from their
  ZIP parts — shared strings, one line per row, slide runs and speaker notes — so a workbook-heavy
  corpus is searchable without a spreadsheet library. Legacy `.doc`/`.ppt`/`.xls`, images and `.msg`
  stay skipped rather than being indexed as binary noise. `ingest list <manifest.json>` imports an
  explicit file list (how a reorganisation spreadsheet is loaded without walking unrelated folders),
  and `meta infer` recovers `code`, `version` and `effectiveDate` from titles such as
  `MO - FTW.06 …_V3_03.18.2026.pdf`. Covered by `tests/ooxml.test.ts` and `tests/metadata.test.ts`.
- **Studio — lessons and slide decks from selected sources.** The app could organize and explain its
  memory but not teach from it. `/studio` takes an explicit source set (or a collection, or a search
  query) and produces either a **lesson** — objectives, core concepts per source, key terms, a worked
  example, a quiz and flashcards, every point carrying a `[n]` citation — or a **slide deck** with
  speaker notes. Decks have an in-app presenter (arrow keys, `Esc`, notes, full screen) and two
  exports generated in the browser: Marp Markdown and a standalone HTML file with inline CSS and
  navigation. Deterministic without a model; with one configured the lesson is rewritten, or the deck
  comes back as JSON, and a failed model call falls back to the deterministic artifact. Artifacts are
  stored in a new `artifacts` table (migration 5) with their citations, so a citation still resolves
  after a reload. Exposed at `/api/v1/studio/{generate,artifacts}`, on the Studio page, and in the CLI
  as `studio lesson|slides|list|show|export`. Covered by `tests/studio.test.ts`.

### Fixed

- **Entity identity now follows the folded name.** `upsertEntity()` looked the row up by its id,
  which is derived from the original spelling, while the unique index is on `(type, name_fold)`.
  Two spellings that fold together — `RSX` and `rsx`, `RS-X` and `RSX` — therefore produced two
  ids for one index key, and the second insert failed the ingest with
  `UNIQUE constraint failed: entities.type, entities.name_fold`. The lookup is now by
  `(type, name_fold)`, so the second spelling updates the existing entity. Found while importing a
  real corpus; covered by a regression test in `tests/ingest.test.ts`.
- **Distilling a one-pager is rejected.** Running distill on a note that is itself a summary
  produced a “One-pager — One-pager — …” chain. `distillDocument()` now refuses with a clear message
  and points at the source document; covered in `tests/curator.test.ts`.

## [0.2.0] — 2026-10-15

### Added

- **Anthropic chat support** — chat can be routed to the Anthropic Messages API with
  `SB_AI_CHAT_PROVIDER=anthropic`. The new `lib/ai/anthropic.ts` client handles the wire-format
  differences (system prompt as a top-level field, required `max_tokens`, content blocks, typed SSE
  events), and `lib/ai/chat-provider.ts` dispatches between it and the existing OpenAI-compatible
  client, so no caller has to know which provider is configured. Embeddings stay on the
  OpenAI-compatible path, because Anthropic publishes no embeddings endpoint.
- **Searchable document titles** — `chunks_fts` and `chunks_trigram` gained a folded-title column,
  so a document can be found by a word that appears only in its title. Migrations 3 and 4 rebuild
  both indexes and fold every stored title; the change is covered by a test that upgrades a
  database written with the old schema.
- **Provider presets for the model configuration** — the AI card in Settings can fill in the
  endpoint for OpenAI, OpenRouter, Google Gemini, Ollama, LM Studio or a custom gateway, and says
  which model list to take the ids from. OpenRouter and Gemini both serve chat *and* embeddings
  through the OpenAI-compatible protocol (`https://openrouter.ai/api/v1` and
  `https://generativelanguage.googleapis.com/v1beta/openai/`), so neither needs an adapter of its
  own. The selector derives the active preset from the saved base URL, so no new setting is stored.
- **Container and Space deployment** — a multi-stage `Dockerfile` built on Next's standalone
  output and listening on 7860, with a `.dockerignore` that keeps `.env` and `data/` out of the
  build context; `scripts/deploy-huggingface.py`, which stages the repository's tracked files only,
  writes the Space's README header and uploads it; and `docs/huggingface.md`, which records the
  three constraints that decide whether a Space is the right host. Two caveats are deliberate and
  worth repeating: the image has **not** been built locally (no Docker on this machine — the
  runtime path it uses was verified directly instead), and the `hf` CLI path documented in
  `docs/huggingface.md` does not run under this machine's bundled Python, which ships without the
  `venv` module; the script and the GitHub-linked Space both avoid the CLI entirely.
- **Google Drive connector** — read-only OAuth over `files.list`, shared drives included. Google
  Docs, Sheets and Slides are exported as text, files the app can decode (`text/*`, JSON) are
  downloaded as is, and everything else is counted and skipped rather than guessed at. The first
  sync walks the drive; later ones add `modifiedTime > <previous sync>` so a delta run stays small,
  and the page token is stored so an interrupted listing resumes. `about.get` names the account in
  the connector list. Covered by tests that drive the provider with a mocked fetch, including a
  file that cannot be exported and a failing listing.
- **An About page** — `/about`, reachable from the sidebar, describing what the app does: capture,
  retrieval, answering, automations, the graph, where the data lives and what leaves the machine.
  Each automation is marked with whether it needs a model, because several of them do not.

### Fixed

- **The development server answered every request with a 500.** Next compiles
  `instrumentation.ts` for a target without the Node presets, so the bootstrap's dependency graph
  — `node:crypto` through `core/ids.ts`, `node:fs` and `node:sqlite` through the database, and the
  CommonJS `adm-zip` parser through the importer registry — could not be resolved there. An
  unresolved instrumentation bundle takes the whole server down while the process still looks
  healthy, which is why only running the server surfaced it. `adm-zip` is now loaded on demand the
  way `mammoth` and `pdfjs-dist` already were, and the server compilations leave Node built-ins and
  those three parsers as runtime requires.
- **The production build failed on `/chat`.** The page reads its `?q=` parameter with
  `useSearchParams()`, which opts the route into client-side rendering; Next requires that to sit
  behind a `Suspense` boundary. It never shows up in `next dev` or in the test suite, and it stayed
  hidden behind the type errors below, which stopped the build before prerendering ran.
- **Connector OAuth call sites now match the helpers they call.** Both call sites passed a single
  object to `exchangeCode` / `refreshAccessToken`, which take `(fetchImpl, oauth, params)`; they now
  spread the `OAuthApp` the values came from instead of repeating its fields.
- **The Slack provider names the narrowed channel type** its own filter produces, which the widened
  return type of `resolveChannels` had been cancelling at three call sites. With this,
  `npm run typecheck` is clean for the first time in this work: 11 errors at the start, 0 now.

### Changed

- Migrations may now carry an `up(database)` step, which runs inside the same transaction, for
  values that need the runtime's own normalisation rather than hand-rolled SQL.
- The AI-configured badge and `/api/v1/stats` follow the selected chat provider instead of the
  OpenAI-compatible configuration alone.

### Removed

- `src/lib/i18n/index.ts` — an unused translation dictionary no module imported.
- `probe.ts` — a scratch debugging file.

## [0.1.0] — 2026-10-15

First packaged release: a local-first personal memory system with multi-source capture, hybrid
retrieval, cited RAG chat and automated plays.

### Added

- **Capture** — markdown notes with `[[wiki links]]`, `#tags` and backlinks; file uploads
  (`.pdf`, `.docx`, `.md`, `.txt`, `.html`, `.eml`, `.csv`); URL capture with server-side text
  extraction; folder sync for Obsidian vaults or document folders.
- **Importers** — `mbox`, ICS, RFC 822, Notion export zip and Slack export zip.
- **Connectors** — Gmail, Google Calendar, Outlook / Microsoft 365, Slack (OAuth 2.0 with sealed
  credential storage and page-level cursors) and Notion (pasted integration token).
- **Retrieval** — FTS5 BM25 over diacritic-folded text, a trigram index for substrings and typos,
  optional embedding cosine similarity, fused into one ranked list with per-signal scores, facets
  and filters.
- **Chat** — streamed RAG answers grounded in retrieved passages with `[n]` citations, stored
  conversations, and an extractive fallback that works with no model configured.
- **Plays** — weekly digest, daily brief, meeting brief, open loops, find a document and topic
  dossier, each with a deterministic Markdown output and optional model synthesis.
- **Graph** — people, topics and tags extracted from your content, with co-occurrence weights.
- **Interfaces** — web UI, REST API under `/api/v1`, and a CLI (`health`, `doctor`, `stats`,
  `search`, `ask`, `add`, `ingest`, `sync`, `index`, `play`, `export`, `jobs`).
- **Operations** — background job worker, embedding backfill, JSON export, loopback-by-default
  auth with optional bearer tokens, and a smoke test that runs the whole pipeline in a temp
  directory.

### Fixed

- Chunking no longer emits a bare heading as its own chunk, and a trailing scrap is no longer
  merged across a heading boundary (which used to relabel content with the wrong heading path).
- Connector sync call sites now match the shared OAuth helper signatures, and the Slack channel
  type is narrowed where an id is guaranteed.
- Built-in plays are seeded on every read path, so running a play on a fresh database works.
- Citations carry their heading path, so the UI and prompts can show which section a passage came
  from.

### Changed

- All user-facing copy — UI, CLI output, notices and error messages — is English. Prompts are
  English too, and instruct the model to answer in the language the user wrote in. Vietnamese
  language handling (diacritic folding, slugging, stopwords) is intentionally retained.
- Repository packaging: README, architecture/API/connector/deployment docs, contributing and
  security policies, `.env.example`, `.gitattributes` and a GitHub Actions CI workflow.

### Known limitations

- Document titles are not part of the full-text index, so a word that appears only in a title is
  not matched by search.
- The model layer is OpenAI-compatible only; there is no dedicated Anthropic adapter yet.
- Single-writer: one instance per data directory.
