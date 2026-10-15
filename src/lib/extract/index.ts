/**
 * Extraction layer entry point.
 *
 * Importing this module registers every built-in extractor exactly once, so
 * application code only needs `extractFile` / `getExtractorFor` from here.
 */

import { emlExtractor } from "./eml";
import { docxExtractor } from "./docx";
import { htmlExtractor } from "./html";
import { pdfExtractor } from "./pdf";
import { registerExtractor } from "./registry";
import { textExtractor } from "./text";

const BUILT_IN_EXTRACTORS = [
  textExtractor,
  htmlExtractor,
  pdfExtractor,
  docxExtractor,
  emlExtractor,
];

let registered = false;

/** Registers the built-in extractors; safe to call more than once. */
export function ensureExtractorsRegistered(): void {
  if (registered) return;
  for (const extractor of BUILT_IN_EXTRACTORS) registerExtractor(extractor);
  registered = true;
}

ensureExtractorsRegistered();

export { extractFile, getExtractorFor, listExtractors, registerExtractor } from "./registry";
export type { ExtractedDoc, ExtractInput, Extractor, NormalizedText } from "./types";
export { TEXT_EXTENSIONS } from "./types";
