import { envBool, envStr } from "../core/env";
import { unauthorized } from "../core/errors";
import { verifyApiToken } from "../db/repo/system";

/**
 * Auth policy for a single-user, local-first app:
 *  - requests from loopback (the bundled UI) are allowed without a token;
 *  - anything else must present `Authorization: Bearer <token>`;
 *  - `SB_API_REQUIRE_TOKEN=1` demands a token even for loopback (reverse proxies).
 */

export type AuthContext = {
  mode: "loopback" | "token" | "open";
  tokenName?: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return true;
  return LOOPBACK_HOSTS.has(address);
}

export function extractBearer(headers: Headers): string | null {
  const raw = headers.get("authorization") ?? headers.get("Authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() ?? null;
}

export function assertAuthorized(input: { headers: Headers; remoteAddress?: string | null }): AuthContext {
  const requireToken = envBool("SB_API_REQUIRE_TOKEN", false);
  const token = extractBearer(input.headers);
  if (token) {
    const record = verifyApiToken(token);
    if (!record) throw unauthorized("API token không hợp lệ hoặc đã bị thu hồi.");
    return { mode: "token", tokenName: record.name };
  }
  if (requireToken) throw unauthorized("Cần Authorization: Bearer <token> (SB_API_REQUIRE_TOKEN=1).");
  if (isLoopbackAddress(input.remoteAddress)) return { mode: "loopback" };
  throw unauthorized("Chỉ chấp nhận request từ máy cục bộ hoặc kèm Bearer token.");
}

export function authDisabled(): boolean {
  return envBool("SB_API_DISABLE_AUTH", false);
}

export function publicBaseUrl(): string {
  return envStr("SB_PUBLIC_URL", "");
}
