"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Input, Notice, api } from "@/components/ui";

type NoteTag = { id: string; name: string; slug: string; count?: number };

type NoteListItem = {
  document: { id: string; title: string; updatedAt: string | null; ingestedAt: string; pinned: boolean };
  excerpt: string;
  tags: NoteTag[];
};

export default function NotesPage() {
  const router = useRouter();
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [tags, setTags] = useState<NoteTag[]>([]);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "100" });
    if (query.trim().length > 0) params.set("q", query.trim());
    if (activeTag) params.set("tag", activeTag);
    const [noteResult, tagResult] = await Promise.all([
      api<{ items: NoteListItem[]; total: number }>(`/api/v1/notes?${params.toString()}`),
      api<{ tags: NoteTag[] }>("/api/v1/tags"),
    ]);
    setNotes(noteResult.items);
    setTags(tagResult.tags);
  }, [query, activeTag]);

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [load]);

  async function createNote() {
    try {
      const result = await api<{ note: { document: { id: string } } }>("/api/v1/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Ghi chú mới", markdown: "" }),
      });
      router.push(`/notes/${result.note.document.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Ghi chú</h1>
          <p className="text-sm text-muted">
            Markdown thuần, được đánh chỉ mục ngay khi lưu. Dùng <code className="rounded bg-raised px-1">[[Tên ghi chú]]</code> để
            liên kết và <code className="rounded bg-raised px-1">#thẻ</code> để phân loại.
          </p>
        </div>
        <Button variant="primary" onClick={() => void createNote()}>
          + Ghi chú mới
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Input value={query} onChange={setQuery} placeholder="Tìm trong ghi chú…" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] ${activeTag === null ? "border-accent text-accent" : "border-line text-muted hover:text-ink"}`}
          >
            tất cả
          </button>
          {tags.slice(0, 18).map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={() => setActiveTag(tag.slug === activeTag ? null : tag.slug)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${activeTag === tag.slug ? "border-accent text-accent" : "border-line text-muted hover:text-ink"}`}
            >
              #{tag.name} {tag.count ? <span className="text-muted">{tag.count}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {message ? <Notice tone="warn">{message}</Notice> : null}

      {notes.length === 0 ? (
        <EmptyState
          title="Chưa có ghi chú nào"
          hint="Tạo ghi chú đầu tiên, hoặc đồng bộ một vault Obsidian ở mục Nhập dữ liệu."
          action={<Button onClick={() => void createNote()}>Tạo ghi chú</Button>}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {notes.map((item) => (
            <Link key={item.document.id} href={`/notes/${item.document.id}`} className="block">
              <Card className="h-full transition hover:border-accent/60">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="line-clamp-1 text-sm font-medium">{item.document.title}</h2>
                  {item.document.pinned ? <Badge tone="accent">ghim</Badge> : null}
                </div>
                <p className="mt-2 line-clamp-3 text-xs text-muted">{item.excerpt || "(chưa có nội dung)"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {item.tags.slice(0, 4).map((tag) => (
                    <Badge key={tag.id}>#{tag.name}</Badge>
                  ))}
                  <span className="ml-auto text-[11px] text-muted">
                    {(item.document.updatedAt ?? item.document.ingestedAt).slice(0, 10)}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card>
        <CardTitle>Thẻ đang dùng</CardTitle>
        {tags.length === 0 ? (
          <p className="text-xs text-muted">Chưa có thẻ nào — thêm #thẻ vào ghi chú để tạo.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag.id}>
                #{tag.name} · {tag.count ?? 0}
              </Badge>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
