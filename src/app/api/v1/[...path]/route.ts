import { assertAuthorized } from "@/lib/api/auth";
import { handleApi, type ApiContext, type ApiResult } from "@/lib/api/router";
import { toAppError, apiErrorBody } from "@/lib/core/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path?: string[] }> };

/**
 * Single entry point for `/api/v1/**`. The route table lives in
 * `src/lib/api/router.ts` so the CLI and the UI share one implementation.
 */
function toResponse(result: ApiResult): Response {
  if (result.kind === "json") {
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (result.kind === "stream") {
    return new Response(result.stream, { status: result.status, headers: result.headers });
  }
  return new Response(null, { status: result.status, headers: { location: result.location } });
}

/** The OAuth callback is opened by the browser from the provider's domain. */
function isBrowserCallback(method: string, segments: string[]): boolean {
  return method === "GET" && segments.length === 3 && segments[0] === "connectors" && segments[2] === "callback";
}

async function dispatch(request: Request, context: RouteContext): Promise<Response> {
  const resolved = await context.params;
  const segments = (resolved.path ?? []).map((part) => decodeURIComponent(part));
  const url = new URL(request.url);

  let jsonParsed = false;
  let jsonValue: unknown = null;
  let formValue: FormData | null = null;

  const apiContext: ApiContext = {
    method: request.method.toUpperCase(),
    segments,
    query: url.searchParams,
    headers: request.headers,
    remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    auth: { mode: "loopback" },
    json: async () => {
      if (!jsonParsed) {
        jsonParsed = true;
        jsonValue = await request.json().catch(() => null);
      }
      return jsonValue;
    },
    form: async () => {
      if (!formValue) formValue = await request.formData();
      return formValue;
    },
  };

  try {
    if (!isBrowserCallback(apiContext.method, segments)) {
      apiContext.auth = assertAuthorized({
        headers: request.headers,
        remoteAddress: apiContext.remoteAddress,
      });
    }
    return toResponse(await handleApi(apiContext));
  } catch (error) {
    const normalized = toAppError(error);
    return new Response(JSON.stringify(apiErrorBody(normalized)), {
      status: normalized.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}
