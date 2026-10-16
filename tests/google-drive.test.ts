import { describe, expect, it, vi } from "vitest";

import { googleDriveProvider } from "@/lib/connectors/providers/google_drive";
import type { SyncContext } from "@/lib/connectors/types";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const PNG = "image/png";

/** A Drive listing page with one of each kind of file we care about. */
const PAGE_ONE = {
  nextPageToken: "TOKEN-2",
  files: [
    {
      id: "doc-1",
      name: "Quarterly plan",
      mimeType: DOC,
      modifiedTime: "2026-03-01T10:00:00.000Z",
      createdTime: "2026-02-01T09:00:00.000Z",
      webViewLink: "https://docs.google.com/document/d/doc-1",
      owners: [{ displayName: "Henry", emailAddress: "henry@example.com" }],
    },
    { id: "sheet-1", name: "Budgets", mimeType: SHEET, modifiedTime: "2026-03-02T10:00:00.000Z" },
    { id: "text-1", name: "notes.txt", mimeType: "text/plain", modifiedTime: "2026-03-03T10:00:00.000Z" },
    { id: "png-1", name: "diagram.png", mimeType: PNG, modifiedTime: "2026-03-04T10:00:00.000Z" },
    { id: "trashed-1", name: "old.txt", mimeType: "text/plain", trashed: true },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function context(fetchImpl: typeof fetch, overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    fetchImpl,
    accessToken: process.env.SB_TEST_DRIVE_TOKEN ?? "verify-only",
    credentials: {},
    config: {},
    cursor: {},
    limit: 25,
    since: null,
    logger: () => {},
    ...overrides,
  };
}

/** Routes a mocked Drive call by URL, and records what was requested. */
function driveFetch(requests: string[], overrides: { list?: Response; exportStatus?: number } = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    requests.push(href);
    if (href.includes("/files?")) return overrides.list ?? jsonResponse(PAGE_ONE);
    if (href.includes("/export?mimeType=text/csv")) return textResponse("item,amount\nhosting,40");
    if (href.includes("/files/sheet-1")) return textResponse("item,amount\nhosting,40");
    if (href.includes("/files/text-1")) return textResponse("plain text file");
    if (href.includes("/files/doc-1")) return textResponse("the exported document body");
    if (overrides.exportStatus && overrides.exportStatus !== 200) return textResponse("nope", overrides.exportStatus);
    return textResponse("", 403);
  }) as unknown as typeof fetch;
}

describe("google drive connector", () => {
  it("exports Google formats as text, decodes plain files, and skips the rest", async () => {
    const requests: string[] = [];
    const page = await googleDriveProvider.syncPage(context(driveFetch(requests)));

    expect(page.docs.map((doc) => doc.externalId)).toEqual(["doc-1", "sheet-1", "text-1"]);
    expect(page.stats?.["skipped"]).toBe(1);

    const doc = page.docs[0];
    expect(doc?.title).toBe("Quarterly plan");
    expect(doc?.author).toBe("Henry");
    expect(doc?.url).toBe("https://docs.google.com/document/d/doc-1");
    expect(doc?.createdAt).toBe("2026-02-01T09:00:00.000Z");
    expect(doc?.text).toContain("the exported document body");
    expect(doc?.text).toContain("Format: Google Doc (exported as text/plain)");
    expect(doc?.meta?.["exported"]).toBe(true);

    expect(page.docs[1]?.text).toContain("hosting,40");
    expect(page.docs[2]?.text).toContain("plain text file");

    // The design decision this guards: a Google format is exported, a binary is
    // never requested at all.
    expect(requests.some((href) => href.includes("/files/doc-1/export"))).toBe(true);
    expect(requests.some((href) => href.includes("png-1"))).toBe(false);
    expect(requests.some((href) => href.includes("trashed-1"))).toBe(false);
  });

  it("carries the page token forward and resumes from it", async () => {
    const first: string[] = [];
    const page = await googleDriveProvider.syncPage(context(driveFetch(first)));
    expect(page.cursor["pageToken"]).toBe("TOKEN-2");
    expect(page.hasMore).toBe(true);

    const second: string[] = [];
    await googleDriveProvider.syncPage(context(driveFetch(second), { cursor: { pageToken: "TOKEN-2" } }));
    expect(second[0]).toContain("pageToken=TOKEN-2");
  });

  it("walks the whole drive on the first sync and only changes afterwards", async () => {
    const first: string[] = [];
    await googleDriveProvider.syncPage(context(driveFetch(first)));
    // URLSearchParams writes a space as `+`; Google accepts either form.
const firstQuery = decodeURIComponent(first[0] ?? "").replace(/\+/g, " ");
    expect(firstQuery).toContain("trashed = false");
    expect(firstQuery).toContain("mimeType != 'application/vnd.google-apps.folder'");
    expect(firstQuery).not.toContain("modifiedTime >");

    const later: string[] = [];
    await googleDriveProvider.syncPage(context(driveFetch(later), { since: "2026-03-05T00:00:00.000Z" }));
    expect(decodeURIComponent(later[0] ?? "").replace(/\+/g, " ")).toContain("modifiedTime > '2026-03-05T00:00:00.000Z'");
  });

  it("keeps the page when one file cannot be exported", async () => {
    const requests: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      requests.push(href);
      if (href.includes("/files?")) return jsonResponse({ files: [{ id: "doc-1", name: "Locked", mimeType: DOC }] });
      return textResponse("forbidden", 403);
    }) as unknown as typeof fetch;

    const page = await googleDriveProvider.syncPage(context(fetchImpl));

    expect(page.docs).toEqual([]);
    expect(page.stats?.["skipped"]).toBe(1);
    expect(page.stats?.["fetched"]).toBe(0);
  });

  it("returns an empty page instead of throwing when the drive is empty", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ files: [] })) as unknown as typeof fetch;
    const page = await googleDriveProvider.syncPage(context(fetchImpl));

    expect(page.docs).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toEqual({});
  });

  it("surfaces a failing listing so the sync run records an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "quota" } }, 500)) as unknown as typeof fetch;

    await expect(googleDriveProvider.syncPage(context(fetchImpl))).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("names the account behind the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ user: { displayName: "Henry", emailAddress: "henry@example.com" } }),
    ) as unknown as typeof fetch;

    const identity = await googleDriveProvider.identify?.(context(fetchImpl));

    expect(identity?.accountLabel).toBe("henry@example.com");
    expect(identity?.extra?.["displayName"]).toBe("Henry");
  });
});
