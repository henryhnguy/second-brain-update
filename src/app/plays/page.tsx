"use client";

import { useCallback, useEffect, useState } from "react";

import { CitationList, Markdown } from "@/components/markdown";
import { Badge, Button, Card, CardTitle, EmptyState, Input, Notice, Spinner, api } from "@/components/ui";
import type { Citation } from "@/lib/types/domain";

type Play = {
  id: string;
  name: string;
  kind: string;
  description: string;
  enabled: boolean;
  schedule: string | null;
  params: Record<string, unknown>;
  usesLlm: boolean;
  lastRunAt: string | null;
};

type PlayRun = {
  id: string;
  playId: string;
  playName: string;
  startedAt: string;
  status: string;
  output: string;
  citations: Citation[];
  usedLlm: boolean;
  error: string | null;
};

const PARAM_HINTS: Record<string, { key: string; label: string; placeholder: string }[]> = {
  meeting_brief: [{ key: "topic", label: "Chủ đề / người tham dự", placeholder: "ví dụ: họp với khách hàng A" }],
  topic_dossier: [{ key: "topic", label: "Chủ đề", placeholder: "ví dụ: thanh toán" }],
  find_file: [{ key: "query", label: "Từ khoá tài liệu", placeholder: "ví dụ: slide kiến trúc" }],
  weekly_digest: [{ key: "days", label: "Số ngày", placeholder: "7" }],
  daily_brief: [{ key: "days", label: "Số ngày", placeholder: "1" }],
  open_loops: [{ key: "days", label: "Số ngày", placeholder: "30" }],
};

export default function PlaysPage() {
  const [plays, setPlays] = useState<Play[]>([]);
  const [runs, setRuns] = useState<PlayRun[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState<PlayRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [playResult, runResult] = await Promise.all([
        api<{ plays: Play[] }>("/api/v1/plays"),
        api<{ runs: PlayRun[] }>("/api/v1/plays/runs?limit=15"),
      ]);
      setPlays(playResult.plays);
      setRuns(runResult.runs);
      setActive((current) => current ?? runResult.runs[0] ?? null);
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

  async function run(play: Play) {
    setBusy(play.id);
    setError(null);
    try {
      const collected: Record<string, unknown> = {};
      for (const field of PARAM_HINTS[play.kind] ?? []) {
        const raw = params[`${play.id}:${field.key}`];
        if (raw === undefined || raw.trim().length === 0) continue;
        collected[field.key] = field.key === "days" ? Number(raw) : raw;
      }
      const result = await api<{ run: PlayRun; output: string; usedLlm: boolean; citations: Citation[] }>(
        `/api/v1/plays/${play.id}/run`,
        { method: "POST", body: JSON.stringify({ params: collected }) },
      );
      setActive({ ...result.run, output: result.output, citations: result.citations, usedLlm: result.usedLlm });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(play: Play) {
    await api(`/api/v1/plays/${play.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !play.enabled }) });
    await load();
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Tự động hoá</h1>
        <p className="text-sm text-muted">
          Các quy trình dựng sẵn chạy trên chính bộ nhớ của bạn. Không có model thì app xuất bản tổng hợp deterministic; có model
          thì thêm phần nhận định kèm trích dẫn.
        </p>
      </header>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-3">
          {loading ? <Spinner /> : null}
          {plays.map((play) => (
            <Card key={play.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">{play.name}</h2>
                  <p className="mt-1 text-xs text-muted">{play.description}</p>
                </div>
                <Badge tone={play.enabled ? "good" : "neutral"}>{play.enabled ? "bật" : "tắt"}</Badge>
              </div>

              {(PARAM_HINTS[play.kind] ?? []).length > 0 ? (
                <div className="mt-3 space-y-2">
                  {(PARAM_HINTS[play.kind] ?? []).map((field) => (
                    <div key={field.key}>
                      <label className="text-[11px] text-muted">{field.label}</label>
                      <Input
                        value={params[`${play.id}:${field.key}`] ?? ""}
                        onChange={(value) => setParams((current) => ({ ...current, [`${play.id}:${field.key}`]: value }))}
                        placeholder={field.placeholder}
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => void run(play)} disabled={busy === play.id}>
                  {busy === play.id ? "Đang chạy…" : "Chạy ngay"}
                </Button>
                <Button onClick={() => void toggle(play)}>{play.enabled ? "Tạm tắt" : "Bật"}</Button>
                <span className="text-[11px] text-muted">
                  {play.schedule ? `lịch: ${play.schedule}` : "chạy thủ công"}
                  {play.lastRunAt ? ` · lần cuối ${play.lastRunAt.slice(0, 16).replace("T", " ")}` : ""}
                </span>
              </div>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Card>
            <CardTitle hint={active ? active.startedAt.slice(0, 16).replace("T", " ") : undefined}>
              {active ? `Kết quả · ${active.playName}` : "Kết quả"}
            </CardTitle>
            {!active ? (
              <EmptyState title="Chưa có kết quả" hint="Chọn một quy trình bên trái và bấm “Chạy ngay”." />
            ) : (
              <>
                <div className="mb-2 flex flex-wrap gap-2">
                  <Badge tone={active.usedLlm ? "good" : "neutral"}>{active.usedLlm ? "có model" : "không model"}</Badge>
                  <Badge>{active.status}</Badge>
                  {active.citations.length > 0 ? <Badge tone="accent">{active.citations.length} nguồn</Badge> : null}
                </div>
                {active.output ? <Markdown citations={active.citations}>{active.output}</Markdown> : <p className="text-xs text-muted">Không có nội dung.</p>}
                {active.citations.length > 0 ? (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-xs text-muted">Nguồn tham chiếu</summary>
                    <div className="mt-2 rounded-xl border border-line bg-raised/60 p-3">
                      <CitationList citations={active.citations} />
                    </div>
                  </details>
                ) : null}
              </>
            )}
          </Card>

          <Card>
            <CardTitle hint={`${runs.length}`}>Lịch sử chạy</CardTitle>
            {runs.length === 0 ? (
              <p className="text-xs text-muted">Chưa chạy lần nào.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => setActive(run)}
                      className="flex w-full items-center justify-between gap-2 text-left hover:text-ink"
                    >
                      <span className="truncate">{run.playName}</span>
                      <span className="shrink-0 text-[11px] text-muted">{run.startedAt.slice(0, 16).replace("T", " ")}</span>
                      <Badge tone={run.status === "ok" ? "good" : "warn"}>{run.status}</Badge>
                    </button>
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
