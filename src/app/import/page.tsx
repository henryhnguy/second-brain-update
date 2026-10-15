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
      setError("No files selected.");
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
        setMessage(`Imported ${result.imports.length} datasets.`);
        setDetails(result.imports.map((entry) => `${entry.importer}: +${entry.added ?? 0} added, ${entry.updated ?? 0} updated, ${entry.skipped ?? 0} skipped, ${entry.failed ?? 0} failed`));
      } else {
        setMessage(`Processed ${result.total ?? 0} files — ${result.created ?? 0} new documents.`);
        setDetails((result.results ?? []).map((entry) => `${entry.status} · ${entry.title} · ${entry.chunks} chunks${entry.error ? ` · ${entry.error}` : ""}`));
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
      setError("Enter an absolute folder path.");
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
        `Scanned ${report.scanned} files in ${report.tookMs}ms: +${report.ingested} added, ${report.updated} updated, ${report.skipped} skipped, ${report.removed} deleted from the folder, ${report.failed} failed.`,
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
      setMessage(`Saved "${result.title}" (${result.chunks} chunks).`);
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
      setMessage(`Saved ${result.chunks} chunks to memory.`);
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
        <h1 className="text-xl font-semibold tracking-tight">Import</h1>
        <p className="text-sm text-muted">
          Bring in documents from files, an Obsidian vault, links or another service's export — no OAuth needed.
        </p>
      </header>

      <Tabs
        tabs={[
          { id: "files", label: "Files" },
          { id: "folder", label: "Folder" },
          { id: "url", label: "Link" },
          { id: "paste", label: "Paste text" },
          { id: "export", label: "Export" },
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
          <CardTitle hint="md, txt, pdf, docx, html, csv, json, eml…">Upload files</CardTitle>
          <input ref={fileRef} type="file" multiple className="block w-full text-sm" />
          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" onClick={() => void upload("/api/v1/ingest/file", fileRef.current, "file")} disabled={busy}>
              {busy ? "Processing…" : "Save to memory"}
            </Button>
            <span className="text-xs text-muted">Original files are kept in the data/files folder so they can be re-indexed.</span>
          </div>
        </Card>
      ) : null}

      {tab === "folder" ? (
        <Card>
          <CardTitle hint="incremental sync by modified time">Local folder</CardTitle>
          <Input value={folder} onChange={setFolder} placeholder="C:\\Users\\you\\Documents\\vault" />
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
            Re-index unchanged files too
          </label>
          <div className="mt-3">
            <Button variant="primary" onClick={() => void syncFolder()} disabled={busy}>
              {busy ? "Scanning…" : "Sync folder"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Hidden folders, node_modules and .git are skipped; files larger than 32MB are skipped. Files deleted from the folder are
            marked as deleted in memory.
          </p>
        </Card>
      ) : null}

      {tab === "url" ? (
        <Card>
          <CardTitle hint="fetches the page and extracts the main content">Link</CardTitle>
          <Input value={url} onChange={setUrl} placeholder="https://example.com/article" onEnter={() => void captureUrl()} />
          <div className="mt-3">
            <Button variant="primary" onClick={() => void captureUrl()} disabled={busy}>
              {busy ? "Loading…" : "Save this page"}
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "paste" ? (
        <Card>
          <CardTitle>Paste text</CardTitle>
          <Input value={pasteTitle} onChange={setPasteTitle} placeholder="Title (optional)" />
          <div className="mt-2">
            <Textarea value={paste} onChange={setPaste} rows={10} placeholder="Paste the content you want to save…" />
          </div>
          <div className="mt-2">
            <Input value={pasteTags} onChange={setPasteTags} placeholder="Tags, comma-separated" />
          </div>
          <div className="mt-3">
            <Button variant="primary" onClick={() => void savePaste()} disabled={busy}>
              Save
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "export" ? (
        <Card>
          <CardTitle hint="no OAuth needed">Export from another service</CardTitle>
          <input ref={exportRef} type="file" multiple className="block w-full text-sm" />
          <div className="mt-3">
            <Button variant="primary" onClick={() => void upload("/api/v1/ingest/importer", exportRef.current, "importer")} disabled={busy}>
              {busy ? "Importing…" : "Import an export"}
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
            Examples: Google Takeout (.mbox), Slack export (.zip), Notion export (.zip), calendar (.ics), email (.eml).
          </p>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Supported formats</CardTitle>
        {!capabilities ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Text extraction</p>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.extractors.map((extractor) => (
                  <Badge key={extractor.id}>
                    {extractor.label} · {extractor.extensions.slice(0, 6).join(" ")}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Bulk importers</p>
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
