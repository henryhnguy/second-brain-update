"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, KeyValue, Notice, Spinner, api } from "@/components/ui";
import { Markdown } from "@/components/markdown";

type Chunk = {
  id: string;
  ord: number;
  text: string;
  headingPath: string | null;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
};

type DocumentDetail = {
  document: {
    id: string;
    title: string;
    sourceId: string;
    sourceKind: string;
    url: string | null;
    path: string | null;
    author: string | null;
    mime: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    ingestedAt: string;
    charCount: number;
    tokenCount: number;
    chunkCount: number;
    contentHash: string;
    meta: Record<string, unknown>;
    pinned: boolean;
  };
  chunks: Chunk[];
};

type DistillTemplate = { id: string; name: string; description: string };

type DistillResult = {
  markdown: string;
  template: string;
  noteId: string | null;
  noteTitle: string | null;
  usedLlm: boolean;
};

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<DistillTemplate[]>([]);
  const [template, setTemplate] = useState("generic");
  const [lang, setLang] = useState<"en" | "vi">("en");
  const [distilled, setDistilled] = useState<DistillResult | null>(null);
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api<DocumentDetail>(`/api/v1/documents/${id}`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ templates: DistillTemplate[] }>("/api/v1/curator/templates")
      .then((result) => setTemplates(result.templates))
      .catch(() => setTemplates([]));
  }, []);

  async function distill() {
    setDistilling(true);
    setDistillError(null);
    try {
      const result = await api<DistillResult>("/api/v1/curator/distill", {
        method: "POST",
        body: JSON.stringify({ documentId: id, template, lang }),
      });
      setDistilled(result);
      await load();
    } catch (caught) {
      setDistillError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDistilling(false);
    }
  }

  async function remove(hard: boolean) {
    if (!confirm(hard ? "Delete this document permanently (cannot be undone)?" : "Move this document to deleted?")) return;
    await api(`/api/v1/documents/${id}${hard ? "?hard=1" : ""}`, { method: "DELETE" });
    router.push("/library");
  }

  async function togglePin() {
    if (!detail) return;
    await api(`/api/v1/documents/${id}`, { method: "PATCH", body: JSON.stringify({ pinned: !detail.document.pinned }) });
    await load();
  }

  if (error) return <Notice tone="warn">{error}</Notice>;
  if (!detail) return <Spinner label="Opening document…" />;

  const doc = detail.document;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/library" className="text-xs text-muted hover:text-ink">
          ← Library
        </Link>
        <div className="flex gap-2">
          <Button onClick={() => void togglePin()}>{doc.pinned ? "Unpin" : "Pin"}</Button>
          {doc.sourceKind === "note" ? (
            <Link
              href={`/notes/${doc.id}`}
              className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60"
            >
              Open in Notes
            </Link>
          ) : null}
          {doc.url ? (
            <a
              href={doc.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60"
            >
              Open source ↗
            </a>
          ) : null}
          <Button variant="danger" onClick={() => void remove(false)}>
            Delete
          </Button>
        </div>
      </header>

      <Card>
        <h1 className="text-lg font-semibold tracking-tight">{doc.title}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone="accent">{doc.sourceId}</Badge>
          <Badge>{doc.sourceKind}</Badge>
          {doc.mime ? <Badge>{doc.mime}</Badge> : null}
        </div>
        <div className="mt-4">
          <KeyValue
            items={[
              { label: "Author", value: doc.author ?? "—" },
              { label: "Path", value: doc.path ?? "—" },
              { label: "URL", value: doc.url ?? "—" },
              { label: "Created", value: (doc.createdAt ?? doc.ingestedAt).slice(0, 19).replace("T", " ") },
              { label: "Updated", value: (doc.updatedAt ?? doc.ingestedAt).slice(0, 19).replace("T", " ") },
              { label: "Size", value: `${doc.charCount} characters · ${doc.tokenCount} tokens · ${doc.chunkCount} chunks` },
              { label: "Content hash", value: <span className="font-mono text-xs">{doc.contentHash.slice(0, 24)}…</span> },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardTitle hint="a short, linked note — the distillation layer">Distill to a one-pager</CardTitle>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-muted">
            Template
            <select
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              className="mt-1 block rounded-xl border border-line bg-raised px-2 py-1.5 text-sm text-ink"
            >
              {(templates.length > 0 ? templates : [{ id: "generic", name: "Generic one-pager", description: "" }]).map(
                (entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ),
              )}
            </select>
          </label>
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
          <Button variant="primary" onClick={() => void distill()} disabled={distilling}>
            {distilling ? "Distilling…" : "Distill"}
          </Button>
          {distilled?.noteId ? (
            <Link href={`/notes/${distilled.noteId}`} className="text-xs text-accent hover:underline">
              Open the saved note →
            </Link>
          ) : null}
          {distilled ? <Badge>{distilled.usedLlm ? "model" : "no model"}</Badge> : null}
        </div>
        {distillError ? (
          <div className="mt-3">
            <Notice tone="warn">{distillError}</Notice>
          </div>
        ) : null}
        {distilled ? (
          <div className="mt-3 max-h-96 overflow-auto rounded-xl border border-line bg-raised/60 p-3">
            <Markdown>{distilled.markdown}</Markdown>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">
            Writes a one-page note and links it back to this document; running it again updates the same note.
          </p>
        )}
      </Card>

      <Card>
        <CardTitle hint={`${detail.chunks.length} indexed chunks`}>Indexed content</CardTitle>
        {detail.chunks.length === 0 ? (
          <p className="text-xs text-muted">This document has no chunks (the text extract may be empty).</p>
        ) : (
          <ol className="space-y-3">
            {detail.chunks.map((chunk) => (
              <li key={chunk.id} className="rounded-xl border border-line bg-raised/60 p-3">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                  <span>#{chunk.ord + 1}</span>
                  {chunk.headingPath ? <span className="truncate">› {chunk.headingPath}</span> : null}
                  <span className="ml-auto">
                    characters {chunk.charStart}–{chunk.charEnd} · ~{chunk.tokenEstimate} tokens
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{chunk.text}</p>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card>
        <CardTitle>Raw metadata</CardTitle>
        <pre className="max-h-64 overflow-auto rounded-xl border border-line bg-raised p-3 text-[11px]">
          {JSON.stringify(doc.meta, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
