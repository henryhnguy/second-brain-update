"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Input, Notice, Spinner, Tabs, api } from "@/components/ui";

type Signals = { bm25?: number; cosine?: number; trigram?: number; recency?: number; pin?: number };

type Hit = {
  documentId: string;
  chunkId: string | null;
  title: string;
  sourceId: string;
  sourceKind: string;
  url: string | null;
  path: string | null;
  createdAt: string | null;
  score: number;
  signals: Signals;
  snippet: string;
  headingPath: string | null;
};

type SearchResponse = {
  query: string;
  mode: string;
  semanticAvailable: boolean;
  tookMs: number;
  total: number;
  hits: Hit[];
  facets: { sourceKind: Record<string, number>; sourceId: Record<string, number>; tags: Record<string, number> };
};

const MODES = [
  { id: "hybrid", label: "Hybrid" },
  { id: "keyword", label: "Keyword" },
  { id: "semantic", label: "Semantic" },
] as const;

function scoreBadge(hit: Hit): string {
  const parts: string[] = [];
  if (hit.signals.bm25 !== undefined) parts.push(`bm25 ${hit.signals.bm25.toFixed(2)}`);
  if (hit.signals.cosine !== undefined) parts.push(`cos ${hit.signals.cosine.toFixed(2)}`);
  if (hit.signals.trigram !== undefined) parts.push(`tri ${hit.signals.trigram.toFixed(2)}`);
  return parts.join(" · ");
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"hybrid" | "keyword" | "semantic">("hybrid");
  const [source, setSource] = useState("");
  const [tags, setTags] = useState("");
  const [since, setSince] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (query.trim().length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query, mode, limit: "25" });
      if (source.trim()) params.set("source", source.trim());
      if (tags.trim()) params.set("tag", tags.trim());
      if (since) params.set("since", new Date(since).toISOString());
      setResult(await api<SearchResponse>(`/api/v1/search?${params.toString()}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted">
          Search without diacritics still returns results (the index is diacritic-stripped). Hybrid mode combines BM25, trigram and
          vectors when embeddings are available.
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="text-xs text-muted">Keyword</label>
            <div className="mt-1">
              <Input value={query} onChange={setQuery} placeholder="e.g. q3 report" onEnter={() => void run()} />
            </div>
          </div>
          <div className="w-40">
            <label className="text-xs text-muted">Source</label>
            <div className="mt-1">
              <Input value={source} onChange={setSource} placeholder="gmail, note…" />
            </div>
          </div>
          <div className="w-40">
            <label className="text-xs text-muted">Tag</label>
            <div className="mt-1">
              <Input value={tags} onChange={setTags} placeholder="project" />
            </div>
          </div>
          <div className="w-40">
            <label className="text-xs text-muted">Since</label>
            <div className="mt-1">
              <Input value={since} onChange={setSince} type="date" />
            </div>
          </div>
          <Button variant="primary" onClick={() => void run()} disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Tabs tabs={MODES.map((entry) => ({ id: entry.id, label: entry.label }))} active={mode} onChange={setMode} />
          <span className="text-xs text-muted">
            {mode === "semantic" && result && !result.semanticAvailable
              ? "No embeddings for the current model yet — create embeddings in Settings."
              : ""}
          </span>
        </div>
      </Card>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {result ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>
              {result.total} matching documents · {result.tookMs}ms · {result.mode} mode
            </span>
            {result.semanticAvailable ? <Badge tone="good">embedded</Badge> : <Badge tone="warn">keyword only</Badge>}
            <Link href={`/chat?q=${encodeURIComponent(result.query)}`} className="underline">
              Ask about this result →
            </Link>
          </div>

          {result.hits.length === 0 ? (
            <EmptyState
              title="No results found"
              hint="Try shorter keywords, drop diacritics, or import more data under Connectors / Import."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
              <ol className="space-y-3">
                {result.hits.map((hit) => (
                  <li key={`${hit.documentId}-${hit.chunkId ?? "doc"}`}>
                    <Card className="transition hover:border-accent/50">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <Link href={`/library/${hit.documentId}`} className="line-clamp-1 text-sm font-medium hover:underline">
                          {hit.title}
                        </Link>
                        <div className="flex items-center gap-2 text-[11px] text-muted">
                          <Badge>{hit.sourceId}</Badge>
                          <span className="tabular-nums">{hit.score.toFixed(3)}</span>
                        </div>
                      </div>
                      {hit.headingPath ? <p className="mt-1 text-[11px] text-muted">› {hit.headingPath}</p> : null}
                      <p className="mt-2 text-sm leading-relaxed text-muted">{hit.snippet}</p>
                      <p className="mt-2 text-[11px] text-muted">
                        {hit.createdAt ? `${hit.createdAt.slice(0, 10)} · ` : ""}
                        {scoreBadge(hit)}
                      </p>
                    </Card>
                  </li>
                ))}
              </ol>

              <div className="space-y-4">
                <Card>
                  <CardTitle>Source breakdown</CardTitle>
                  <ul className="space-y-1 text-xs">
                    {Object.entries(result.facets.sourceId).slice(0, 12).map(([key, value]) => (
                      <li key={key} className="flex justify-between">
                        <span className="truncate">{key}</span>
                        <span className="tabular-nums text-muted">{value}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card>
                  <CardTitle>Related tags</CardTitle>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(result.facets.tags).slice(0, 20).map(([key, value]) => (
                      <Badge key={key}>
                        #{key} · {value}
                      </Badge>
                    ))}
                  </div>
                </Card>
                <Card>
                  <CardTitle>How scoring works</CardTitle>
                  <p className="text-xs text-muted">
                    The final score is an RRF fusion of three retrievers (BM25 1.0 · trigram 0.45 · vector 1.15), plus a small bonus
                    for recency and pinned items. Scores are only meaningful when compared within the same query.
                  </p>
                </Card>
              </div>
            </div>
          )}
        </>
      ) : loading ? (
        <Spinner />
      ) : (
        <EmptyState title="Enter keywords to search" hint="For example: &quot;last week's meeting with customer A&quot; or &quot;payments spec&quot;." />
      )}
    </div>
  );
}
