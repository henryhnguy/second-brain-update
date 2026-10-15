/**
 * OAuth 2.0 / PKCE plumbing shared by the OAuth connectors.
 *
 * Everything takes the `fetch` implementation as its first argument, so the
 * whole flow can be exercised with a mock and nothing here ever reads a global
 * or an environment variable: client ids and secrets travel as parameters.
 */

import { createHash } from "node:crypto";
import { AppError, badRequest } from "../core/errors";
import { randomBytes } from "../core/ids";
import { toIso } from "../core/time";
import { hostOf } from "./http";
import type { HttpFetch, OAuthConfig, OAuthExchangeResult, OAuthTokens } from "./types";

const DEFAULT_TIMEOUT_MS = 20_000;

export type PkcePair = {
  /** High-entropy verifier kept server side until the code is exchanged. */
  verifier: string;
  /** `base64url(sha256(verifier))`, sent as `code_challenge`. */
  challenge: string;
  method: "S256";
};

/**
 * RFC 7636 verifier/challenge pair. Pass `verifier` to make it deterministic in
 * tests; production callers let it generate 32 random bytes (43 base64url chars).
 */
export function createPkcePair(verifier: string = randomBytes(32).toString("base64url")): PkcePair {
  if (verifier.length < 43 || verifier.length > 128) {
    throw badRequest("PKCE verifier must be 43-128 characters (RFC 7636 §4.1)");
  }
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    method: "S256",
  };
}

export type AuthorizeUrlParams = {
  clientId: string;
  redirectUri: string;
  /** Opaque value echoed back on the callback; store it with the verifier. */
  state: string;
  /** `createPkcePair().challenge`; required when `oauth.pkce` is true. */
  codeChallenge?: string;
  /** Provider extras, e.g. `access_type: "offline"` or `login_hint`. */
  extraParams?: Record<string, string>;
};

/** Builds the consent URL a user is redirected to. */
export function buildAuthorizeUrl(oauth: OAuthConfig, params: AuthorizeUrlParams): string {
  const url = new URL(oauth.authorizeUrl);
  for (const [key, value] of Object.entries(oauth.extraAuthParams ?? {})) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(params.extraParams ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  if (oauth.scopes.length > 0) url.searchParams.set("scope", oauth.scopes.join(" "));
  if (oauth.pkce && params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export type ExchangeCodeParams = {
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  code: string;
  /** Must be the verifier behind `codeChallenge` when `oauth.pkce` is true. */
  codeVerifier?: string | null;
  timeoutMs?: number;
};

/** Exchanges an authorization code for tokens. */
export async function exchangeCode(
  fetchImpl: HttpFetch,
  oauth: OAuthConfig,
  params: ExchangeCodeParams,
): Promise<OAuthExchangeResult> {
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  };
  if (oauth.pkce) {
    if (!params.codeVerifier) throw badRequest("This provider uses PKCE: codeVerifier is required");
    form.code_verifier = params.codeVerifier;
  }
  const payload = await postTokenForm(fetchImpl, {
    oauth,
    clientId: params.clientId,
    clientSecret: params.clientSecret ?? null,
    form,
    url: oauth.tokenUrl,
    timeoutMs: params.timeoutMs,
  });
  return { ...tokensFromPayload(payload), raw: payload };
}

export type RefreshTokenParams = {
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
  /** Defaults to the provider's configured scopes. */
  scopes?: string[];
  timeoutMs?: number;
};

/** Refreshes an access token, keeping the previous refresh token if none is returned. */
export async function refreshAccessToken(
  fetchImpl: HttpFetch,
  oauth: OAuthConfig,
  params: RefreshTokenParams,
): Promise<OAuthExchangeResult> {
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: params.refreshToken };
  const scopes = params.scopes ?? oauth.scopes;
  if (scopes.length > 0) form.scope = scopes.join(" ");
  const payload = await postTokenForm(fetchImpl, {
    oauth,
    clientId: params.clientId,
    clientSecret: params.clientSecret ?? null,
    form,
    url: oauth.tokenUrl,
    timeoutMs: params.timeoutMs,
  });
  const tokens = tokensFromPayload(payload);
  return { ...tokens, refreshToken: tokens.refreshToken ?? params.refreshToken, raw: payload };
}

export type RevokeTokenParams = {
  /** Provider revoke endpoint; `OAuthConfig` has no field for it. */
  revokeUrl: string;
  token: string;
  clientId: string;
  clientSecret?: string | null;
  tokenTypeHint?: "access_token" | "refresh_token";
  timeoutMs?: number;
};

/** Best-effort revocation: throws only when the endpoint itself fails. */
export async function revokeToken(
  fetchImpl: HttpFetch,
  oauth: OAuthConfig,
  params: RevokeTokenParams,
): Promise<void> {
  const form: Record<string, string> = { token: params.token };
  if (params.tokenTypeHint) form.token_type_hint = params.tokenTypeHint;
  await postTokenForm(fetchImpl, {
    oauth,
    clientId: params.clientId,
    clientSecret: params.clientSecret ?? null,
    form,
    url: params.revokeUrl,
    timeoutMs: params.timeoutMs,
  });
}

/**
 * True when `expiresAt` has passed or is closer than `skewSeconds`. Tokens
 * without an expiry are reported as usable: the provider's 401 path is what
 * forces a refresh for those services.
 */
export function isTokenExpired(tokens: OAuthTokens, skewSeconds = 120): boolean {
  if (!tokens.expiresAt) return false;
  const expiresAt = Date.parse(tokens.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return Date.now() + skewSeconds * 1000 >= expiresAt;
}

type TokenFormInput = {
  oauth: OAuthConfig;
  clientId: string;
  clientSecret: string | null;
  form: Record<string, string>;
  url: string;
  timeoutMs?: number;
};

/**
 * POSTs a form to a token/revoke endpoint, applying the provider's
 * `tokenEndpointAuth` style and mapping failures to `AppError`.
 */
async function postTokenForm(fetchImpl: HttpFetch, input: TokenFormInput): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(input.form)) body.set(key, value);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    ...(input.oauth.tokenHeaders ?? {}),
  };

  if (input.oauth.tokenEndpointAuth === "body_client_secret") {
    body.set("client_id", input.clientId);
    if (input.clientSecret) body.set("client_secret", input.clientSecret);
  } else if (input.oauth.tokenEndpointAuth === "basic") {
    if (!input.clientSecret) throw badRequest("This provider authenticates with HTTP Basic: clientSecret is required");
    headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
  } else {
    // Public client: only PKCE protects the exchange, so no secret is sent.
    body.set("client_id", input.clientId);
  }

  const response = await fetchWithTimeout(
    fetchImpl,
    input.url,
    { method: "POST", headers, body: body.toString() },
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const payload = await readJsonSafely(response);
  if (response.status < 200 || response.status >= 300) throw tokenEndpointError(response, payload, input.url);
  return payload ?? {};
}

