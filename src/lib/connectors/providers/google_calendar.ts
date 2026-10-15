/**
 * Google Calendar connector (read-only).
 *
 * `events.list` is asked for single events (`singleEvents=true`) ordered by
 * start time, so a recurring series arrives as one document per occurrence.
 * The window starts at the previous successful sync (`ctx.since`) — or a fixed
 * lookback on the very first run — and ends a few months ahead, so the memory
 * holds both what happened and what is coming up.
 *
 * Cursor: `{ pageToken, syncToken }` (read with `cursorString`). `pageToken`
 * continues a long listing; once a listing completes Google hands back a sync
 * token, which is stored instead and used for cheap delta listings afterwards.
 * Google expires sync tokens (410 GONE): that is handled by falling back to a
 * windowed listing. A delta listing must not carry `timeMin`/`timeMax` or
 * `orderBy`, because Google rejects that combination.
 */

import { AppError } from "../../core/errors";
import { normalizeWhitespace } from "../../core/text";
import { addDays, daysAgoIso, toIso } from "../../core/time";
import { normalizeLimit, requestJson } from "../http";
import type { ConnectorDoc, OAuthConfig, Provider, SyncContext, SyncCursor, SyncPage } from "../types";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const DEFAULT_LIMIT = 50;
const MAX_RESULTS = 250;
const DEFAULT_LOOKBACK_DAYS = 30;
const LOOKAHEAD_DAYS = 180;
const MAX_ATTENDEES = 50;

const CALENDAR_OAUTH: OAuthConfig = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/userinfo.email"],
  pkce: true,
  tokenEndpointAuth: "body_client_secret",
  clientIdEnv: "SB_GOOGLE_CALENDAR_CLIENT_ID",
  clientSecretEnv: "SB_GOOGLE_CALENDAR_CLIENT_SECRET",
  // `offline` + `consent` are what make Google hand back a refresh token.
  extraAuthParams: { access_type: "offline", prompt: "consent" },
};

type CalendarTime = { date?: string; dateTime?: string; timeZone?: string };

type CalendarAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
};

type CalendarEvent = {
  id?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  created?: string;
  updated?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: CalendarAttendee[];
  recurringEventId?: string;
  hangoutLink?: string;
};

type CalendarListResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
  summary?: string;
  timeZone?: string;
};

export const googleCalendarProvider: Provider = {
  id: "google_calendar",
  label: "Google Calendar",
  description: "Đồng bộ sự kiện Google Calendar (chỉ đọc) về bộ nhớ cá nhân.",
  category: "calendar",
  docsUrl: "https://developers.google.com/calendar/api/v3/reference/events/list",
  auth: {
    kind: "oauth2",
    oauth: CALENDAR_OAUTH,
    helpUrl: "https://console.cloud.google.com/apis/credentials",
  },
  defaultConfig: { calendarId: "primary" },
  initialLookbackDays: DEFAULT_LOOKBACK_DAYS,
  syncPage,
};

/** One page of events, plus where the next run should resume. */
async function syncPage(ctx: SyncContext): Promise<SyncPage> {
  const limit = normalizeLimit(ctx.limit, DEFAULT_LIMIT, MAX_RESULTS);
  const calendarId = configString(ctx, "calendarId") ?? credentialString(ctx, "calendarId") ?? "primary";
  const pageToken = cursorString(ctx, "pageToken");
  const syncToken = cursorString(ctx, "syncToken");
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

  let payload: CalendarListResponse;
  try {
    payload = await calendarRequest<CalendarListResponse>(ctx, `${base}?${buildQuery(ctx, limit, pageToken, syncToken)}`);
  } catch (error) {
    // An expired sync token is normal, not a failure: rebuild the window once.
    if (syncToken === null || upstreamStatus(error) !== 410) throw error;
    ctx.logger("google_calendar: sync token expired, falling back to a time window", { calendarId });
    payload = await calendarRequest<CalendarListResponse>(ctx, `${base}?${buildQuery(ctx, limit, pageToken, null)}`);
  }

  // Cancelled events are tombstones for delta sync clients; there is nothing to store.
  const events = (payload.items ?? []).filter((event) => event.status !== "cancelled");
  const docs: ConnectorDoc[] = [];
  for (const event of events) {
    if (docs.length >= limit) break;
    const doc = eventToDoc(event);
    if (doc !== null) docs.push(doc);
  }

  const nextPage = firstNonEmpty(payload.nextPageToken);
  const nextDelta = firstNonEmpty(payload.nextSyncToken);
  const cursor: SyncCursor = {};
  if (nextPage !== null) cursor["pageToken"] = nextPage;
  else if (nextDelta !== null) cursor["syncToken"] = nextDelta;
  ctx.logger("google_calendar: listed events", { calendarId, listed: events.length, fetched: docs.length });

  return {
    docs,
    cursor,
    hasMore: nextPage !== null,
    stats: { listed: events.length, fetched: docs.length },
  };
}

