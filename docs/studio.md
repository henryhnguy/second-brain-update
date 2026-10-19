# Studio — lessons and decks from your own sources

Studio is the "notebook" half of the app: pick a handful of documents and turn them into something
you can teach from. It is deliberately close to the NotebookLM workflow — sources in, artifact out —
but it runs on the same local database as everything else, and it produces a useful artifact with no
model configured.

```
sources ──▶ lesson   (objectives, concepts, terms, example, quiz, flashcards)
        └─▶ deck    (title, agenda, one slide per source, takeaways, sources)
```

## Choosing sources

`POST /api/v1/studio/generate` takes exactly one of:

| Field | Meaning |
| --- | --- |
| `documentIds` | The explicit set picked in the Studio UI |
| `collectionId` | Resolve a saved collection to its documents |
| `query` | Hybrid search, top results become the sources |

`limit` caps the set (default 8, max 25). Fewer, focused sources make a better lesson; a wide set is
better for a survey deck.

## The lesson

A deterministic lesson contains:

1. **Learning objectives** — one per leading source.
2. **Core concepts** — a subsection per source, with the highest-signal sentences and a `[n]`.
3. **Key terms** — the most frequent domain terms with the sentence that defines them.
4. **Worked example** — a passage that reads like a procedure or case.
5. **Check your understanding** — four question/answer pairs, each tied to a source.
6. **Flashcards** — term → definition.
7. **Sources** — the numbered list the citations resolve to.

Sentence selection filters out tables of contents, page markers and dot leaders before ranking, so a
PDF manual does not turn into a table of contents.

## The deck

A deterministic deck is 6–10 slides: a title slide, an agenda, one slide per source (four bullets),
key takeaways and a sources slide. Speaker notes carry the source number and path.

Two exports are built in, both generated in the browser from the stored slides:

- **Marp Markdown** — `marp: true`, one `---` between slides, notes as HTML comments. Works with
  Marp, Obsidian Slides and most Markdown deck tools.
- **Standalone HTML** — one file with inline CSS and arrow-key navigation, no external assets.

The in-app presenter supports arrow keys, `Esc`, a notes toggle and a full-screen mode.

## With a model

When `SB_AI_*` is configured and the artifact is generated with `useLlm: true`, the deterministic
result is replaced by a model-written lesson or a JSON slide deck. If the model fails or returns
invalid JSON, the deterministic artifact is kept — generation never fails because of the model.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/studio/generate` | `{ kind, documentIds? , collectionId?, query?, limit?, maxSlides?, lang?, useLlm?, title? }` |
| `GET` | `/api/v1/studio/artifacts` | `?kind=lesson|slides&limit=N` |
| `GET` | `/api/v1/studio/artifacts/:id` | One artifact, citations included |
| `DELETE` | `/api/v1/studio/artifacts/:id` | Delete the artifact, keep the sources |

## CLI

```bash
npm run cli -- studio lesson --filter 01_Guidelines --limit 6
npm run cli -- studio slides --docs doc_a,doc_b --max-slides 12 --lang vi
npm run cli -- studio list
npm run cli -- studio show art_…
npm run cli -- studio export art_… --out deck.md
```

## Limits

- Lessons and decks are extractive without a model: they select, order and label, they do not rewrite.
- A deck is a summary of the selected sources, not a designed visual template; the HTML export is
  intentionally plain so it stays editable.
- Source discovery is capped at 25 documents per artifact; that is a context window decision, not a
  storage one.
