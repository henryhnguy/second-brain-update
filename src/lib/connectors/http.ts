/**
 * Shared plumbing for connectors.
 *
 * Every connector goes through `requestJson` so timeouts, retries and error
 * mapping behave the same everywhere — and so a provider can be driven by a
 * mocked `fetch` handed in through `SyncContext`. The global `fetch` is never
 * touched here: the caller passes the implementation to use.
 *
 * Besides the request helpers this module carries the two cross-provider
 * utilities that every provider needs and that do not deserve a module of
 * their own: `normalizeLimit` (honouring `ctx.limit`) and `htmlToText` /
 * `decodeHtmlEntities` (turning HTML bodies into the plain text we store).
 */

import { AppError } from "../core/errors";
import { normalizeWhitespace } from "../core/text";
import type { HttpFetch } from "./types";

export type RequestJsonOptions = {
  /** Abort the request after this many milliseconds (default 20 000). */
  timeoutMs?: number;
  /** Retries after the first attempt; default 3 means at most 4 requests. */
  retries?: number;
  /** First backoff delay, doubled on every attempt (default 400 ms). */
  retryBaseMs?: number;
  /** Upper bound for a single backoff / `Retry-After` wait (default 20 000 ms). */
  retryMaxMs?: number;
  /** Cap on the response body we are willing to read, in bytes (default 1 MiB). */
  maxBytes?: number;
  /** Provider id used in error messages, e.g. `gmail`. */
  label?: string;
  /** External cancellation, combined with the internal timeout. */
  signal?: AbortSignal;
  /** Injected in tests so retries do not cost wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in `[0, 1)`; injected in tests for deterministic backoff. */
  random?: () => number;
};

/** A failed attempt: the mapped error plus whether the caller may retry. */
export type RequestFailure = {
  error: AppError;
  retryable: boolean;
  /** Delay demanded by `Retry-After`, in milliseconds. */
  retryAfterMs: number | null;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_RETRY_MAX_MS = 20_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const BODY_EXCERPT_CHARS = 400;

type AttemptResult<T> = { ok: true; value: T } | { ok: false; failure: RequestFailure };

type AttemptConfig = {
  timeoutMs: number;
  maxBytes: number;
  label: string;
  signal: AbortSignal | undefined;
};

/**
 * Performs one HTTP request and parses the JSON body.
 *
 * Retries `429`/`5xx` responses and network failures with exponential backoff
 * plus jitter, honouring `Retry-After` when the server sends it. Failures are
 * mapped to `AppError` with the HTTP status and a short body excerpt in
 * `details`, so callers can tell a revoked token (401) from a quota problem
 * (403/429) without re-parsing the provider payload.
 */
export async function requestJson<T>(
  fetchImpl: HttpFetch,
  url: string,
  init: RequestInit = {},
  opts: RequestJsonOptions = {},
): Promise<T> {
  const retries = Math.max(0, Math.trunc(opts.retries ?? DEFAULT_RETRIES));
  const sleep = opts.sleep ?? sleepMs;
  const random = opts.random ?? Math.random;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const label = opts.label ?? "request";
  const config: AttemptConfig = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    label,
    signal: opts.signal,
  };

  let lastError: AppError | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await attemptJson<T>(fetchImpl, url, init, config);
    if (result.ok) return result.value;
    lastError = result.failure.error;
    if (!result.failure.retryable || attempt === retries) throw result.failure.error;
    const delay =
      result.failure.retryAfterMs !== null
        ? Math.min(result.failure.retryAfterMs, retryMaxMs)
        : backoffDelay(attempt, retryBaseMs, retryMaxMs, random);
    await sleep(delay);
  }
  throw lastError ?? new AppError("upstream_error", `${label}: request failed`);
}

/**
 * Walks a paginated endpoint: fetches `firstUrl`, asks `next` for the following
 * URL and keeps going until it returns `null`, `maxPages` is reached, or
 * `onPage` returns `false`. Pages are returned in request order and the first
 * unfetched URL is handed back as `nextUrl` for use as a cursor.
 */
