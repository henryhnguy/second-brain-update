import { randomUUID, randomBytes, createHash } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type IdPrefix =
  | "doc"
  | "chk"
  | "note"
  | "tag"
  | "col"
  | "cnv"
  | "msg"
  | "ent"
  | "con"
  | "job"
  | "evt"
  | "play"
  | "run"
  | "tok"
  | "ing";

/** Sortable, prefixed identifier: `doc_01JD3K...`. */
export function newId(prefix: IdPrefix, timestamp = Date.now()): string {
  let time = timestamp;
  let encoded = "";
  for (let i = 0; i < 10; i += 1) {
    encoded = CROCKFORD[time % 32] + encoded;
    time = Math.floor(time / 32);
  }
  const noise = randomBytes(10);
  let rest = "";
  for (const byte of noise) {
    rest += CROCKFORD[byte % 32];
  }
  return `${prefix}_${encoded}${rest}`;
}

export function oauthState(): string {
  return randomBytes(24).toString("base64url");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable content hash used for de-duplication across re-ingests. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

/** Deterministic id for entities discovered by extraction (name + type). */
export function entityId(type: string, name: string): string {
  const digest = createHash("sha1").update(`${type}:${name.trim().toLowerCase()}`).digest("hex");
  return `ent_${digest.slice(0, 24)}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function uuid(): string {
  return randomUUID();
}

export { randomBytes };
