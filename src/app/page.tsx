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
    void load().catch(() => setMessage("Không tải được trạng thái."));
  }, [load]);

  async function submitCapture() {
    if (capture.trim().length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/v1/ingest/text", {
        method: "POST",
        body: JSON.stringify({ text: capture, sourceKind: mode, title: capture.split("\n")[0]?.slice(0, 80) }),
      });
      setCapture("");
      setMessage("Đã lưu vào bộ nhớ.");
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
          <h1 className="text-xl font-semibold tracking-tight">Tổng quan</h1>
          <p className="text-sm text-muted">Bộ nhớ cá nhân của bạn, chạy hoàn toàn trên máy này.</p>
        </div>
        {health ? (
          <div className="flex flex-wrap gap-2">
            <Badge tone={health.fts5 ? "good" : "warn"}>FTS5 {health.fts5 ? "bật" : "tắt"}</Badge>
            <Badge tone={health.trigram ? "good" : "neutral"}>trigram {health.trigram ? "bật" : "tắt"}</Badge>
            <Badge tone={health.worker.running ? "good" : "warn"}>
              worker {health.worker.running ? "đang chạy" : "tạm dừng"}
            </Badge>
            <Badge>SQLite {health.sqlite}</Badge>
          </div>
        ) : null}
      </header>

      <Card>
        <CardTitle hint="Ctrl/⌘ + Enter để lưu">Ghi nhanh</CardTitle>
        <Tabs
          tabs={[
            { id: "note", label: "Ghi chú" },
            { id: "paste", label: "Văn bản thô" },
          ]}
          active={mode}
          onChange={setMode}
        />
        <div className="mt-3">
          <Textarea
            value={capture}
            onChange={setCapture}
            rows={4}
            placeholder="Viết một ghi chú, dán nội dung hoặc liên kết cần lưu…"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={() => void submitCapture()} disabled={busy}>
            {busy ? "Đang lưu…" : "Lưu vào bộ nhớ"}
          </Button>
          <Link href="/import" className="text-xs text-muted hover:text-ink">
            hoặc nhập từ tệp / thư mục / bản export
          </Link>
        </div>
        {message ? (
          <div className="mt-3">
            <Notice tone={message.includes("Đã lưu") ? "good" : "warn"}>{message}</Notice>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Tài liệu" value={stats?.documents ?? "—"} hint={stats?.lastIngestAt ? `mới nhất ${stats.lastIngestAt.slice(0, 16).replace("T", " ")}` : "chưa có dữ liệu"} />
        <Stat label="Ghi chú" value={stats?.notes ?? "—"} />
        <Stat label="Đoạn chỉ mục" value={stats?.chunks ?? "—"} hint={stats ? `DB ${bytes(stats.databaseBytes)}` : undefined} />
        <Stat
          label="Embedding"
          value={stats ? `${Math.round(stats.embeddingCoverage * 100)}%` : "—"}
          hint={stats?.aiConfigured ? `${stats.embeddings} vector` : "chưa cấu hình model"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle hint={<Link href="/library" className="hover:text-ink">Xem tất cả</Link>}>Vừa thêm gần đây</CardTitle>
          {recent.length === 0 ? (
            <EmptyState title="Chưa có tài liệu" hint="Dùng ô ghi nhanh ở trên, hoặc đồng bộ một thư mục ở mục Nhập dữ liệu." />
          ) : (
            <ul className="space-y-2">
              {recent.map((doc) => (
                <li key={doc.id} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2 last:border-0">
                  <div className="min-w-0">
                    <Link href={`/library/${doc.id}`} className="line-clamp-1 text-sm hover:underline">
                      {doc.title}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {doc.sourceId} · {doc.chunkCount} đoạn · {(doc.createdAt ?? doc.ingestedAt).slice(0, 10)}
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
            <CardTitle hint={stats ? `${stats.bySource.length} nguồn` : undefined}>Kho tri thức</CardTitle>
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
              <p className="text-xs text-muted">Chưa có nguồn nào. Kết nối Gmail/Slack/Notion hoặc đồng bộ thư mục ghi chú.</p>
            )}
          </Card>

          <Card>
            <CardTitle hint={<Link href="/plays" className="hover:text-ink">Tự động hoá</Link>}>Tác vụ nền</CardTitle>
            {jobs.length === 0 ? (
              <p className="text-xs text-muted">Không có tác vụ nào gần đây.</p>
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
          Chưa cấu hình model AI: tìm kiếm và hỏi đáp vẫn chạy ở chế độ từ khoá + trích dẫn trực tiếp. Thêm base URL/API key
          (hoặc trỏ tới Ollama) trong <Link href="/settings" className="underline">Cài đặt</Link> để bật câu trả lời tổng hợp.
        </Notice>
      ) : null}
    </div>
  );
}
