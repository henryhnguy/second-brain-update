import Link from "next/link";

import { Badge, Card, CardTitle } from "@/components/ui";

/**
 * What this app does, in one place.
 *
 * A server component on purpose: it is a document, not a screen, so it renders
 * without any client JavaScript and can be read before anything is configured.
 */

const CAPTURE = [
  ["Notes", "Markdown with [[wiki links]] and #tags, plus backlinks between them."],
  ["Files", ".pdf, .docx, .md, .txt, .html, .eml and .csv, parsed on this machine."],
  ["Web pages", "Paste a URL and the readable text is extracted server-side."],
  ["Folders", "Point it at an Obsidian vault or a documents folder and re-sync on change."],
  ["Exports", "mbox (mail), ICS (calendar), Notion and Slack export zips, single .eml files."],
  ["Connectors", "Gmail, Google Calendar, Google Drive, Outlook / Microsoft 365, Slack, Notion."],
];

const FIND = [
  ["Keyword", "SQLite FTS5 with BM25 ranking, and a trigram index for substrings and typos."],
  ["Diacritics", "`bao cao` finds `Báo cáo`: the index is folded, so typing accents is optional."],
  ["Titles", "The document title is indexed too, so a word that only appears in the name still matches."],
  ["Semantic", "Optional: embeddings add a vector signal to the same ranking when a model is configured."],
  ["Filters", "By source, tag, connector and date, with facets on the matched set."],
];

const CURATE = [
  ["Map", "Documents grouped by source, with the share that is tagged, distilled and linked."],
  ["Distil", "A one-page note per document from five templates, linked back and refreshed in place."],
  ["Review", "Duplicates, broken links, empty, untagged, stale and orphan documents with a next action."],
  ["Ritual", "Run the map weekly, the review monthly, and re-distil guidelines when they change."],
];

const ASK = [
  ["Grounded", "Answers use only the passages retrieved for your question, each claim carrying a [n] citation."],
  ["Cited", "Every citation points at the document, the section it came from and a snippet."],
  ["Streamed", "The answer arrives token by token; conversations are kept locally."],
  ["No model needed", "Without a model it answers by quoting the best passages directly, rather than pretending."],
];

const AUTOMATE = [
  ["Weekly digest", "Everything saved in the last 7 days, grouped by topic and source.", true],
  ["Today's brief", "The 3-6 most important points of the day, each with its source.", true],
  ["Meeting brief", "Context, earlier exchanges and documents for one meeting.", true],
  ["Open loops", "Deadlines, unanswered requests and questions with no conclusion.", false],
  ["Find a document", "Answers \"where did I put that?\" with hybrid search.", false],
  ["Topic dossier", "A timeline of everything known about one topic.", true],
  ["Brain review", "Monthly hygiene check: coverage, duplicates, stale and unlinked knowledge.", false],
];

const OTHER = [
  ["Knowledge graph", "People, organisations and topics extracted with weights and co-occurrence — no model involved."],
  ["Timeline", "Everything you have saved, in the order it arrived."],
  ["Library", "Every document with its chunks, source, size and status."],
  ["CLI", "health, doctor, stats, search, ask, add, ingest, sync, index, play, map, review, distill, export, jobs."],
  ["HTTP API", "Everything the UI does goes through /api/v1, so scripts can use it too."],
];

