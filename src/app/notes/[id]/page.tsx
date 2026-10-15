"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/markdown";
import { Badge, Button, Card, CardTitle, Input, Notice, Spinner, Tabs, Textarea, api } from "@/components/ui";

type Note = {
  document: {
    id: string;
    title: string;
    pinned: boolean;
    createdAt: string | null;
    updatedAt: string | null;
    ingestedAt: string;
    chunkCount: number;
  };
  markdown: string;
  tags: { id: string; name: string; slug: string }[];
  links: string[];
  backlinks: { documentId: string; title: string }[];
};

export default function NoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [tags, setTags] = useState("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [status, setStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api<{ note: Note }>(`/api/v1/notes/${id}`);
    setNote(result.note);
    setTitle(result.note.document.title);
    setMarkdown(result.note.markdown);
    setTags(result.note.tags.map((tag) => tag.name).join(", "));
    setDirty(false);
  }, [id]);

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [load]);

  const save = useCallback(
    async (silent = false) => {
      if (!note) return;
      if (!silent) setStatus("Saving…");
      try {
        const tagList = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
        const result = await api<{ note: Note }>(`/api/v1/notes/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title, markdown, tags: tagList }),
        });
        setNote(result.note);
        setDirty(false);
        setStatus("Saved");
        setTimeout(() => setStatus(null), 1500);
      } catch (caught) {
        setStatus(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [id, markdown, note, tags, title],
  );

  // Autosave 2.5s after the last keystroke.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void save(true), 2500);
    return () => clearTimeout(timer);
  }, [dirty, save]);

  async function remove() {
    if (!confirm("Delete this note from memory?")) return;
    try {
      await api(`/api/v1/notes/${id}`, { method: "DELETE" });
      router.push("/notes");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function togglePin() {
    if (!note) return;
    await api(`/api/v1/notes/${id}`, { method: "PATCH", body: JSON.stringify({ pinned: !note.document.pinned }) });
    await load();
  }

  const linksTo = useMemo(() => markdown.match(/\[\[([^\]]+)\]\]/g)?.map((match) => match.slice(2, -2)) ?? [], [markdown]);

  if (error && !note) return <Notice tone="warn">{error}</Notice>;
  if (!note) return <Spinner label="Opening note…" />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/notes" className="text-xs text-muted hover:text-ink">
            ← Notes
          </Link>
          {status ? <span className="text-xs text-muted">{status}</span> : null}
          {dirty ? <span className="text-xs text-muted">• unsaved</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => void togglePin()}>{note.document.pinned ? "Unpin" : "Pin"}</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      </header>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
            placeholder="Note title"
            className="mb-3 w-full border-0 bg-transparent text-lg font-semibold outline-none"
          />
          <div className="mb-3 flex items-center justify-between gap-3">
            <Tabs
              tabs={[
                { id: "write", label: "Write" },
                { id: "preview", label: "Preview" },
              ]}
              active={tab}
              onChange={setTab}
            />
            <span className="text-[11px] text-muted">{markdown.length} characters · {note.document.chunkCount} indexed chunks</span>
          </div>
          {tab === "write" ? (
            <Textarea
              value={markdown}
              onChange={(value) => {
                setMarkdown(value);
                setDirty(true);
              }}
              rows={22}
              className="font-mono"
              placeholder={"# Title\n\nContent… use [[links]] and #tag."}
            />
          ) : (
            <div className="min-h-[24rem] rounded-xl border border-line bg-raised p-4">
              <Markdown>{markdown || "_(empty)_"}</Markdown>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardTitle>Properties</CardTitle>
            <label className="text-xs text-muted">Tags (comma separated)</label>
            <div className="mt-1">
              <Input
                value={tags}
                onChange={(value) => {
                  setTags(value);
                  setDirty(true);
                }}
                placeholder="project, ideas"
              />
            </div>
            <dl className="mt-4 space-y-1 text-xs text-muted">
              <div className="flex justify-between">
                <dt>Created</dt>
                <dd>{(note.document.createdAt ?? note.document.ingestedAt).slice(0, 16).replace("T", " ")}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Updated</dt>
                <dd>{(note.document.updatedAt ?? note.document.ingestedAt).slice(0, 16).replace("T", " ")}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Document ID</dt>
                <dd className="font-mono">{note.document.id}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CardTitle hint={`${linksTo.length} links`}>Links in note</CardTitle>
            {linksTo.length === 0 ? (
              <p className="text-xs text-muted">No links yet. Type [[Another note title]] to create one.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {linksTo.map((link) => (
                  <li key={link}>
                    <Badge tone="accent">{link}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle hint={`${note.backlinks.length}`}>Referenced by</CardTitle>
            {note.backlinks.length === 0 ? (
              <p className="text-xs text-muted">No notes link back here yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {note.backlinks.map((backlink) => (
                  <li key={backlink.documentId}>
                    <Link href={`/notes/${backlink.documentId}`} className="hover:underline">
                      {backlink.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