function tokenEndpointError(response: Response, payload: Record<string, unknown> | null, url: string): AppError {
  const code = typeof payload?.["error"] === "string" ? payload["error"] : null;
  const description = typeof payload?.["error_description"] === "string" ? payload["error_description"] : null;
  const reason = [code ?? `HTTP ${response.status}`, description].filter((part) => Boolean(part)).join(": ");
  const details: Record<string, unknown> = { status: response.status, url };
  if (payload) details["body"] = payload;
  if (response.status === 429) {
    return new AppError("rate_limited", `Token endpoint rate limited (${reason})`, { details, retryable: true });
  }
  if (response.status >= 500) {
    return new AppError("upstream_error", `Token endpoint unavailable (${reason})`, { details, retryable: true });
  }
  return new AppError("unauthorized", `Token endpoint rejected the request (${reason})`, { details });
}

function tokensFromPayload(payload: Record<string, unknown>): OAuthTokens {
  const accessToken = typeof payload["access_token"] === "string" ? payload["access_token"] : "";
  if (accessToken.length === 0) {
    throw new AppError("unauthorized", "Token endpoint returned no access_token", {
      details: { keys: Object.keys(payload) },
    });
  }
  const rawExpiresIn = payload["expires_in"];
  const expiresIn = typeof rawExpiresIn === "number" ? rawExpiresIn : Number(rawExpiresIn);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? toIso(Date.now() + expiresIn * 1000) : null;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "access_token" || key === "refresh_token" || key === "expires_in" || key === "token_type" || key === "scope") continue;
    extra[key] = value;
  }
  return {
    accessToken,
    refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : null,
    expiresAt,
    tokenType: typeof payload["token_type"] === "string" ? payload["token_type"] : null,
    scope: typeof payload["scope"] === "string" ? payload["scope"] : null,
    extra,
  };
}

/** Aborts a hung token request; uses the caller-supplied fetch implementation. */
async function fetchWithTimeout(fetchImpl: HttpFetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs) : undefined;
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    const suffix = error instanceof Error && error.name === "AbortError" ? `timed out after ${timeoutMs}ms` : `failed: ${messageOf(error)}`;
    throw new AppError("upstream_error", `OAuth request to ${hostOf(url)} ${suffix}`, {
      details: { url, timeoutMs },
      cause: error,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readJsonSafely(response: Response): Promise<Record<string, unknown> | null> {
  let text = "";
  try {
    if (typeof response.text === "function") text = await response.text();
  } catch {
    return null;
  }
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
