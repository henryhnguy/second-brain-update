/**
 * On-demand loader for `adm-zip`.
 *
 * The parser is CommonJS and reaches for Node built-ins, so importing it at the
 * top of an importer drags it into every bundle that touches the importer
 * registry — the server bootstrap is one, and it cannot compile there. Naming
 * the loader in a single place keeps both ZIP importers out of that graph;
 * `mammoth` and `pdfjs-dist` are loaded the same way in `lib/extract`.
 */

import type AdmZip from "adm-zip";

/** One entry of an opened archive, as the importers use it. */
export type ZipEntry = ReturnType<AdmZip["getEntries"]>[number];

/** The slice of the adm-zip API the importers use. */
export type AdmZipApi = new (input: Buffer) => AdmZip;

let cached: AdmZipApi | null = null;

/** The `AdmZip` constructor, imported once per process. */
export async function loadAdmZip(): Promise<AdmZipApi> {
  if (!cached) {
    const module = await import("adm-zip");
    cached = module.default as AdmZipApi;
  }
  return cached;
}
