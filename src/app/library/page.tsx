"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Input, Notice, Spinner, api } from "@/components/ui";

type DocumentRow = {
  id: string;
  title: string;
  sourceId: string;
  sourceKind: string;
  url: string | null;
  path: string | null;
  author: string | null;
  createdAt: string | null;
  ingestedAt: string;
  chunkCount: number;
  tokenCount: number;
  pinned: boolean;
};

const SOURCE_FILTERS = [
  { id: "", label: "Tất cả" },
  { id: "note", label: "Ghi chú" },
  { id: "connector", label: "Kết nối" },
  { id: "folder", label: "Thư mục" },
  { id: "upload", label: "Tệp tải lên" },
  { id: "url", label: "Trang web" },
  { id: "importer", label: "Bản export" },
  { id: "paste", label: "Văn bản dán" },
];

export default function LibraryPage() {
  const [items, setItems] = useState<DocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [source, setSource] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "40", offset: String(offset), order: "ingested" });
      if (source) params.set("source", source);
      if (sourceId.trim()) params.set("sourceId", sourceId.trim());
      const result = await api<{ items: DocumentRow[]; total: number }>(`/api/v1/documents?${params.toString()}`);
      setItems(result.items);
      setTotal(result.total);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [offset, source, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Thư viện</h1>
        <p className="text-sm text-muted">
          Mọi thứ đã được nạp vào bộ nhớ: ghi chú, email, sự kiện lịch, tệp, trang web, bản export.
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {SOURCE_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => {
                setSource(filter.id);
                setOffset(0);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                source === filter.id ? "border-accent text-accent" : "border-line text-muted hover:text-ink"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="w-56">
            <Input
              value={sourceId}
              onChange={(value) => {
                setSourceId(value);
                setOffset(0);
              }}
              placeholder="Lọc theo nguồn, ví dụ gmail"
            />
          </div>
          <Button onClick={() => void load()}>Làm mới</Button>
          <span className="text-xs text-muted">
            {loading ? "Đang tải…" : `${total} tài liệu khớp bộ lọc`}
          </span>
        </div>
      </Card>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {loading && items.length === 0 ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="Chưa có tài liệu nào"
          hint="Nạp tệp, đồng bộ thư mục ghi chú hoặc kết nối một dịch vụ để bắt đầu."
          action={
            <Link href="/import" className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60">
              Nhập dữ liệu
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((doc) => (
            <li key={doc.id}>
              <Card className="transition hover:border-accent/50">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/library/${doc.id}`} className="line-clamp-1 text-sm font-medium hover:underline">
                        {doc.title}
                      </Link>
                      {doc.pinned ? <Badge tone="accent">ghim</Badge> : null}
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-muted">
                      {doc.sourceId}
                      {doc.author ? ` · ${doc.author}` : ""}
                      {doc.path ? ` · ${doc.path}` : ""}
                      {doc.url ? ` · ${doc.url}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                    <Badge>{doc.sourceKind}</Badge>
                    <span>{doc.chunkCount} đoạn</span>
                    <span>{doc.tokenCount} token</span>
                    <span>{(doc.createdAt ?? doc.ingestedAt).slice(0, 10)}</span>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between">
        <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 40))}>
          ← Trang trước
        </Button>
        <span className="text-xs text-muted">
          {offset + 1}–{offset + items.length}
        </span>
        <Button disabled={offset + items.length >= total} onClick={() => setOffset(offset + 40)}>
          Trang sau →
        </Button>
      </div>

      <Card>
        <CardTitle>Tìm kiếm nâng cao</CardTitle>
        <p className="text-xs text-muted">
          Trang <Link href="/search" className="underline">Tìm kiếm</Link> hỗ trợ chế độ lai (từ khoá + ngữ nghĩa), lọc theo ngày,
          thẻ và xem chi tiết điểm số từng nguồn.{query ? ` Từ khoá hiện tại: ${query}` : ""}
        </p>
      </Card>
    </div>
  );
}
