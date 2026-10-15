"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardTitle, EmptyState, Input, Notice, Spinner, api } from "@/components/ui";

type ProviderRow = {
  id: string;
  label: string;
  description: string;
  category: string;
  docsUrl: string | null;
  authKind: "oauth2" | "token";
  scopes: string[];
  oauthConfigured: boolean;
  connectorId: string | null;
  status: string;
  accountLabel: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  itemsSynced: number;
  autoSync: boolean;
};

type SyncRun = {
  id: string;
  startedAt: string;
  status: string;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
};

export default function ConnectorsPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [appCredential, setAppCredential] = useState("");
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, SyncRun[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ providers: ProviderRow[] }>("/api/v1/connectors");
      setProviders(result.providers);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const failure = params.get("error");
    if (connected) setMessage(`Đã kết nối ${connected}. Hãy bấm “Đồng bộ ngay”.`);
    if (failure) setError(`Kết nối thất bại: ${failure}`);
  }, [load]);

  async function saveOAuthApp(providerId: string) {
    if (clientId.trim().length === 0) {
      setError("Cần Client ID của OAuth app.");
      return;
    }
    setBusy(providerId);
    try {
      await api("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({ oauthApps: { [providerId]: { clientId, credential: appCredential } } }),
      });
      setClientId("");
      setAppCredential("");
      setMessage("Đã lưu thông tin OAuth app (credential được mã hoá trước khi lưu).");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function startOAuth(providerId: string) {
    setBusy(providerId);
    try {
      const result = await api<{ authorizeUrl: string }>(`/api/v1/connectors/${providerId}/connect`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      window.open(result.authorizeUrl, "_blank", "noopener");
      setMessage("Đã mở trang cấp quyền trong tab mới. Sau khi đồng ý, quay lại đây để đồng bộ.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function saveToken(providerId: string) {
    const value = tokenInputs[providerId] ?? "";
    if (value.trim().length === 0) {
      setError("Cần dán token trước.");
      return;
    }
    setBusy(providerId);
    try {
      await api(`/api/v1/connectors/${providerId}/token`, {
        method: "POST",
        body: JSON.stringify({ token: value.trim(), label: `${providerId} (token)` }),
      });
      setTokenInputs((current) => ({ ...current, [providerId]: "" }));
      setMessage("Đã lưu token (mã hoá AES-256-GCM tại chỗ).");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function syncNow(provider: ProviderRow) {
    if (!provider.connectorId) return;
    setBusy(provider.id);
    try {
      const outcome = await api<{ added: number; updated: number; items: number; status: string; error: string | null }>(
        `/api/v1/connectors/${provider.connectorId}/sync`,
        { method: "POST", body: JSON.stringify({ maxPages: 3, maxItems: 120 }) },
      );
      setMessage(
        `Đồng bộ ${provider.label}: ${outcome.added} mới, ${outcome.updated} cập nhật (${outcome.items} mục, trạng thái ${outcome.status}).`,
      );
      await loadRuns(provider.connectorId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function loadRuns(connectorId: string) {
    try {
      const result = await api<{ runs: SyncRun[] }>(`/api/v1/connectors/${connectorId}/runs?limit=8`);
      setRuns((current) => ({ ...current, [connectorId]: result.runs }));
    } catch {
      /* keep the previous list */
    }
  }

  async function disconnect(provider: ProviderRow) {
    if (!provider.connectorId || !confirm(`Ngắt kết nối ${provider.label}? Credential đã lưu sẽ bị xoá.`)) return;
    await api(`/api/v1/connectors/${provider.connectorId}`, { method: "DELETE" });
    setMessage(`Đã ngắt kết nối ${provider.label}.`);
    await load();
  }

  async function toggleAutoSync(provider: ProviderRow) {
    if (!provider.connectorId) return;
    await api(`/api/v1/connectors/${provider.connectorId}`, {
      method: "PATCH",
      body: JSON.stringify({ autoSync: !provider.autoSync }),
    });
    await load();
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Kết nối nguồn dữ liệu</h1>
        <p className="text-sm text-muted">
          Email, lịch, chat, tài liệu… được kéo về bộ nhớ cá nhân. Credential lưu tại máy, mã hoá AES-256-GCM, không rời khỏi
          thiết bị này.
        </p>
      </header>

      {message ? <Notice tone="good">{message}</Notice> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}

      <Card>
        <CardTitle hint="docs/connectors.md">Bước 1 · Đăng ký OAuth app</CardTitle>
        <p className="text-xs text-muted">
          Với Google/Microsoft/Slack, bạn cần tạo OAuth app trong trang dành cho nhà phát triển rồi dán Client ID và client
          credential vào đây. Redirect URI cần khai báo: <code className="rounded bg-raised px-1">http://localhost:4173/api/v1/connectors/&lt;provider&gt;/callback</code>
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input value={clientId} onChange={setClientId} placeholder="Client ID" />
          <Input value={appCredential} onChange={setAppCredential} placeholder="Client credential (client secret)" type="password" />
          <Button onClick={() => void saveOAuthApp(providers[0]?.id ?? "google_calendar")}>Lưu cho provider đầu tiên</Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Mẹo: gửi kèm <code className="rounded bg-raised px-1">providerId</code> nếu muốn lưu cho từng dịch vụ — API nhận
          <code className="mx-1 rounded bg-raised px-1">{"{ oauthApps: { \"gmail\": { clientId, credential } } }"}</code>.
        </p>
      </Card>

      {loading ? (
        <Spinner />
      ) : providers.length === 0 ? (
        <EmptyState title="Chưa có provider nào" hint="Kiểm tra xem tầng connector đã được đăng ký chưa (GET /api/v1/capabilities)." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {providers.map((provider) => (
            <Card key={provider.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">{provider.label}</h2>
                  <p className="mt-1 text-xs text-muted">{provider.description}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={provider.status === "connected" ? "good" : provider.status === "error" ? "warn" : "neutral"}>
                    {provider.status === "connected" ? "đã kết nối" : provider.status === "error" ? "lỗi" : "chưa kết nối"}
                  </Badge>
                  <Badge>{provider.authKind === "oauth2" ? "OAuth" : "token"}</Badge>
                </div>
              </div>

              {provider.accountLabel ? <p className="mt-2 text-xs">Tài khoản: {provider.accountLabel}</p> : null}
              {provider.lastSyncAt ? (
                <p className="mt-1 text-[11px] text-muted">
                  Đồng bộ cuối: {provider.lastSyncAt.slice(0, 19).replace("T", " ")} · {provider.itemsSynced} mục luỹ kế
                </p>
              ) : null}
              {provider.lastError ? (
                <div className="mt-2">
                  <Notice tone="warn">{provider.lastError}</Notice>
                </div>
              ) : null}
              {provider.scopes.length > 0 ? (
                <p className="mt-2 line-clamp-2 text-[11px] text-muted">Quyền: {provider.scopes.join(", ")}</p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {provider.authKind === "oauth2" ? (
                  <Button variant="primary" onClick={() => void startOAuth(provider.id)} disabled={busy === provider.id}>
                    {provider.status === "connected" ? "Kết nối lại" : "Kết nối"}
                  </Button>
                ) : null}
                {provider.connectorId ? (
                  <>
                    <Button onClick={() => void syncNow(provider)} disabled={busy === provider.id}>
                      {busy === provider.id ? "Đang đồng bộ…" : "Đồng bộ ngay"}
                    </Button>
                    <Button onClick={() => void toggleAutoSync(provider)}>{provider.autoSync ? "Tắt tự động" : "Bật tự động"}</Button>
                    <Button
                      onClick={() => {
                        setExpanded(expanded === provider.connectorId ? null : provider.connectorId);
                        if (provider.connectorId) void loadRuns(provider.connectorId);
                      }}
                    >
                      Nhật ký
                    </Button>
                    <Button variant="danger" onClick={() => void disconnect(provider)}>
                      Ngắt
                    </Button>
                  </>
                ) : null}
              </div>

              {provider.authKind === "token" ? (
                <div className="mt-3 flex gap-2">
                  <Input
                    value={tokenInputs[provider.id] ?? ""}
                    onChange={(value) => setTokenInputs((current) => ({ ...current, [provider.id]: value }))}
                    placeholder="Dán token của dịch vụ"
                    type="password"
                  />
                  <Button onClick={() => void saveToken(provider.id)} disabled={busy === provider.id}>
                    Lưu
                  </Button>
                </div>
              ) : null}

              {provider.docsUrl ? (
                <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-[11px] text-muted underline">
                  Tài liệu API của {provider.label} ↗
                </a>
              ) : null}

              {expanded === provider.connectorId && provider.connectorId ? (
                <div className="mt-3 rounded-xl border border-line bg-raised/60 p-3">
                  <p className="mb-2 text-[11px] font-medium text-muted">Nhật ký đồng bộ gần đây</p>
                  {(runs[provider.connectorId] ?? []).length === 0 ? (
                    <p className="text-[11px] text-muted">Chưa có lần đồng bộ nào.</p>
                  ) : (
                    <ul className="space-y-1 text-[11px]">
                      {(runs[provider.connectorId] ?? []).map((run) => (
                        <li key={run.id} className="flex items-center justify-between gap-2">
                          <span>{run.startedAt.slice(0, 19).replace("T", " ")}</span>
                          <span className="text-muted">
                            +{run.added} / ~{run.updated} / bỏ qua {run.skipped} / lỗi {run.failed}
                          </span>
                          <Badge tone={run.status === "ok" ? "good" : run.status === "error" ? "warn" : "neutral"}>{run.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