export default function AboutPage() {
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">About Second Brain</h1>
        <p className="max-w-3xl text-sm text-muted">
          A personal knowledge and memory system that runs on your own machine. Capture notes, files,
          mail and chat from the tools you already use, search across all of it, ask questions that come
          back with citations, and let the recurring write-ups happen on their own.
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge tone="good">Local-first</Badge>
          <Badge>SQLite, one file</Badge>
          <Badge>Works with no model configured</Badge>
          <Badge>Node 24+</Badge>
        </div>
      </header>

      <Card>
        <CardTitle hint="notes, files, pages, exports, connectors">Capture</CardTitle>
        <ul className="space-y-2 text-sm">
          {CAPTURE.map(([name, detail]) => (
            <li key={name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="w-40 shrink-0 font-medium">{name}</span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Everything is chunked with an awareness of structure: markdown headings become each chunk&apos;s
          heading path, code fences stay whole, and every chunk records where it came from so a citation
          can point at the exact passage.
        </p>
      </Card>

      <Card>
        <CardTitle hint="hybrid retrieval">Find it again</CardTitle>
        <ul className="space-y-2 text-sm">
          {FIND.map(([name, detail]) => (
            <li key={name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="w-40 shrink-0 font-medium">{name}</span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs">
          <Link href="/search" className="underline">
            Open Search →
          </Link>
        </p>
      </Card>

      <Card>
        <CardTitle hint="the part that keeps it usable">Curate</CardTitle>
        <ul className="space-y-2 text-sm">
          {CURATE.map(([name, detail]) => (
            <li key={name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="w-40 shrink-0 font-medium">{name}</span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          All three run without a model; a configured model only makes the one-pagers read better.
        </p>
        <p className="mt-3 text-xs">
          <Link href="/curate" className="underline">
            Open Curate →
          </Link>
        </p>
      </Card>

      <Card>
        <CardTitle hint="answers from your own data">Ask</CardTitle>
        <ul className="space-y-2 text-sm">
          {ASK.map(([name, detail]) => (
            <li key={name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="w-40 shrink-0 font-medium">{name}</span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs">
          <Link href="/chat" className="underline">
            Open Ask →
          </Link>
        </p>
      </Card>

      <Card>
        <CardTitle hint="a model is optional, and marked">Automations</CardTitle>
        <ul className="space-y-2 text-sm">
          {AUTOMATE.map(([name, detail, usesModel]) => (
            <li key={String(name)} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="flex w-40 shrink-0 items-center gap-2 font-medium">
                {name}
                <Badge tone={usesModel ? "neutral" : "good"}>{usesModel ? "model" : "no model"}</Badge>
              </span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          A play builds a deterministic Markdown digest first, then hands it to a model when one is
          configured. A failed model call falls back to that digest instead of failing the run.
        </p>
        <p className="mt-3 text-xs">
          <Link href="/plays" className="underline">
            Open Automations →
          </Link>
        </p>
      </Card>

      <Card>
        <CardTitle hint="no model anywhere near them">Also in here</CardTitle>
        <ul className="space-y-2 text-sm">
          {OTHER.map(([name, detail]) => (
            <li key={name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <span className="w-40 shrink-0 font-medium">{name}</span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardTitle hint="what leaves the machine, and what does not">Your data</CardTitle>
        <ul className="space-y-2 text-sm">
          <li className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <span className="w-40 shrink-0 font-medium">Where it lives</span>
            <span className="text-muted">
              One SQLite file plus the files you uploaded, under <code>data/</code> — ignored by git, never
              uploaded anywhere by the app.
            </span>
          </li>
          <li className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <span className="w-40 shrink-0 font-medium">Credentials</span>
            <span className="text-muted">
              Connector tokens and the model key are sealed with a local key (<code>data/.secret</code>) and
              shown masked. Back that file up with the database.
            </span>
          </li>
          <li className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <span className="w-40 shrink-0 font-medium">The API</span>
            <span className="text-muted">
              Local requests only by default. If you expose it, set an API token or put an authenticating
              proxy in front first.
            </span>
          </li>
          <li className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <span className="w-40 shrink-0 font-medium">The model</span>
            <span className="text-muted">
              Only the passages retrieved for a question, or the text being embedded, are sent — never the
              whole memory. Leave the model unconfigured and nothing leaves at all.
            </span>
          </li>
          <li className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
            <span className="w-40 shrink-0 font-medium">No telemetry</span>
            <span className="text-muted">The app talks to no service of its own.</span>
          </li>
        </ul>
      </Card>

      <Card>
        <CardTitle hint="from a terminal, in the project folder">Run it</CardTitle>
        <pre className="overflow-auto rounded-xl border border-line bg-raised p-3 text-[11px] leading-relaxed">
          {["npm install", "npm run dev        # http://localhost:4173", "npm test           # the suite", "npm run smoke      # end-to-end, in a temp directory"].join("\n")}
        </pre>
        <p className="mt-3 text-xs text-muted">
          Node.js 24 or newer: the database uses the built-in <code>node:sqlite</code> module, so there is no
          native build step and no database server to run. The repository&apos;s <code>docs/</code> folder
          covers architecture, the HTTP API, connector setup, deployment and free ways to host it.
        </p>
        <p className="mt-3 text-xs">
          <Link href="/settings" className="underline">
            Configure a model →
          </Link>{" "}
          ·{" "}
          <Link href="/connectors" className="underline">
            Connect a source →
          </Link>{" "}
          ·{" "}
          <Link href="/import" className="underline">
            Import an export →
          </Link>
        </p>
      </Card>
    </div>
  );
}
