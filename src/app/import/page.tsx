"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, Button, Card, CardTitle, Input, Notice, Spinner, Tabs, Textarea, api } from "@/components/ui";

type Capabilities = {
  extractors: { id: string; label: string; extensions: string[] }[];
  importers: { id: string; label: string; extensions: string[] }[];
};

type ImportSummary = { added?: number; updated?: number; skipped?: number; failed?: number; importer?: string; total?: number; created?: number };

type TabId = "files" | "folder" | "url" | "paste" | "export";

export default function ImportPage() {
  const [tab, setTab] = useState<TabId>("files");
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  const [folder, setFolder] = useState("");
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteTags, setPasteTags] = useState("");
  const [force, setForce] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const exportRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setCapabilities(await api<Capabilities>("/api/v1/capabilities"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(path: string, input: HTMLInputElement | null, endpoint: string) {
    const files = input?.files;
    if (!files || files.length === 0) {
      setError("Chưa chọn tệp nào.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    setDetails([]);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("file", file);
      const result = await api<{ imports?: ImportSummary[]; created?: number; total?: number; results?: { title: string; status: string; chunks: number; error?: string }[] }>(
        path,
        { method: "POST", body: form },
      );
      if (result.imports) {
        setMessage(`Đã nhập ${result.imports.length} bộ dữ liệu.`);
        setDetails(result.imports.map((entry) => `${entry.importer}: +${entry.added ?? 0} mới, ${entry.updated ?? 0} cập nhật, ${entry.skipped ?? 0} bỏ qua, ${entry.failed ?? 0} lỗi`));
      } else {
        setMessage(`Đã xử lý ${result.total ?? 0} tệp — ${result.created ?? 0} tài liệu mới.`);
        setDetails((result.results ?? []).map((entry) => `${entry.status} · ${entry.title} · ${entry.chunks} đoạn${entry.error ? ` · ${entry.error}` : ""}`));
      }
      if (input) input.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function syncFolder() {
    if (folder.trim().length === 0) {
      setError("Nhập đường dẫn thư mục tuyệt đối.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const report = await api<{ scanned: number; ingested: number; updated: number; skipped: number; failed: number; removed: number; tookMs: number }>(
        "/api/v1/ingest/folder",
        { method: "POST", body: JSON.stringify({ root: folder.trim(), force }) },
      );
      setMessage(
        `Quét ${report.scanned} tệp trong ${report.tookMs}ms: +${report.ingested} mới, ${report.updated} cập nhật, ${report.skipped} bỏ qua, ${report.removed} đã xoá khỏi thư mục, ${report.failed} lỗi.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function captureUrl() {
    if (url.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ documentId: string; chunks: number; title: string; warnings: string[] }>("/api/v1/ingest/url", {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      setMessage(`Đã lưu “${result.title}” (${result.chunks} đoạn).`);
      setDetails(result.warnings);
      setUrl("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function savePaste() {
    if (paste.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const tags = pasteTags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      const result = await api<{ documentId: string; chunks: number }>("/api/v1/ingest/text", {
        method: "POST",
        body: JSON.stringify({ text: paste, title: pasteTitle || undefined, tags, sourceKind: "paste" }),
      });
      setMessage(`Đã lưu ${result.chunks} đoạn vào bộ nhớ.`);
      setPaste("");
      setPasteTitle("");
      setPasteTags("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Nhập dữ liệu</h1>
        <p className="text-sm text-muted">
          Nạp tài liệu từ tệp, thư mục Obsidian, liên kết hoặc bản export của dịch vụ khác — không cần kết nối OAuth.
        </p>
      </header>

      <Tabs
        tabs={[
          { id: "files", label: "Tệp" },
          { id: "folder", label: "Thư mục" },
          { id: "url", label: "Liên kết" },
          { id: "paste", label: "Dán văn bản" },
          { id: "export", label: "Bản export" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {message ? <Notice tone="good">{message}</Notice> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}
      {details.length > 0 ? (
        <Notice>
          <ul className="space-y-0.5">
            {details.slice(0, 12).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {tab === "files" ? (
        <Card>
          <CardTitle hint="md, txt, pdf, docx, html, csv, json, eml…">Tải tệp lên</CardTitle>
          <input ref={fileRef} type="file" multiple className="block w-full text-sm" />
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" onClick={() => void upload("/api/v1/ingest/file", fileRef.current, "file")} disabled={busy}>
              {busy ? "Đang xử lý…" : "Nạp vào bộ nhớ"}
            </Button>
            <span className="text-xs text-muted">Tệp gốc được giữ trong thư mục data/files để có thể lập chỉ mục lại.</span>
          </div>
        </Card>
      ) : null}

      {tab === "folder" ? (
        <Card>
          <CardTitle hint="đồng bộ tăng dần theo mtime">Thư mục trên máy</CardTitle>
          <Input value={folder} onChange={setFolder} placeholder="C:\\Users\\ban\\Documents\\vault" />
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
            Lập chỉ mục lại cả tệp không thay đổi
          </label>
          <div className="mt-3">
            <Button variant="primary" onClick={() => void syncFolder()} disabled={busy}>
              {busy ? "Đang quét…" : "Đồng bộ thư mục"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Bỏ qua các thư mục ẩn, node_modules, .git; tệp lớn hơn 32MB bị bỏ qua. Tệp bị xoá khỏi thư mục sẽ được đánh dấu đã xoá
            trong bộ nhớ.
          </p>
        </Card>
      ) : null}

      {tab === "url" ? (
        <Card>
          <CardTitle hint="tải trang và trích phần nội dung chính">Liên kết</CardTitle>
          <Input value={url} onChange={setUrl} placeholder="https://example.com/bai-viet" onEnter={() => void captureUrl()} />
          <div className="mt-3">
            <Button variant="primary" onClick={() => void captureUrl()} disabled={busy}>
              {busy ? "Đang tải…" : "Lưu trang này"}
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "paste" ? (
        <Card>
          <CardTitle>Dán văn bản</CardTitle>
          <Input value={pasteTitle} onChange={setPasteTitle} placeholder="Tiêu đề (tuỳ chọn)" />
          <div className="mt-2">
            <Textarea value={paste} onChange={setPaste} rows={10} placeholder="Dán nội dung cần lưu…" />
          </div>
          <div className="mt-2">
            <Input value={pasteTags} onChange={setPasteTags} placeholder="Thẻ, phân cách bằng dấu phẩy" />
          </div>
          <div className="mt-3">
            <Button variant="primary" onClick={() => void savePaste()} disabled={busy}>
              Lưu
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "export" ? (
        <Card>
          <CardTitle hint="không cần OAuth">Bản export của dịch vụ khác</CardTitle>
          <input ref={exportRef} type="file" multiple className="block w-full text-sm" />
          <div className="mt-3">
            <Button variant="primary" onClick={() => void upload("/api/v1/ingest/importer", exportRef.current, "importer")} disabled={busy}>
              {busy ? "Đang nhập…" : "Nhập bản export"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(capabilities?.importers ?? []).map((importer) => (
              <Badge key={importer.id} tone="accent">
                {importer.label} · {importer.extensions.join(" ")}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Ví dụ: Google Takeout (.mbox), Slack export (.zip), Notion export (.zip), lịch (.ics), email (.eml).
          </p>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Định dạng đã hỗ trợ</CardTitle>
        {!capabilities ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Trích xuất văn bản</p>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.extractors.map((extractor) => (
                  <Badge key={extractor.id}>
                    {extractor.label} · {extractor.extensions.slice(0, 6).join(" ")}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Bộ nhập hàng loạt</p>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.importers.map((importer) => (
                  <Badge key={importer.id}>{importer.id}</Badge>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
