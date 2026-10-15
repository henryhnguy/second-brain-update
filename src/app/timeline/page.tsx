"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge, Card, CardTitle, EmptyState, Notice, Spinner, api } from "@/components/ui";

type ActivityEvent = {
  id: string;
  at: string;
  kind: string;
  title: string;
  documentId: string | null;
  detail: Record<string, unknown>;
};

type DayBucket = { day: string; count: number; kinds: Record<string, number> };

export default function TimelinePage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [days, setDays] = useState<DayBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eventResult, dayResult] = await Promise.all([
        api<{ events: ActivityEvent[] }>("/api/v1/events?limit=120"),
        api<{ days: DayBucket[] }>("/api/v1/events/timeline?days=60"),
      ]);
      setEvents(eventResult.events);
      setDays(dayResult.days);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const max = days.reduce((peak, day) => Math.max(peak, day.count), 1);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Dòng thời gian</h1>
        <p className="text-sm text-muted">Mọi thứ bạn đã lưu, theo thứ tự thời gian — kèm mật độ hoạt động 60 ngày.</p>
      </header>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <Card>
        <CardTitle hint={`${days.length} ngày có hoạt động`}>Mật độ theo ngày</CardTitle>
        {loading && days.length === 0 ? (
          <Spinner />
        ) : days.length === 0 ? (
          <p className="text-xs text-muted">Chưa có hoạt động nào được ghi lại.</p>
        ) : (
          <div className="flex h-24 items-end gap-1">
            {days
              .slice()
              .reverse()
              .map((day) => (
                <div key={day.day} className="group relative flex-1" title={`${day.day}: ${day.count}`}>
                  <div
                    className="w-full rounded-t bg-accent/60 transition group-hover:bg-accent"
                    style={{ height: `${Math.max(4, (day.count / max) * 90)}px` }}
                  />
                </div>
              ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Cột cao nhất: {max} sự kiện/ngày. Sự kiện được ghi tự động khi nạp tài liệu, đồng bộ connector, chạy play.
        </p>
      </Card>

      {loading && events.length === 0 ? (
        <Spinner />
      ) : events.length === 0 ? (
        <EmptyState title="Chưa có sự kiện" hint="Nạp một tệp hoặc đồng bộ một thư mục để bắt đầu dòng thời gian." />
      ) : (
        <ol className="relative space-y-3 border-l border-line pl-4">
          {events.map((event) => (
            <li key={event.id} className="relative">
              <span className="absolute -left-[1.42rem] top-1.5 h-2 w-2 rounded-full bg-accent/70" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{event.at.slice(0, 16).replace("T", " ")}</span>
                <Badge tone="accent">{event.kind}</Badge>
                {event.documentId ? (
                  <Link href={`/library/${event.documentId}`} className="text-sm hover:underline">
                    {event.title}
                  </Link>
                ) : (
                  <span className="text-sm">{event.title}</span>
                )}
              </div>
              {Object.keys(event.detail).length > 0 ? (
                <p className="mt-0.5 text-[11px] text-muted">
                  {Object.entries(event.detail)
                    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
