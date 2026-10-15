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
  { id: "hybrid", label: "Lai" },
  { id: "keyword", label: "Từ khoá" },
  { id: "semantic", label: "Ngữ nghĩa" },
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
        <h1 className="text-xl font-semibold tracking-tight">Tìm kiếm</h1>
        <p className="text-sm text-muted">
          Tìm không dấu vẫn ra kết quả (chỉ mục đã bỏ dấu). Chế độ lai kết hợp BM25, trigram và vector khi đã có embedding.
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="text-xs text-muted">Từ khoá</label>
            <div className="mt-1">
              <Input value={query} onChange={setQuery} placeholder="ví dụ: bao cao quy 3" onEnter={() => void run()} />
            </div>
          </div>
          <div className="w-40">
            <label className="text-xs text-muted">Nguồn</label>
            <div className="mt-1">
              <Input value={source} onChange={setSource} placeholder="gmail, note…" />
            </div>
          </div>
          <div className="w-40">
            <label className="text-xs text-muted">Thẻ</label>
            <div className="mt-1">
              <Input value={tags} onChange={setTags} placeholder="du-an" />
            </div>
          </div>
          <div className="w-40">
            <label className="text-xs text-muted">Từ ngày</label>
            <div className="mt-1">
              <Input value={since} onChange={setSince} type="date" />
            </div>
          </div>
          <Button variant="primary" onClick={() => void run()} disabled={loading}>
            {loading ? "Đang tìm…" : "Tìm"}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Tabs tabs={MODES.map((entry) => ({ id: entry.id, label: entry.label }))} active={mode} onChange={setMode} />
          <span className="text-xs text-muted">
            {mode === "semantic" && result && !result.semanticAvailable
              ? "Chưa có embedding cho model hiện tại — hãy tạo embedding ở Cài đặt."
              : ""}
          </span>
        </div>
      </Card>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {result ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>
              {result.total} tài liệu khớp · {result.tookMs}ms · chế độ {result.mode}
            </span>
            {result.semanticAvailable ? <Badge tone="good">có embedding</Badge> : <Badge tone="warn">chỉ từ khoá</Badge>}
            <Link href={`/chat?q=${encodeURIComponent(result.query)}`} className="underline">
              Hỏi đáp về kết quả này →
            </Link>
          </div>

          {result.hits.length === 0 ? (
            <EmptyState
              title="Không tìm thấy kết quả"
              hint="Thử từ khoá ngắn hơn, bỏ dấu, hoặc nạp thêm dữ liệu ở mục Kết nối / Nhập dữ liệu."
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
                  <CardTitle>Phân bố nguồn</CardTitle>
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
                  <CardTitle>Thẻ liên quan</CardTitle>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(result.facets.tags).slice(0, 20).map(([key, value]) => (
                      <Badge key={key}>
                        #{key} · {value}
                      </Badge>
                    ))}
                  </div>
                </Card>
                <Card>
                  <CardTitle>Cách tính điểm</CardTitle>
                  <p className="text-xs text-muted">
                    Điểm cuối là hợp nhất RRF của ba bộ truy xuất (BM25 1.0 · trigram 0.45 · vector 1.15), cộng nhỏ cho độ mới và
                    ghim. Điểm số chỉ có ý nghĩa so sánh trong cùng một truy vấn.
                  </p>
                </Card>
              </div>
            </div>
          )}
        </>
      ) : loading ? (
        <Spinner />
      ) : (
        <EmptyState title="Nhập từ khoá để tìm" hint="Ví dụ: “cuộc họp tuần trước với khách hàng A” hoặc “spec thanh toán”." />
      )}
    </div>
  );
}
