"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, Input, KeyValue, Notice, Spinner, Tabs, Textarea, api } from "@/components/ui";

import { AI_PRESETS, presetForBaseUrl, type AiPresetId } from "@/lib/ai/presets";

import type { FreeModel } from "@/lib/ai/openrouter";

type AiConfig = {
  mode: "auto" | "openai_compatible" | "off";
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  embedDim: number;
  temperature: number;
  contextChunks: number;
  systemExtra: string;
  timeoutMs: number;
  maxOutputTokens: number;
  configured: boolean;
  source: string;
  isLocalEndpoint: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

type Diagnostics = {
  capabilities: { fts5: boolean; trigram: boolean; sqliteVersion: string; journalMode: string };
  data: { data: string; database: string; uploads: string; backups: string; state: string };
  worker: { running: boolean; intervalMs: number; lastRunAt: string | null; queue: Record<string, number> };
  embeddings: { model: string; embedded: number; total: number; ready: boolean; configured: boolean };
  logs: { at: string; level: string; scope: string; message: string }[];
};

type TokenRecord = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

type Stats = { documents: number; chunks: number; embeddings: number; databaseBytes: number; embeddingCoverage: number };

export default function SettingsPage() {
  const [tab, setTab] = useState<"ai" | "data" | "tokens" | "diagnostics">("ai");
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, diag, tokenList, statsResult] = await Promise.all([
        api<{ ai: AiConfig }>("/api/v1/settings"),
        api<Diagnostics>("/api/v1/diagnostics"),
        api<{ tokens: TokenRecord[] }>("/api/v1/tokens"),
        api<Stats>("/api/v1/stats"),
      ]);
      setAi(settings.ai);
      setDiagnostics(diag);
      setTokens(tokenList.tokens);
      setStats(statsResult);
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

  /** The preset the current base URL belongs to, so the selector shows where you are. */
  const activePreset = ai ? AI_PRESETS.find((preset) => preset.id === presetForBaseUrl(ai.baseUrl)) ?? null : null;

  /** Free OpenRouter models, loaded on demand from the provider catalogue. */
  const [freeModels, setFreeModels] = useState<FreeModel[] | null>(null);

  const loadFreeModels = useCallback(async () => {
    try {
      const result = await api<{ models: FreeModel[] }>("/api/v1/ai/openrouter/models");
      setFreeModels(result.models);
    } catch {
      setFreeModels([]);
    }
  }, []);

  // Loaded the first time the OpenRouter preset is active; the list is cached
  // server-side, so refreshing is cheap but not automatic.
  useEffect(() => {
    if (activePreset?.id !== "openrouter" || freeModels !== null) return;
    void loadFreeModels();
  }, [activePreset?.id, freeModels, loadFreeModels]);


  /** Presets pre-fill the endpoint, plus a model id where the provider documents one. */
  function applyPreset(id: AiPresetId) {
    const preset = AI_PRESETS.find((entry) => entry.id === id);
    if (!preset || !ai) return;
    setAi({
      ...ai,
      ...(preset.baseUrl.length > 0 ? { baseUrl: preset.baseUrl } : {}),
      ...(preset.chatModel ? { chatModel: preset.chatModel } : {}),
      ...(preset.embedModel ? { embedModel: preset.embedModel } : {}),
    });
  }

  async function saveAi(patch: Partial<AiConfig> & { apiKey?: string }) {
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/v1/settings", { method: "PATCH", body: JSON.stringify({ ai: patch }) });
      setMessage("Đã lưu cấu hình AI.");
      setApiKeyInput("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ ok: boolean; model?: string; error?: string; latencyMs: number }>("/api/v1/settings/ai/check", {
        method: "POST",
      });
      setMessage(result.ok ? `Kết nối OK · model ${result.model} · ${result.latencyMs}ms` : `Không kết nối được: ${result.error}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function backfill() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ embedded: number; remaining: number; model: string }>("/api/v1/settings/embeddings/backfill", {
        method: "POST",
        body: JSON.stringify({ limit: 400 }),
      });
      setMessage(`Đã tạo ${result.embedded} embedding (model ${result.model}), còn lại ${result.remaining} đoạn.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createToken() {
    if (tokenName.trim().length === 0) return;
    setBusy(true);
    try {
      const result = await api<{ token: string }>("/api/v1/tokens", {
        method: "POST",
        body: JSON.stringify({ name: tokenName.trim() }),
      });
      setNewToken(result.token);
      setTokenName("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api(`/api/v1/tokens/${id}`, { method: "DELETE" });
    await load();
  }

  if (loading && !ai) return <Spinner label="Đang tải cấu hình…" />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Cài đặt</h1>
        <p className="text-sm text-muted">Provider AI, dữ liệu, token API và chẩn đoán. Mọi thay đổi áp dụng ngay, không cần khởi động lại.</p>
      </header>

      {message ? <Notice tone="good">{message}</Notice> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}

      <Tabs
        tabs={[
          { id: "ai", label: "AI" },
          { id: "data", label: "Dữ liệu" },
          { id: "tokens", label: "Token API" },
          { id: "diagnostics", label: "Chẩn đoán" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "ai" && ai ? (
        <>
          <Card>
            <CardTitle hint={ai.configured ? "đã cấu hình" : "chưa cấu hình"}>Nhà cung cấp AI</CardTitle>
            <p className="text-xs text-muted">
              Cùng một giao thức OpenAI-compatible: OpenAI, OpenRouter, Groq, Azure-style gateway, LM Studio hoặc Ollama tại{" "}
              <code className="rounded bg-raised px-1">http://localhost:11434/v1</code> (không cần API key).
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted sm:col-span-2">
                Provider
                <select
                  value={presetForBaseUrl(ai.baseUrl)}
                  onChange={(event) => applyPreset(event.target.value as AiPresetId)}
                  className="mt-1 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm"
                >
                  {AI_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                {activePreset ? (
                  <span className="mt-1 block text-[11px] text-muted">
                    {activePreset.note}
                    {activePreset.modelsUrl ? (
                      <>
                        {" "}
                        <a href={activePreset.modelsUrl} target="_blank" rel="noreferrer" className="underline">
                          Model list
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </label>
              <label className="text-xs text-muted">
                Chế độ
                <select
                  value={ai.mode}
                  onChange={(event) => void saveAi({ mode: event.target.value as AiConfig["mode"] })}
                  className="mt-1 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm"
                >
                  <option value="auto">Tự động (theo cấu hình bên dưới)</option>
                  <option value="openai_compatible">Bật (OpenAI-compatible)</option>
                  <option value="off">Tắt hoàn toàn (chỉ tìm kiếm từ khoá)</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Base URL
                <div className="mt-1">
                  <Input value={ai.baseUrl} onChange={(value) => setAi({ ...ai, baseUrl: value })} />
                </div>
              </label>
              <label className="text-xs text-muted">
                API key {ai.hasApiKey ? <span className="text-muted">(đang lưu {ai.apiKeyMasked})</span> : null}
                <div className="mt-1">
                  <Input value={apiKeyInput} onChange={setApiKeyInput} placeholder="để trống nếu không đổi" type="password" />
                </div>
              </label>
              <label className="text-xs text-muted">
                Model hội thoại
                <div className="mt-1">
                  <Input value={ai.chatModel} onChange={(value) => setAi({ ...ai, chatModel: value })} />
                </div>
              </label>
              {activePreset?.id === "openrouter" ? (
                <label className="text-xs text-muted sm:col-span-2">
                  Free models on OpenRouter
                  <select
                    value={freeModels?.some((model) => model.id === ai.chatModel) ? ai.chatModel : ""}
                    onChange={(event) => {
                      const picked = event.target.value;
                      if (picked.length > 0) setAi({ ...ai, chatModel: picked });
                    }}
                    className="mt-1 w-full rounded-xl border border-line bg-raised px-3 py-2 text-sm"
                  >
                    <option value="">Keep the model typed above</option>
                    {(freeModels ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[11px] text-muted">
                    {freeModels === null ? "Loading the catalogue…" : `${freeModels.length} models that cost nothing`}{" "}
                    <button type="button" className="underline" onClick={() => void loadFreeModels()}>
                      Refresh
                    </button>
                  </span>
                </label>
              ) : null}
              <label className="text-xs text-muted">
                Model embedding
                <div className="mt-1">
                  <Input value={ai.embedModel} onChange={(value) => setAi({ ...ai, embedModel: value })} />
                </div>
              </label>
              <label className="text-xs text-muted">
                Số đoạn ngữ cảnh cho mỗi câu hỏi
                <div className="mt-1">
                  <Input
                    value={String(ai.contextChunks)}
                    onChange={(value) => setAi({ ...ai, contextChunks: Number(value) || ai.contextChunks })}
                  />
                </div>
              </label>
            </div>
            <label className="mt-3 block text-xs text-muted">
              Ghi chú thêm cho system prompt (tuỳ chọn)
              <div className="mt-1">
                <Textarea value={ai.systemExtra} onChange={(value) => setAi({ ...ai, systemExtra: value })} rows={2} />
              </div>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void saveAi({
                    mode: ai.mode,
                    baseUrl: ai.baseUrl,
                    chatModel: ai.chatModel,
                    embedModel: ai.embedModel,
                    contextChunks: ai.contextChunks,
                    systemExtra: ai.systemExtra,
                    ...(apiKeyInput.trim().length > 0 ? { apiKey: apiKeyInput } : {}),
                  })
                }
              >
                Lưu cấu hình
              </Button>
              <Button onClick={() => void testConnection()} disabled={busy}>
                Kiểm tra kết nối
              </Button>
              <Button variant="ghost" onClick={() => void saveAi({ apiKey: "" })} disabled={busy}>
                Xoá API key đã lưu
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Nguồn cấu hình hiện tại: <strong>{ai.source === "settings" ? "lưu trong app" : ai.source === "env" ? "biến môi trường" : "mặc định"}</strong>
              {ai.isLocalEndpoint ? " · endpoint nội bộ, không cần key" : ""}
            </p>
          </Card>

          <Card>
            <CardTitle hint={diagnostics ? `${diagnostics.embeddings.embedded}/${diagnostics.embeddings.total} đoạn` : undefined}>
              Embedding (tìm kiếm ngữ nghĩa)
            </CardTitle>
            <p className="text-xs text-muted">
              Chỉ chạy khi bạn bấm — không có gì được gửi đi tự động. Sau khi tạo embedding, tìm kiếm lai sẽ dùng thêm vector và
              chế độ “Ngữ nghĩa” mới có kết quả.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void backfill()} disabled={busy || !ai.configured}>
                Tạo embedding còn thiếu
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void api("/api/v1/settings/embeddings/clear", { method: "POST", body: JSON.stringify({}) }).then(() => load())
                }
              >
                Xoá toàn bộ embedding
              </Button>
              {!ai.configured ? <span className="text-[11px] text-muted">Cần cấu hình model trước.</span> : null}
            </div>
          </Card>
        </>
      ) : null}

      {tab === "data" && diagnostics ? (
        <>
          <Card>
            <CardTitle>Vị trí dữ liệu</CardTitle>
            <KeyValue
              items={[
                { label: "Thư mục dữ liệu", value: <span className="font-mono text-xs">{diagnostics.data.data}</span> },
                { label: "Cơ sở dữ liệu", value: <span className="font-mono text-xs">{diagnostics.data.database}</span> },
                { label: "Tệp tải lên", value: <span className="font-mono text-xs">{diagnostics.data.uploads}</span> },
                { label: "Sao lưu", value: <span className="font-mono text-xs">{diagnostics.data.backups}</span> },
                { label: "Dung lượng DB", value: stats ? `${(stats.databaseBytes / 1024 / 1024).toFixed(2)} MB` : "—" },
                { label: "Tài liệu / đoạn", value: stats ? `${stats.documents} / ${stats.chunks}` : "—" },
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href="/api/v1/export?limit=500"
                className="rounded-xl border border-line bg-raised px-3 py-1.5 text-sm hover:border-accent/60"
                target="_blank"
                rel="noreferrer"
              >
                Xuất JSON (500 tài liệu)
              </a>
              <Button onClick={() => void api("/api/v1/maintenance/vacuum", { method: "POST", body: JSON.stringify({}) })}>
                Nén cơ sở dữ liệu (VACUUM)
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Sao lưu = copy cả thư mục dữ liệu (bao gồm tệp .secret dùng để giải mã credential). Đừng chia sẻ thư mục này.
            </p>
          </Card>

          <Card>
            <CardTitle>Tác vụ nền</CardTitle>
            {diagnostics.worker.running ? (
              <p className="text-xs text-muted">
                Worker đang chạy, chu kỳ {Math.round(diagnostics.worker.intervalMs / 1000)}s
                {diagnostics.worker.lastRunAt ? ` · lần cuối ${diagnostics.worker.lastRunAt.slice(0, 19).replace("T", " ")}` : ""}.
              </p>
            ) : (
              <Notice tone="warn">
                Worker chưa chạy (thường gặp khi app vừa khởi động). Hàng đợi: {JSON.stringify(diagnostics.worker.queue)}
              </Notice>
            )}
          </Card>
        </>
      ) : null}

      {tab === "tokens" ? (
        <Card>
          <CardTitle hint={`${tokens.filter((token) => !token.revokedAt).length} đang hiệu lực`}>Token API</CardTitle>
          <p className="text-xs text-muted">
            Request từ máy cục bộ (localhost) không cần token. Token dùng cho CLI, script hoặc truy cập từ máy khác; có thể gửi qua
            header <code className="rounded bg-raised px-1">Authorization: Bearer &lt;token&gt;</code>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="w-64">
              <Input value={tokenName} onChange={setTokenName} placeholder="Tên token, ví dụ: laptop-cli" />
            </div>
            <Button variant="primary" onClick={() => void createToken()} disabled={busy}>
              Tạo token
            </Button>
          </div>
          {newToken ? (
            <div className="mt-3">
              <Notice tone="good">
                Token mới (chỉ hiển thị một lần): <code className="break-all">{newToken}</code>
              </Notice>
            </div>
          ) : null}
          <ul className="mt-4 space-y-1.5 text-sm">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {token.name} <span className="font-mono text-[11px] text-muted">{token.prefix}…</span>
                </span>
                <span className="flex items-center gap-2 text-[11px] text-muted">
                  {token.lastUsedAt ? `dùng lúc ${token.lastUsedAt.slice(0, 16).replace("T", " ")}` : "chưa dùng"}
                  {token.revokedAt ? <Badge tone="warn">đã thu hồi</Badge> : <Button onClick={() => void revoke(token.id)}>Thu hồi</Button>}
                </span>
              </li>
            ))}
            {tokens.length === 0 ? <li className="text-xs text-muted">Chưa có token nào.</li> : null}
          </ul>
        </Card>
      ) : null}

      {tab === "diagnostics" && diagnostics ? (
        <>
          <Card>
            <CardTitle>Khả năng của SQLite</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Badge tone={diagnostics.capabilities.fts5 ? "good" : "warn"}>FTS5 {diagnostics.capabilities.fts5 ? "bật" : "tắt"}</Badge>
              <Badge tone={diagnostics.capabilities.trigram ? "good" : "neutral"}>
                trigram {diagnostics.capabilities.trigram ? "bật" : "tắt"}
              </Badge>
              <Badge>SQLite {diagnostics.capabilities.sqliteVersion}</Badge>
              <Badge>journal {diagnostics.capabilities.journalMode}</Badge>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              trigram tắt nghĩa là tìm gần đúng bị hạn chế; FTS5 tắt nghĩa là môi trường Node không hỗ trợ tìm kiếm toàn văn.
            </p>
          </Card>

          <Card>
            <CardTitle hint={`${diagnostics.logs.length} dòng`}>Nhật ký gần đây</CardTitle>
            <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-raised p-3 text-[11px] leading-relaxed">
              {diagnostics.logs
                .slice()
                .reverse()
                .map((log) => `${log.at.slice(11, 19)} ${log.level.toUpperCase().padEnd(5)} ${log.scope} ${log.message}`)
                .join("\n")}
            </pre>
          </Card>
        </>
      ) : null}
    </div>
  );
}
