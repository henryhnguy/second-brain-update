"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, KeyValue, Notice, Spinner, api } from "@/components/ui";

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

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function remove(hard: boolean) {
    if (!confirm(hard ? "Xoá vĩnh viễn tài liệu này (không thể hoàn tác)?" : "Chuyển tài liệu vào trạng thái đã xoá?")) return;
    await api(`/api/v1/documents/${id}${hard ? "?hard=1" : ""}`, { method: "DELETE" });
    router.push("/library");
  }

  async function togglePin() {
    if (!detail) return;
    await api(`/api/v1/documents/${id}`, { method: "PATCH", body: JSON.stringify({ pinned: !detail.document.pinned }) });
    await load();
  }

  if (error) return <Notice tone="warn">{error}</Notice>;
  if (!detail) return <Spinner label="Đang mở tài liệu…" />;

  const doc = detail.document;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/library" className="text-xs text-muted hover:text-ink">
          ← Thư viện
        </Link>
        <div className="flex gap-2">
          <Button onClick={() => void togglePin()}>{doc.pinned ? "Bỏ ghim" : "Ghim"}</Button>
          {doc.sourceKind === "note" ? (
            <Link
              href={`/notes/${doc.id}`}
              className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60"
            >
              Mở trong Ghi chú
            </Link>
          ) : null}
          {doc.url ? (
            <a
              href={doc.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60"
            >
              Mở nguồn ↗
            </a>
          ) : null}
          <Button variant="danger" onClick={() => void remove(false)}>
            Xoá
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
              { label: "Tác giả", value: doc.author ?? "—" },
              { label: "Đường dẫn", value: doc.path ?? "—" },
              { label: "URL", value: doc.url ?? "—" },
              { label: "Tạo", value: (doc.createdAt ?? doc.ingestedAt).slice(0, 19).replace("T", " ") },
              { label: "Cập nhật", value: (doc.updatedAt ?? doc.ingestedAt).slice(0, 19).replace("T", " ") },
              { label: "Kích thước", value: `${doc.charCount} ký tự · ${doc.tokenCount} token · ${doc.chunkCount} đoạn` },
              { label: "Content hash", value: <span className="font-mono text-xs">{doc.contentHash.slice(0, 24)}…</span> },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardTitle hint={`${detail.chunks.length} đoạn được đánh chỉ mục`}>Nội dung đã lập chỉ mục</CardTitle>
        {detail.chunks.length === 0 ? (
          <p className="text-xs text-muted">Tài liệu này không có đoạn nào (có thể phần trích xuất văn bản rỗng).</p>
        ) : (
          <ol className="space-y-3">
            {detail.chunks.map((chunk) => (
              <li key={chunk.id} className="rounded-xl border border-line bg-raised/60 p-3">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                  <span>#{chunk.ord + 1}</span>
                  {chunk.headingPath ? <span className="truncate">› {chunk.headingPath}</span> : null}
                  <span className="ml-auto">
                    ký tự {chunk.charStart}–{chunk.charEnd} · ~{chunk.tokenEstimate} token
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{chunk.text}</p>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card>
        <CardTitle>Metadata gốc</CardTitle>
        <pre className="max-h-64 overflow-auto rounded-xl border border-line bg-raised p-3 text-[11px]">
          {JSON.stringify(doc.meta, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
