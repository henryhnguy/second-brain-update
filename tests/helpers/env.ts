import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDb } from "@/lib/db/connection";
import { resetKeyCache } from "@/lib/crypto/secretbox";

/**
 * Points the app at a throwaway data directory and reopens the database.
 * Every suite must call this before touching storage.
 */
export function useTempDataDir(prefix = "sb-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.SB_DATA_DIR = dir;
  process.env.SB_DB_FILE = path.join(dir, "brain.db");
  process.env.SB_SECRET_FILE = path.join(dir, ".secret");
  process.env.SB_AI_MODE = "off";
  process.env.SB_AI_API_KEY = "";
  process.env.SB_AI_BASE_URL = "https://api.openai.com/v1";
  resetKeyCache();
  resetDb();
  return dir;
}

export function removeTempDataDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort on Windows file locks */
  }
}

export function writeFixture(dir: string, name: string, content: string): string {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}
