"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Notice, Stat, Tabs, Textarea, api } from "@/components/ui";

type Stats = {
  documents: number;
  chunks: number;
  notes: number;
  embeddings: number;
  connectors: number;
  conversations: number;
  bySource: { sourceId: string; sourceKind: string; count: number }[];
  lastIngestAt: string | null;
  databaseBytes: number;
  aiConfigured: boolean;
  embeddingCoverage: number;
};

type DocumentRow = {
  id: string;
  title: string;
  sourceId: string;
  sourceKind: string;
  createdAt: string | null;
  ingestedAt: string;
  chunkCount: number;
};

type Job = { id: string; kind: string; status: string; createdAt: string; error: string | null };

type Health = { sqlite: string; fts5: boolean; trigram: boolean; worker: { running: boolean; queue: Record<string, number> } };

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [recent, setRecent] = useState<DocumentRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [capture, setCapture] = useState("");
  const [mode, setMode] = useState<"note" | "paste">("note");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [statsResult, healthResult, docs, jobResult] = await Promise.all([
      api<Stats>("/api/v1/stats"),
      api<Health>("/api/v1/health"),
      api<{ items: DocumentRow[] }>("/api/v1/documents?limit=8"),
      api<{ jobs: Job[] }>("/api/v1/jobs?limit=6"),
    ]);
    setStats(statsResult);
    setHealth(healthResult);
    setRecent(docs.items);
    setJobs(jobResult.jobs);
  }, []);

  useEffect(() => {
    void load().catch(() => setMessage("Could not load status."));
  }, [load]);

  async function submitCapture() {
    // Same guard as the chat composer: nothing to save, or a save already running.
    if (capture.trim().length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/v1/ingest/text", {
        method: "POST",
        body: JSON.stringify({ text: capture, sourceKind: mode, title: capture.split("\n")[0]?.slice(0, 80) }),
      });
      setCapture("");
      setMessage("Saved to memory.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">Your personal memory, running entirely on this machine.</p>
        </div>
        {health ? (
          <div className="flex flex-wrap gap-2">
            <Badge tone={health.fts5 ? "good" : "warn"}>FTS5 {health.fts5 ? "on" : "off"}</Badge>
            <Badge tone={health.trigram ? "good" : "neutral"}>trigram {health.trigram ? "on" : "off"}</Badge>
            <Badge tone={health.worker.running ? "good" : "warn"}>
              worker {health.worker.running ? "running" : "paused"}
            </Badge>
            <Badge>SQLite {health.sqlite}</Badge>
          </div>
        ) : null}
      </header>

      <Card>
        <CardTitle hint="Ctrl/⌘ + Enter to save">Quick capture</CardTitle>
        <Tabs
          tabs={[
            { id: "note", label: "Notes" },
            { id: "paste", label: "Raw text" },
          ]}
          active={mode}
          onChange={setMode}
        />
        <div className="mt-3">
          <Textarea
            value={capture}
            onChange={setCapture}
            rows={4}
            onSubmitCombo={() => void submitCapture()}
            placeholder="Write a note, paste content or a link to save…"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={() => void submitCapture()} disabled={busy}>
            {busy ? "Saving…" : "Save to memory"}
          </Button>
          <Link href="/import" className="text-xs text-muted hover:text-ink">
            or import from a file / folder / export
          </Link>
        </div>
        {message ? (
          <div className="mt-3">
            <Notice tone={message.includes("Saved") ? "good" : "warn"}>{message}</Notice>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Documents" value={stats?.documents ?? "—"} hint={stats?.lastIngestAt ? `latest ${stats.lastIngestAt.slice(0, 16).replace("T", " ")}` : "no data yet"} />
        <Stat label="Notes" value={stats?.notes ?? "—"} />
        <Stat label="Indexed chunks" value={stats?.chunks ?? "—"} hint={stats ? `DB ${bytes(stats.databaseBytes)}` : undefined} />
        <Stat
          label="Embedding"
          value={stats ? `${Math.round(stats.embeddingCoverage * 100)}%` : "—"}
          hint={stats?.aiConfigured ? `${stats.embeddings} vector` : "no model configured"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={<Link href="/library" className="hover:text-ink">View all</Link>}>Recently added</CardTitle>
          {recent.length === 0 ? (
            <EmptyState title="No documents yet" hint="Use the quick capture box above, or sync a folder under Import." />
          ) : (
            <ul className="space-y-2">
              {recent.map((doc) => (
                <li key={doc.id} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2 last:border-0">
                  <div className="min-w-0">
                    <Link href={`/library/${doc.id}`} className="line-clamp-1 text-sm hover:underline">
                      {doc.title}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {doc.sourceId} · {doc.chunkCount} chunks · {(doc.createdAt ?? doc.ingestedAt).slice(0, 10)}
                    </p>
                  </div>
                  <Badge>{doc.sourceKind}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle hint={stats ? `${stats.bySource.length} sources` : undefined}>Knowledge base</CardTitle>
            {stats && stats.bySource.length > 0 ? (
              <ul className="space-y-1.5 text-sm">
                {stats.bySource.map((entry) => (
                  <li key={entry.sourceId} className="flex items-center justify-between gap-3">
                    <span className="truncate">{entry.sourceId}</span>
                    <span className="tabular-nums text-muted">{entry.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No sources yet. Connect Gmail/Slack/Notion or sync a notes folder.</p>
            )}
          </Card>

          <Card>
            <CardTitle hint={<Link href="/plays" className="hover:text-ink">Automations</Link>}>Background jobs</CardTitle>
            {jobs.length === 0 ? (
              <p className="text-xs text-muted">No recent jobs.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {jobs.map((job) => (
                  <li key={job.id} className="flex items-center justify-between gap-3">
                    <span className="truncate">{job.kind}</span>
                    <Badge tone={job.status === "done" ? "good" : job.status === "failed" ? "warn" : "neutral"}>{job.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {stats && !stats.aiConfigured ? (
        <Notice tone="warn">
          No AI model configured: search and ask still run in keyword mode with direct citations. Add a base URL/API key
          (or point at Ollama) in <Link href="/settings" className="underline">Settings</Link> to enable synthesised answers.
        </Notice>
      ) : null}
    </div>
  );
}
