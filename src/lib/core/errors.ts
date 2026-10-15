export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "unsupported"
  | "rate_limited"
  | "upstream_error"
  | "ai_not_configured"
  | "storage_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  unsupported: 415,
  rate_limited: 429,
  upstream_error: 502,
  ai_not_configured: 409,
  storage_error: 500,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
    this.retryable = options.retryable ?? (code === "rate_limited" || code === "upstream_error");
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("bad_request", message, { details });
}

export function notFound(what: string): AppError {
  return new AppError("not_found", `${what} not found`);
}

export function unauthorized(message = "Missing or invalid credentials"): AppError {
  return new AppError("unauthorized", message);
}

export function aiNotConfigured(): AppError {
  return new AppError(
    "ai_not_configured",
    "No AI provider configured. Add a base URL / API key in Settings, or set SB_AI_API_KEY, then retry.",
  );
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError("internal", error.message, { cause: error });
  }
  return new AppError("internal", String(error));
}

export type ApiErrorBody = {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
};

export function apiErrorBody(error: AppError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