/**
 * Query string for one `events.list` call.
 *
 * A delta listing carries the sync token on its own, because Google rejects
 * `timeMin`/`timeMax`/`orderBy` next to `syncToken`; a windowed listing is
 * ordered by start time so pages arrive in a predictable order.
 */
function buildQuery(
  ctx: SyncContext,
  limit: number,
  pageToken: string | null,
  syncToken: string | null,
): URLSearchParams {
  const params = new URLSearchParams({
    maxResults: String(limit),
    singleEvents: "true",
    showDeleted: "false",
  });
  if (pageToken !== null) params.set("pageToken", pageToken);
  if (syncToken !== null) {
    params.set("syncToken", syncToken);
    return params;
  }
  params.set("orderBy", "startTime");
  params.set("timeMin", ctx.since ?? daysAgoIso(DEFAULT_LOOKBACK_DAYS));
  const until = toIso(addDays(new Date(), LOOKAHEAD_DAYS));
  if (until !== null) params.set("timeMax", until);
  return params;
}

async function calendarRequest<T>(ctx: SyncContext, url: string): Promise<T> {
  return requestJson<T>(ctx.fetchImpl, url, { method: "GET", headers: authHeaders(ctx.accessToken) }, { label: "google_calendar" });
}

/** Maps one event to a document; events without an id cannot be de-duplicated. */
function eventToDoc(event: CalendarEvent): ConnectorDoc | null {
  const id = firstNonEmpty(event.id);
  if (id === null) return null;
  const title = firstNonEmpty(event.summary) ?? "(no title)";
  const start = formatEventTime(event.start);
  const end = formatEventTime(event.end);
  const attendees = formatAttendees(event.attendees);

  const lines: string[] = [title];
  if (start !== null) lines.push(`When: ${start}${end === null ? "" : ` -> ${end}`}`);
  const location = firstNonEmpty(event.location);
  if (location !== null) lines.push(`Where: ${normalizeWhitespace(location)}`);
  if (attendees !== null) lines.push(`Who: ${attendees}`);
  const description = normalizeWhitespace(event.description ?? "");
  if (description.length > 0) lines.push(description);

  return {
    externalId: id,
    title,
    text: lines.join("\n"),
    url: firstNonEmpty(event.htmlLink),
    author: organizerLabel(event),
    createdAt: toIso(event.created ?? null),
    updatedAt: toIso(event.updated ?? null),
    mime: "text/calendar",
    meta: {
      status: event.status ?? null,
      start,
      end,
      location,
      attendeeCount: event.attendees?.length ?? 0,
      recurringEventId: event.recurringEventId ?? null,
      hangoutLink: event.hangoutLink ?? null,
    },
  };
}

/** RFC3339 timestamps are normalised to UTC; all-day events keep their date. */
function formatEventTime(value: CalendarTime | undefined): string | null {
  if (!value) return null;
  const dateTime = firstNonEmpty(value.dateTime);
  if (dateTime !== null) return toIso(dateTime) ?? dateTime;
  const date = firstNonEmpty(value.date);
  return date === null ? null : `${date} (all day)`;
}

function formatAttendees(attendees: CalendarAttendee[] | undefined): string | null {
  if (!attendees || attendees.length === 0) return null;
  const parts: string[] = [];
  for (const attendee of attendees.slice(0, MAX_ATTENDEES)) {
    const label = firstNonEmpty(attendee.displayName) ?? firstNonEmpty(attendee.email);
    if (label === null) continue;
    const response = firstNonEmpty(attendee.responseStatus);
    parts.push(response === null ? label : `${label} (${response})`);
  }
  if (attendees.length > MAX_ATTENDEES) parts.push(`+${attendees.length - MAX_ATTENDEES} more`);
  return parts.length === 0 ? null : parts.join(", ");
}

function organizerLabel(event: CalendarEvent): string | null {
  const organizer = event.organizer;
  if (!organizer) return null;
  return firstNonEmpty(organizer.displayName) ?? firstNonEmpty(organizer.email);
}

/** Upstream HTTP status from the error details written by `requestJson`. */
function upstreamStatus(error: unknown): number | null {
  if (!(error instanceof AppError)) return null;
  const status = error.details?.["status"];
  return typeof status === "number" ? status : null;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
}

function cursorString(ctx: SyncContext, key: string): string | null {
  const value = ctx.cursor[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function configString(ctx: SyncContext, key: string): string | null {
  const value = ctx.config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function credentialString(ctx: SyncContext, key: string): string | null {
  const value = ctx.credentials[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