export async function pagedRequest<T>(
  fetchImpl: HttpFetch,
  firstUrl: string,
  init: RequestInit,
  opts: PagedRequestOptions<T>,
): Promise<PagedResult<T>> {
  const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? 10));
  const pages: T[] = [];
  let url: string | null = firstUrl;
  let nextUrl: string | null = null;
  let requests = 0;
  let truncated = false;

  while (url !== null) {
    const page = await requestJson<T>(fetchImpl, url, init, opts);
    requests += 1;
    pages.push(page);
    const index = pages.length - 1;
    const next = opts.next(page, { url, index });
    const keepGoing = opts.onPage?.(page, { url, index }) ?? true;
    if (keepGoing === false) {
      truncated = next !== null;
      nextUrl = next;
      break;
    }
    if (next === null) {
      nextUrl = null;
      break;
    }
    if (pages.length >= maxPages) {
      truncated = true;
      nextUrl = next;
      break;
    }
    url = next;
  }

  return { pages, nextUrl, requests, truncated };
}

export type PagedRequestOptions<T> = RequestJsonOptions & {
  /** Maximum pages to fetch (default 10). */
  maxPages?: number;
  /** URL of the next page, or `null` when `page` was the last one. */
  next: (page: T, meta: { url: string; index: number }) => string | null;
  /** Called after every page; return `false` to stop following `next`. */
  onPage?: (page: T, meta: { url: string; index: number }) => boolean | void;
};

export type PagedResult<T> = {
  pages: T[];
  /** First page that was not fetched, if any; usable as a cursor. */
  nextUrl: string | null;
  requests: number;
  truncated: boolean;
};

/**
 * Clamps `ctx.limit` into a sane request size. The framework hands providers a
 * raw number; providers must never ask a remote service for an unbounded page.
 */
export function normalizeLimit(value: number, fallback: number, max: number): number {
  const requested = Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  return Math.max(1, Math.min(requested, max));
}

/**
 * Converts an HTML body to the plain text we store.
 *
 * Script/style content, comments and tags are dropped, block level tags become
 * line breaks and the handful of entities these APIs actually emit are decoded.
 */
export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutNoise
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ");
  const withoutTags = withBreaks.replace(/<[^>]*>/g, " ");
  const text = decodeHtmlEntities(withoutTags)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n");
  return normalizeWhitespace(text);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  rsquo: "’",
  middot: "·",
};

