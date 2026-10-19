"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Input, Notice, Spinner, api } from "@/components/ui";

type DocumentRow = {
  id: string;
  title: string;
  sourceId: string;
  sourceKind: string;
  chunkCount: number;
  ingestedAt: string;
};

type ArtifactRow = {
  id: string;
  kind: "lesson" | "slides";
  title: string;
  documentIds: string[];
  citations: unknown[];
  usedLlm: boolean;
  createdAt: string;
};

type ArtifactResult = ArtifactRow & { markdown: string };

const KINDS = [
  {
    id: "lesson" as const,
    name: "Lesson",
    detail: "Objectives, core concepts, key terms, a worked example, quiz and flashcards.",
  },
  {
    id: "slides" as const,
    name: "Slide deck",
    detail: "A presenter with speaker notes, plus Marp Markdown and standalone HTML exports.",
  },
];

export default function StudioPage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"lesson" | "slides">("lesson");
  const [lang, setLang] = useState<"en" | "vi">("en");
  const [maxSlides, setMaxSlides] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [docs, recent] = await Promise.all([
        api<{ items: DocumentRow[] }>("/api/v1/documents?limit=100&order=created"),
        api<{ artifacts: ArtifactRow[] }>("/api/v1/studio/artifacts?limit=12"),
      ]);
      setDocuments(docs.items);
      setArtifacts(recent.artifacts);
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

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return documents;
    return documents.filter(
      (doc) => doc.title.toLowerCase().includes(needle) || doc.sourceId.toLowerCase().includes(needle),
    );
  }, [documents, filter]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ArtifactResult>("/api/v1/studio/generate", {
        method: "POST",
        body: JSON.stringify({
          kind,
          documentIds: Array.from(selected),
          lang,
          maxSlides: Number(maxSlides) || 10,
          useLlm: true,
        }),
      });
      router.push(`/studio/${result.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Studio</h1>
        <p className="text-sm text-muted">
          Pick sources, then turn them into a lesson or a slide deck. Everything is grounded in your own memory; with no
          model the passages are selected and ordered, not invented.
        </p>
      </header>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardTitle hint={`${selected.size} selected`}>1 · Sources</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[200px] flex-1">
              <Input value={filter} onChange={setFilter} placeholder="Filter by title or source, e.g. guideline" />
            </div>
            <Button
              onClick={() =>
                setSelected(new Set(visible.slice(0, 25).map((doc) => doc.id)))
              }
              disabled={visible.length === 0}
            >
              Select first 25
            </Button>
            <Button onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              Clear
            </Button>
          </div>

          <div className="mt-3 max-h-80 space-y-1 overflow-auto rounded-xl border border-line bg-raised/40 p-2">
            {loading ? (
              <Spinner label="Loading documents…" />
            ) : visible.length === 0 ? (
              <p className="p-2 text-xs text-muted">No documents match this filter.</p>
            ) : (
              visible.map((doc) => (
                <label
                  key={doc.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-raised"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(doc.id)}
                    onChange={() => toggle(doc.id)}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="line-clamp-1 text-sm">{doc.title}</span>
                    <span className="text-[11px] text-muted">
                      {doc.sourceId} · {doc.chunkCount} chunks
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Tip: select 3–10 focused sources. More sources widen the deck but blur the lesson.
          </p>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle>2 · Output</CardTitle>
            <div className="grid gap-2">
              {KINDS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setKind(option.id)}
                  className={`rounded-xl border p-3 text-left transition ${
                    kind === option.id ? "border-accent bg-accent/10" : "border-line hover:border-accent/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{option.name}</span>
                    {kind === option.id ? <Badge tone="accent">selected</Badge> : null}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{option.detail}</p>
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-[11px] text-muted">
                Language
                <select
                  value={lang}
                  onChange={(event) => setLang(event.target.value === "vi" ? "vi" : "en")}
                  className="mt-1 block rounded-xl border border-line bg-raised px-2 py-1.5 text-sm text-ink"
                >
                  <option value="en">English</option>
                  <option value="vi">Tiếng Việt</option>
                </select>
              </label>
              {kind === "slides" ? (
                <label className="text-[11px] text-muted">
                  Max slides
                  <select
                    value={maxSlides}
                    onChange={(event) => setMaxSlides(event.target.value)}
                    className="mt-1 block rounded-xl border border-line bg-raised px-2 py-1.5 text-sm text-ink"
                  >
                    {[6, 8, 10, 12, 15].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Button variant="primary" onClick={() => void generate()} disabled={busy || selected.size === 0}>
                {busy ? "Generating…" : `Generate ${kind}`}
              </Button>
            </div>
            {selected.size === 0 ? (
              <p className="mt-2 text-[11px] text-muted">Select at least one source to enable generation.</p>
            ) : null}
          </Card>

          <Card>
            <CardTitle hint={`${artifacts.length}`}>Recent</CardTitle>
            {artifacts.length === 0 ? (
              <p className="text-xs text-muted">Nothing generated yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <Link
                      href={`/studio/${artifact.id}`}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-raised"
                    >
                      <span className="min-w-0">
                        <span className="line-clamp-1">{artifact.title}</span>
                        <span className="text-[11px] text-muted">
                          {artifact.kind} · {artifact.documentIds.length} sources ·{" "}
                          {artifact.createdAt.slice(0, 16).replace("T", " ")}
                        </span>
                      </span>
                      <Badge tone={artifact.usedLlm ? "good" : "neutral"}>{artifact.usedLlm ? "model" : "no model"}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {!loading && documents.length === 0 ? (
        <EmptyState
          title="No sources yet"
          hint="Import files or sync a folder first; Studio builds from what is already in the library."
          action={
            <Link href="/import" className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60">
              Import
            </Link>
          }
        />
      ) : null}
    </div>
  );
}
