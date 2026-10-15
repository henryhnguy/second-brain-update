import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { secretFile } from "../core/env";
import { AppError } from "../core/errors";

/**
 * Token-at-rest protection. The key is a random 32-byte value stored in the data
 * directory (chmod 600 where the platform supports it); connector tokens are
 * sealed with AES-256-GCM so a copied `brain.db` alone is not enough to read them.
 */

const KEY_BYTES = 32;
const PREFIX = "sb1";

let cachedKey: Buffer | null = null;
let cachedKeyFile: string | null = null;

export function loadOrCreateKey(file = secretFile()): Buffer {
  if (cachedKey && cachedKeyFile === file) return cachedKey;

  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const generated = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(file, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows and some filesystems ignore this */
    }
    cachedKey = generated;
    cachedKeyFile = file;
    return generated;
  }

  const raw = fs.readFileSync(file, "utf8").trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new AppError("storage_error", `Secret key at ${file} is not a ${KEY_BYTES}-byte base64 value.`);
  }
  cachedKey = key;
  cachedKeyFile = file;
  return key;
}

/** Seals a JSON-serialisable payload: `sb1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function seal(plaintext: string, key = loadOrCreateKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function openSealed(sealed: string | null | undefined, key = loadOrCreateKey()): string | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new AppError("storage_error", "Stored secret is not in the expected sealed format.");
  }
  const iv = Buffer.from(parts[1] as string, "base64url");
  const tag = Buffer.from(parts[2] as string, "base64url");
  const data = Buffer.from(parts[3] as string, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new AppError("storage_error", "Could not decrypt the stored secret (key changed?).", {
      cause: error,
    });
  }
}

export function sealJson(value: unknown, key = loadOrCreateKey()): string {
  return seal(JSON.stringify(value ?? null), key);
}

export function openSealedJson<T>(sealed: string | null | undefined, key = loadOrCreateKey()): T | null {
  const text = openSealed(sealed, key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new AppError("storage_error", "Stored secret is not valid JSON.", { cause: error });
  }
}

/** Shows only the last 4 characters; used by the UI and API responses. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export function shortFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Resets the cached key — used by tests that swap data directories. */
export function resetKeyCache(): void {
  cachedKey = null;
  cachedKeyFile = null;
}
