/**
 * DOCX extractor — `mammoth` is loaded lazily (heavy: true) and only asked for
 * raw text. Layout, styles and images are ignored by design; mammoth's own
 * warnings/errors are surfaced as extraction warnings.
 */

import type { ExtractedDoc, Extractor, ExtractInput } from "./types";

/** Keep the warnings array bounded: a broken docx can emit hundreds of them. */
const MAX_WARNINGS = 20;

type MammothResult = { value: string; messages: { type: string; message: string }[] };

/** The slice of the mammoth API this extractor uses. */
type MammothApi = {
  extractRawText(input: { buffer: Buffer }): Promise<MammothResult>;
};

async function loadMammoth(): Promise<MammothApi> {
  const module = await import("mammoth");
  return module.default as MammothApi;
}

async function extractDocxText(bytes: Uint8Array): Promise<ExtractedDoc> {
  const mammoth = await loadMammoth();
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const warnings = result.messages
    .slice(0, MAX_WARNINGS)
    .map((message) => `${message.type}: ${message.message}`);
  return {
    text: result.value.trim(),
    title: null,
    meta: { messages: result.messages.length },
    warnings,
  };
}

export const docxExtractor: Extractor = {
  id: "docx",
  label: "Word document",
  extensions: [".docx"],
  mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  heavy: true,
  async extract(input: ExtractInput): Promise<ExtractedDoc> {
    try {
      return await extractDocxText(input.bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: "", title: null, meta: {}, warnings: [`docx extraction failed: ${reason}`] };
    }
  },
};
