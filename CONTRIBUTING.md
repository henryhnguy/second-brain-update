# Contributing

Thanks for taking a look. This is a small, local-first project, so the bar is simply: the change
is verifiable and the checks stay green.

## Getting set up

```bash
npm install
npm run dev        # http://localhost:4173
```

Node.js 24+ is required (the database uses the built-in `node:sqlite` module).

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run smoke
```

All three must pass. CI runs the same commands, plus `npm run build`.

## Ground rules

- **Do not weaken a check to make it pass.** No `any`, no `@ts-ignore`, no skipped or deleted
  tests. If an assertion is genuinely wrong, fix the assertion and say why in the description.
- **Keep the write path single.** Text reaches the database through `ingestText` in
  `src/lib/ingest/pipeline.ts`; new sources adapt to it rather than writing rows themselves.
- **Keep SQL in `src/lib/db`.** Other layers use repositories, not queries.
- **Explain non-obvious decisions in a comment** — especially in the chunker, the retrieval
  fusion and the connector cursor handling, where the behaviour is subtle and easy to "simplify"
  into a bug.
- **No new runtime dependency without a reason.** The dependency list is deliberately short:
  parsers are loaded on demand and the rest is the platform.

## Language

The codebase, UI copy and documentation are in English. Two things are intentionally not:

- **Vietnamese language handling** — the stopword list, the diacritic folding table and the slug
  rules in `src/lib/core/text.ts`, and the Vietnamese open-loop cues in
  `src/lib/plays/engine.ts`. These are features; they make search work on Vietnamese content.
- **Test fixtures** — sample notes in the suites are Vietnamese on purpose, so the tokeniser,
  folding and slug behaviour stays covered.

Models are told to answer in the language the user wrote in, so a Vietnamese question gets a
Vietnamese answer even though the prompts are English.

## Adding a connector

1. Add a provider in `src/lib/connectors/providers/` implementing `Provider` from
   `src/lib/connectors/types.ts`: `syncPage(ctx)` returns one page of documents plus the next
   cursor and must be idempotent for a replayed cursor.
2. Register it in `src/lib/connectors/registry.ts`.
3. Use `ctx.fetchImpl` rather than global `fetch`, and pass the cursor through the helpers — never
   read the clock or a global to decide where to resume.
4. Add a test that drives the provider with a mocked fetch, including the empty and error pages.
5. Document the app registration steps in `docs/connectors.md`.

## Adding an extractor or importer

Add it under `src/lib/extract/` or `src/lib/import/`, register it, and add a test with a small
in-memory fixture — do not commit large binaries.

## Commits

Small, focused commits with an imperative subject line (`fix: …`, `feat: …`, `docs: …`). Explain
*why* in the body when the change is not self-evident.
