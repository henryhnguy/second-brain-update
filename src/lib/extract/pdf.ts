/**
 * PDF extractor — `pdfjs-dist` legacy build, loaded lazily (heavy: true).
 *
 * In Node the legacy build runs the worker on the main thread ("fake worker"),
 * so no `workerSrc`/network access is needed. A PDF without a text layer
 * (scanned pages) is not an error: it yields an empty text plus a warning.
 */

import type { ExtractedDoc, Extractor, ExtractInput } from "./types";

/** Below this length the extracted text is considered "no text layer". */
const MIN_TEXT_LENGTH = 20;

async function extractPdfText(bytes: Uint8Array): Promise<ExtractedDoc> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        parts.push(item.str);
        if (item.hasEOL) parts.push("\n");
      }
      pages.push(parts.join("").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim());
      page.cleanup();
    }
    const text = pages.join("\n\n").trim();
    const warnings: string[] = [];
    if (text.length < MIN_TEXT_LENGTH) warnings.push("pdf has no text layer (scanned?)");
    return { text, title: null, meta: { pages: document.numPages }, warnings };
  } finally {
    await document.destroy();
  }
}

export const pdfExtractor: Extractor = {
  id: "pdf",
  label: "PDF document",
  extensions: [".pdf"],
  mimes: ["application/pdf"],
  heavy: true,
  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    try {
      return await extractPdfText(input.bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: "", title: null, meta: {}, warnings: [`pdf extraction failed: ${reason}`] };
    }
  },
};