/** Decodes the named and numeric HTML entities that appear in API payloads. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity.startsWith("#x") || entity.startsWith("#X");
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Resolves `host/path` for error messages; never throws on a malformed URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function attemptJson<T>(
  fetchImpl: HttpFetch,
  url: string,
  init: RequestInit,
  config: AttemptConfig,
): Promise<AttemptResult<T>> {
  const timed = createTimedSignal(config.timeoutMs, config.signal);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: timed.signal });
    } catch (error) {
      return { ok: false, failure: networkFailure(error, url, config, timed.timedOut()) };
    }

    let body: string;
    try {
      body = await readBodyText(response, config.maxBytes);
    } catch (error) {
      const mapped =
        error instanceof AppError
          ? error
          : new AppError("upstream_error", `${config.label}: could not read the response body from ${hostOf(url)}`, {
              details: { url, provider: config.label },
              cause: error,
            });
      return { ok: false, failure: { error: mapped, retryable: false, retryAfterMs: null } };
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        return { ok: true, value: parseJsonBody<T>(body, url, config.label) };
      } catch (error) {
        const mapped = error instanceof AppError ? error : new AppError("upstream_error", `${config.label}: invalid JSON from ${hostOf(url)}`, { cause: error });
        return { ok: false, failure: { error: mapped, retryable: false, retryAfterMs: null } };
      }
    }
    return { ok: false, failure: httpFailure(response, body, url, config.label) };
  } finally {
    timed.dispose();
  }
}

type TimedSignal = {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
};

/** Timeout signal combined with an optional caller signal; always disposed. */
function createTimedSignal(timeoutMs: number, external: AbortSignal | undefined): TimedSignal {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => {
    controller.abort(external?.reason);
  };
  if (external) {
    if (external.aborted) forwardAbort();
    else external.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function readBodyText(response: Response, maxBytes: number): Promise<string> {
  let bytes: Uint8Array;
  if (typeof response.arrayBuffer === "function") {
    bytes = new Uint8Array(await response.arrayBuffer());
  } else if (typeof response.text === "function") {
    bytes = new TextEncoder().encode(await response.text());
  } else {
    return "";
  }
  if (bytes.byteLength > maxBytes) {
    throw new AppError("upstream_error", `Response body of ${bytes.byteLength} bytes exceeds maxBytes (${maxBytes})`, {
      details: { bytes: bytes.byteLength, maxBytes },
    });
  }
  return new TextDecoder().decode(bytes);
}

function parseJsonBody<T>(body: string, url: string, label: string): T {
  if (body.trim().length === 0) return asJson<T>({});
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new AppError("upstream_error", `${label}: response from ${hostOf(url)} was not valid JSON`, {
      details: { url, body: excerpt(body) },
      cause: error,
    });
  }
}

/** Narrow escape hatch: `{} as T` is rejected by TS for unconstrained `T`. */
function asJson<T>(value: unknown): T {
  return value as T;
}

function networkFailure(error: unknown, url: string, config: AttemptConfig, timedOut: boolean): RequestFailure {
  const details: Record<string, unknown> = { url, provider: config.label };
  if (error instanceof AppError) return { error, retryable: false, retryAfterMs: null };
  if (timedOut) {
    return {
      error: new AppError("upstream_error", `${config.label}: request to ${hostOf(url)} timed out after ${config.timeoutMs}ms`, {
        details: { ...details, timeoutMs: config.timeoutMs, retryable: true },
        cause: error,
        retryable: true,
      }),
      retryable: true,
      retryAfterMs: null,
    };
  }
  if (isAbortError(error)) {
    return {
      error: new AppError("upstream_error", `${config.label}: request to ${hostOf(url)} was aborted`, {
        details,
        cause: error,
        retryable: false,
      }),
      retryable: false,
      retryAfterMs: null,
    };
  }
  return {
    error: new AppError("upstream_error", `${config.label}: network error contacting ${hostOf(url)}: ${messageOf(error)}`, {
      details: { ...details, retryable: true },
      cause: error,
      retryable: true,
    }),
    retryable: true,
    retryAfterMs: null,
  };
}

function httpFailure(response: Response, body: string, url: string, label: string): RequestFailure {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(readHeader(response, "retry-after"));
  const details: Record<string, unknown> = {
    status,
    url,
    provider: label,
    body: excerpt(body),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  };

  if (status === 401) {
    return {
      error: new AppError("unauthorized", `${label}: access token rejected (401) by ${hostOf(url)}`, { details }),
      retryable: false,
      retryAfterMs: null,
    };
  }
  if (status === 403) {
    if (retryAfterMs !== null || looksRateLimited(body)) {
      return {
        error: new AppError("rate_limited", `${label}: rate limited (403) by ${hostOf(url)}`, { details, retryable: true }),
        retryable: true,
        retryAfterMs,
      };
    }
    return {
      error: new AppError("unauthorized", `${label}: access denied (403) by ${hostOf(url)}`, { details }),
      retryable: false,
      retryAfterMs: null,
    };
  }
  if (status === 429) {
    return {
      error: new AppError("rate_limited", `${label}: rate limited (429) by ${hostOf(url)}`, { details, retryable: true }),
      retryable: true,
      retryAfterMs,
    };
  }
  if (status >= 500 || status === 408 || status === 425) {
    return {
      error: new AppError("upstream_error", `${label}: ${hostOf(url)} returned ${status}`, { details, retryable: true }),
      retryable: true,
      retryAfterMs,
    };
  }
  return {
    error: new AppError("upstream_error", `${label}: ${hostOf(url)} returned ${status}`, { details, retryable: false }),
    retryable: false,
    retryAfterMs: null,
  };
}

function looksRateLimited(body: string): boolean {
  return /(rate ?limit|ratelimited|too many requests|quota|userRateLimitExceeded)/i.test(body);
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function readHeader(response: Response, name: string): string | null {
  const headers = response.headers;
  if (!headers || typeof headers.get !== "function") return null;
  return headers.get(name);
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

function excerpt(body: string, max = BODY_EXCERPT_CHARS): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
