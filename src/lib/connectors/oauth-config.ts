import { AppError } from "../core/errors";
import { envStr, appUrl } from "../core/env";
import { loadOrCreateKey, openSealed, seal } from "../crypto/secretbox";
import { getSetting, setSetting } from "../db/repo/system";
import type { Provider } from "./types";
import { exchangeCode, isTokenExpired, refreshAccessToken, type PkcePair } from "./oauth";
import { loadTokens, saveTokens, updateConnectorState, getConnector } from "./store";
import type { OAuthTokens } from "./types";
import { createPkcePair } from "./oauth";

/**
 * OAuth client credentials live in Settings (sealed) with environment variables
 * as a fallback, so a self-hoster can either paste keys in the UI or keep them
 * in `.env` — see docs/connectors.md for how to register each app.
 */

export type OAuthApp = { clientId: string; clientSecret: string };

function settingKeys(providerId: string): { clientId: string; clientSecret: string } {
  return { clientId: `oauth.${providerId}.clientId`, clientSecret: `oauth.${providerId}.clientSecret` };
}

function envNames(provider: Provider, oauth: { clientIdEnv: string; clientSecretEnv: string }): { clientId: string; clientSecret: string } {
  return {
    clientId: envStr(oauth.clientIdEnv, envStr(`${provider.id.toUpperCase()}_CLIENT_ID`, "")),
    clientSecret: envStr(oauth.clientSecretEnv, envStr(`${provider.id.toUpperCase()}_CLIENT_SECRET`, "")),
  };
}

export function saveOAuthApp(providerId: string, app: OAuthApp): void {
  const keys = settingKeys(providerId);
  setSetting(keys.clientId, app.clientId.trim());
  if (app.clientSecret.trim().length === 0) setSetting(keys.clientSecret, "");
  else setSetting(keys.clientSecret, seal(app.clientSecret.trim(), loadOrCreateKey()));
}

export function getOAuthApp(provider: Provider): OAuthApp | null {
  const keys = settingKeys(provider.id);
  const storedId = getSetting(keys.clientId) ?? "";
  const storedSecret = getSetting(keys.clientSecret);
  const oauthConfig = provider.auth.kind === "oauth2" ? provider.auth.oauth : null;
  const env = oauthConfig ? envNames(provider, oauthConfig) : { clientId: "", clientSecret: "" };

  const clientId = storedId || env.clientId;
  let clientSecret = env.clientSecret;
  if (storedSecret) {
    try {
      clientSecret = openSealed(storedSecret, loadOrCreateKey()) ?? "";
    } catch {
      clientSecret = "";
    }
  }
  if (!clientId) return null;
  return { clientId, clientSecret };
}

export function oauthConfigured(provider: Provider): boolean {
  const app = getOAuthApp(provider);
  if (!app) return false;
  if (provider.auth.kind !== "oauth2") return true;
  if (provider.auth.oauth.tokenEndpointAuth === "none") return app.clientId.length > 0;
  return app.clientId.length > 0 && app.clientSecret.length > 0;
}

export function callbackUrl(providerId: string): string {
  const base = envStr("SB_PUBLIC_URL", appUrl()).replace(/\/+$/, "");
  return `${base}/api/v1/connectors/${providerId}/callback`;
}

export function redirectUriFor(providerId: string, override?: string | null): string {
  return override && override.length > 0 ? override : callbackUrl(providerId);
}

export type AuthorizeRequest = {
  provider: Provider;
  redirectUri: string;
  extraParams?: Record<string, string>;
};

/** Builds the consent URL plus the PKCE pair the callback will need. */
export function buildAuthorizeRequest(
  input: AuthorizeRequest,
  state: string,
): { url: string; pkce: PkcePair | null; scopes: string[] } {
  if (input.provider.auth.kind !== "oauth2") {
    throw new AppError("bad_request", `${input.provider.label} does not use OAuth.`);
  }
  const oauth = input.provider.auth.oauth;
  const app = getOAuthApp(input.provider);
  if (!app) {
    throw new AppError(
      "bad_request",
      `Chưa cấu hình OAuth app cho ${input.provider.label}. Điền Client ID/Secret trong mục Kết nối (xem docs/connectors.md).`,
    );
  }
  const pkce = oauth.pkce ? createPkcePair() : null;
  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", oauth.scopes.join(" "));
  url.searchParams.set("state", state);
  if (pkce) {
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(oauth.extraAuthParams ?? {})) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(input.extraParams ?? {})) url.searchParams.set(key, value);

  return { url: url.toString(), pkce, scopes: oauth.scopes };
}

export type CompleteOAuthInput = {
  provider: Provider;
  code: string;
  redirectUri: string;
  verifier: string;
  fetchImpl?: typeof fetch;
};

export async function completeOAuth(input: CompleteOAuthInput): Promise<OAuthTokens> {
  if (input.provider.auth.kind !== "oauth2") {
    throw new AppError("bad_request", `${input.provider.label} does not use OAuth.`);
  }
  const app = getOAuthApp(input.provider);
  if (!app) throw new AppError("bad_request", `Missing OAuth client credentials for ${input.provider.id}.`);

  const exchange = await exchangeCode({
    oauth: input.provider.auth.oauth,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    code: input.code,
    redirectUri: input.redirectUri,
    codeVerifier: input.verifier,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  return {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken ?? null,
    expiresAt: exchange.expiresAt ?? null,
    tokenType: exchange.tokenType ?? null,
    scope: exchange.scope ?? null,
  };
}

/** Returns a usable access token, refreshing it when the provider supports that. */
export async function ensureFreshToken(
  connectorId: string,
  provider: Provider,
  options: { fetchImpl?: typeof fetch; skewSeconds?: number } = {},
): Promise<{ accessToken: string; refreshed: boolean }> {
  const connector = getConnector(connectorId);
  if (!connector) throw new AppError("not_found", `Connector ${connectorId} not found`);
  const tokens = loadTokens(connectorId);
  if (!tokens?.accessToken) {
    throw new AppError(
      "unauthorized",
      connector.authKind === "token"
        ? `Chưa có token cho ${provider.label}. Dán token trong mục Kết nối.`
        : `Chưa kết nối ${provider.label}.`,
    );
  }

  if (provider.auth.kind !== "oauth2" || !isTokenExpired(tokens, options.skewSeconds ?? 120)) {
    return { accessToken: tokens.accessToken, refreshed: false };
  }
  if (!tokens.refreshToken) return { accessToken: tokens.accessToken, refreshed: false };

  const app = getOAuthApp(provider);
  if (!app) throw new AppError("bad_request", `Missing OAuth client credentials to refresh ${provider.label}.`);

  const refreshed = await refreshAccessToken({
    oauth: provider.auth.oauth,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    refreshToken: tokens.refreshToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const merged: OAuthTokens = {
    accessToken: refreshed.accessToken,
    // Providers often omit the refresh token on refresh; keep the previous one.
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken ?? null,
    expiresAt: refreshed.expiresAt ?? null,
    tokenType: refreshed.tokenType ?? tokens.tokenType ?? null,
    scope: refreshed.scope ?? tokens.scope ?? null,
  };
  saveTokens(connectorId, merged);
  updateConnectorState(connectorId, { lastStatus: "token refreshed" });
  return { accessToken: merged.accessToken, refreshed: true };
}
