# Curating the memory

Capture is only half of a second brain. The other half is making what was captured **findable,
readable and trustworthy** months later. This document describes the curator: the three jobs that
run on top of the store.

```
capture ──▶ index (what exists) ──▶ distill (what it says) ──▶ review (what to fix)
                    │                        │                       │
                 /curate               one-pager note          Brain review play
```

Everything described here works without a model. When one is configured, distillation can hand the
extraction to it, but the deterministic path stays the default fallback so the feature never blocks
on an API key.

## 1. The map — `GET /api/v1/curator/index`

The map answers “what do I have, and where does it live?” without a search query.

- Documents are grouped into **shelves** by `sourceId` (the folder, connector or import that produced
  them), sorted by size.
- Each shelf reports its document count, token count, how many documents are tagged, how many have a
  one-pager, and when it was last touched.
- The response also carries the **coverage** ratios that the review builds on:

  | Ratio | Meaning |
  | --- | --- |
  | `tagged` | documents with at least one tag |
  | `summarized` | non-note documents that have a distilled one-pager |
  | `linked` | documents with an incoming or outgoing `[[wiki link]]` |

In the UI this is the **Curate** page (`/curate`). The CLI has the same view:

```bash
npm run cli -- map            # shelf list + coverage
npm run cli -- map --docs 5   # five example documents per shelf
```

## 2. Distillation — `POST /api/v1/curator/distill`

A one-pager is a short note that says what a document is, what matters in it and where it came from.
Distilling a document:

1. extracts the lead sentences, key terms, rule-like sentences and warning-like sentences from the
   indexed chunks;
2. fills a template (below) in English or Vietnamese;
3. saves the result **as a note**, titled `One-pager — <source title>`, with metadata
   `{ kind: "summary", sourceDocumentId, template }`;
4. links the note to its source with `[[<source title>]]`, so the source shows a backlink.

Running it again for the same document and template **updates the existing note** instead of creating
a duplicate. That is what makes a monthly re-distill safe.

```bash
npm run cli -- distill <documentId> --template guideline --lang vi
npm run cli -- distill <documentId> --preview   # print only, do not save
```

Request body:

```json
{ "documentId": "doc_…", "template": "guideline", "lang": "vi", "save": true, "useLlm": true }
```

### Templates

| Id | Sections | Use it for |
| --- | --- | --- |
| `generic` | Summary · Key points · Key terms · Source | anything |
| `guideline` | Purpose · When to use · Who it is for · Key rules · Watch-outs · Source | guidelines, SOPs, standards |
| `project` | What it is · Status · Timeline · Key points · Risks · Source | project folders, tech trials |
| `meeting` | What was discussed · Attendees · Decisions · Next actions · Source | minutes, briefs |
| `decision` | Decision · Context · Options · Consequences · Source | decision logs |

When a section is not covered by the source, the note says so explicitly rather than inventing
content. `GET /api/v1/curator/templates` returns the catalogue for the UI.

### Metadata conventions

Distillation reads optional fields from `documents.meta` and prints them at the top of the note:
`code`, `version`, `status`, `owner`, `effectiveDate`. They are not required, but filling them makes
the index and the review far more useful:

```json
{ "code": "MO-FTW.06", "version": "V3", "status": "active", "owner": "Engineering", "effectiveDate": "2026-03-18" }
```

Write them without touching the content:

```bash
curl -s -X PATCH localhost:4173/api/v1/documents/<id> \
  -H 'content-type: application/json' \
  -d '{"meta":{"code":"MO-FTW.06","version":"V3","status":"active"}}'
```

## 3. Linking

The curator does not invent a new linking model; it leans on the two that exist:

- **Tags** on three axes: domain (`mo`, `qms`, `pe`, `sop`), object (`outsole`, `bonding`, `last`),
  type (`guideline`, `sop`, `report`, `template`, `tracking`).
- **`[[wiki links]]`** between notes and documents. Unresolved links are surfaced by the review
  instead of failing silently.

Naming rule used by the reference corpus: `[Series].[Number] [Title]_V[Major]_[DD.MM.YYYY].[ext]`.
A new revision replaces the file and pushes the old one to an archive folder; the document keeps its
code, so links and tags survive.

## 4. The review — `GET /api/v1/curator/health` and the Brain review play

The review is a checklist, not prose. It counts and lists eight kinds of problem:

| Kind | Severity | What it means |
| --- | --- | --- |
| `duplicate` | high | two or more documents share one content hash |
| `empty` | high | zero characters, or extraction failed |
| `broken_link` | high | a `[[wiki link]]` points at no document |
| `unsummarized` | medium | a non-note document has no one-pager |
| `orphan_note` | medium | a note with no tags and no links in either direction |
| `untagged` | low | no tags on the document |
| `stale` | low | untouched for longer than `--days` (default 180) |
| `large` | low | more than 20 000 tokens |

Coverage ratios are returned alongside the findings, so a dashboard can show progress rather than
just a problem count. The built-in **Brain review** play (`play_brain_review`, monthly) renders the
same report as Markdown with a “next actions” section, so it can be scheduled:

```bash
npm run cli -- review           # human-readable report, exit 1 when high issues exist
npm run cli -- review --json    # the raw report
npm run cli -- play run play_brain_review
```

## Ritual

| Cadence | Action |
| --- | --- |
| every capture | tag it, or accept that the review will list it |
| weekly | run `map`, distil the three most important new documents |
| monthly | run `review`, fix every high finding, archive duplicates |
| quarterly | re-distil the guidelines that changed, archive what is superseded |

## Limits

- The index groups by `sourceId`; rule-based collections are intentionally not used as a second
  grouping, to avoid two competing maps.
- Deterministic distillation is extractive: it quotes and orders, it does not reason. Configure a
  model for a written synthesis.
- The review scans the whole store on every call. That is fine for a personal brain (thousands of
  documents); a much larger corpus would want a materialised report.
