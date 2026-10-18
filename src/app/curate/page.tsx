"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge, Card, CardTitle, EmptyState, Notice, Spinner, Stat, api } from "@/components/ui";

type IndexedDocument = {
  id: string;
  title: string;
  sourceId: string;
  sourceKind: string;
  path: string | null;
  createdAt: string | null;
  tokenCount: number;
  pinned: boolean;
  tags: string[];
  hasSummary: boolean;
};

type Shelf = {
  id: string;
  label: string;
  count: number;
  tokens: number;
  tagged: number;
  summarized: number;
  lastTouchedAt: string | null;
  documents: IndexedDocument[];
};

type MasterIndex = {
  generatedAt: string;
  totals: { documents: number; notes: number; tags: number; links: number; summaries: number; shelves: number };
  coverage: { tagged: number; summarized: number; linked: number };
  shelves: Shelf[];
};

type HealthFinding = {
  kind: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  documentId?: string;
};

type HealthReport = {
  generatedAt: string;
  totals: { documents: number; notes: number; issues: number; bySeverity: Record<string, number> };
  coverage: { tagged: number; summarized: number; linked: number };
  counts: Record<string, number>;
  findings: HealthFinding[];
};

const KIND_LABEL: Record<string, string> = {
  duplicate: "Duplicate",
  empty: "Empty",
  broken_link: "Broken link",
  unsummarized: "No one-pager",
  orphan_note: "Orphan note",
  untagged: "No tags",
  stale: "Stale",
  large: "Large",
};

const SEVERITY_TONE: Record<HealthFinding["severity"], "warn" | "accent" | "neutral"> = {
  high: "warn",
  medium: "accent",
  low: "neutral",
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

export default function CuratePage() {
  const [index, setIndex] = useState<MasterIndex | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [indexResult, healthResult] = await Promise.all([
        api<MasterIndex>("/api/v1/curator/index"),
        api<HealthReport>("/api/v1/curator/health"),
      ]);
      setIndex(indexResult);
      setHealth(healthResult);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Curate</h1>
        <p className="text-sm text-muted">
          The map, the one-pagers and the monthly health check. Capture fills the brain; this page keeps it usable.
        </p>
      </header>

      {error ? <Notice tone="warn">{error}</Notice> : null}
      {loading && !index ? <Spinner label="Building the map…" /> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Documents" value={index?.totals.documents ?? "—"} hint={`${index?.totals.shelves ?? 0} shelves`} />
        <Stat label="Tagged" value={index ? pct(index.coverage.tagged) : "—"} hint={`${index?.totals.tags ?? 0} tags`} />
        <Stat
          label="Distilled"
          value={index ? pct(index.coverage.summarized) : "—"}
          hint={`${index?.totals.summaries ?? 0} one-pagers`}
        />
        <Stat label="Linked" value={index ? pct(index.coverage.linked) : "—"} hint={`${index?.totals.links ?? 0} links`} />
        <Stat
          label="Open issues"
          value={health?.totals.issues ?? "—"}
          hint={health ? `${health.totals.bySeverity.high ?? 0} high priority` : undefined}
        />
      </div>

      {index && index.shelves.length === 0 ? (
        <EmptyState
          title="Nothing to map yet"
          hint="Capture a note, import a folder or connect a service, then come back."
          action={
            <Link href="/import" className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60">
              Import
            </Link>
          }
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardTitle hint={index ? `updated ${index.generatedAt.slice(0, 16).replace("T", " ")}` : undefined}>
            Map of content
          </CardTitle>
          <div className="space-y-3">
            {(index?.shelves ?? []).map((shelf) => (
              <div key={shelf.id} className="rounded-xl border border-line bg-raised/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{shelf.label}</p>
                    <p className="text-[11px] text-muted">
                      <code>{shelf.id}</code> · last touched {day(shelf.lastTouchedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                    <Badge>{shelf.count} docs</Badge>
                    <Badge tone={shelf.summarized > 0 ? "good" : "neutral"}>{shelf.summarized} distilled</Badge>
                    <Badge>{shelf.tagged} tagged</Badge>
                  </div>
                </div>
                <ul className="mt-2 space-y-1">
                  {shelf.documents.map((doc) => (
                    <li key={doc.id} className="flex items-center gap-2 text-xs">
                      <Link href={`/library/${doc.id}`} className="truncate hover:underline">
                        {doc.title}
                      </Link>
                      {doc.hasSummary ? <span title="Has a one-pager">✓</span> : null}
                      {doc.tags.slice(0, 2).map((tag) => (
                        <span key={tag} className="rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted">
                          #{tag}
                        </span>
                      ))}
                    </li>
                  ))}
                  {shelf.count > shelf.documents.length ? (
                    <li className="text-[11px] text-muted">+{shelf.count - shelf.documents.length} more</li>
                  ) : null}
                </ul>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle hint={health ? `${health.totals.issues} found` : undefined}>Hygiene check</CardTitle>
            {!health ? (
              <p className="text-xs text-muted">No report yet.</p>
            ) : health.findings.length === 0 ? (
              <p className="text-xs text-muted">Nothing to fix: every document is tagged, distilled and linked.</p>
            ) : (
              <ul className="space-y-2">
                {health.findings.slice(0, 12).map((finding, position) => (
                  <li key={`${finding.kind}-${finding.documentId ?? position}`} className="rounded-xl border border-line bg-raised/60 p-2.5">
                    <div className="flex items-center gap-2">
                      <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge>
                      <span className="text-[11px] text-muted">{KIND_LABEL[finding.kind] ?? finding.kind}</span>
                    </div>
                    <p className="mt-1 truncate text-xs font-medium">
                      {finding.documentId ? (
                        <Link href={`/library/${finding.documentId}`} className="hover:underline">
                          {finding.title}
                        </Link>
                      ) : (
                        finding.title
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{finding.detail}</p>
                  </li>
                ))}
                {health.findings.length > 12 ? (
                  <li className="text-[11px] text-muted">+{health.findings.length - 12} more in the full report</li>
                ) : null}
              </ul>
            )}
            <p className="mt-3 text-[11px] text-muted">
              Run the <Link href="/plays" className="underline">Brain review</Link> play for the monthly version with next actions.
            </p>
          </Card>

          <Card>
            <CardTitle>How this page fits</CardTitle>
            <ul className="space-y-2 text-xs text-muted">
              <li>
                <strong className="text-ink">Map</strong> — every shelf above is one source; the counts tell you where the knowledge lives.
              </li>
              <li>
                <strong className="text-ink">Distill</strong> — open any document and press “Distill to a one-pager”. The note is linked back to its source.
              </li>
              <li>
                <strong className="text-ink">Link</strong> — tags on three axes (domain · object · type) plus <code>[[wiki links]]</code> between notes.
              </li>
              <li>
                <strong className="text-ink">Review</strong> — this check is the monthly ritual: fix high findings, then re-run.
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
