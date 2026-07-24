"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Button, Toast, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { formatRelativeTime } from "@/lib/timeFormat";
import "./systems.css";

// Logs tab: session-events timeline + the action-audit table (frozen nest
// contract `/api/admin/bot/session/events` + `/api/admin/bot/actions/audit`),
// reached through this app's own no-store proxy routes. Fetches once on
// mount (elevated-gated) with a manual Refresh button — these are
// low-churn diagnostic logs, not something that needs a standing poll like
// the Chats tab's live thread.
const HIGHLIGHT_STATUSES = new Set(["FAILED", "STOPPED"]);

interface BotSessionEvent {
  status: string;
  ts: number;
}

// Audit entries are rendered generically — the shape is intentionally loose.
type BotActionAuditEntry = Record<string, unknown>;

export function LogsTab({ elevated }: { elevated: boolean }) {
  const [events, setEvents] = useState<BotSessionEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | undefined>();
  const [audit, setAudit] = useState<{ enabled: boolean; entries: BotActionAuditEntry[] } | null>(null);
  const [auditError, setAuditError] = useState<string | undefined>();

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/session/events", { cache: "no-store" });
      const body = (await res.json()) as { events: BotSessionEvent[] | null; error?: string };
      if (!res.ok || body.events == null) {
        setEventsError(body.error ?? "Could not load session events.");
        return;
      }
      setEvents(body.events);
      setEventsError(undefined);
    } catch {
      setEventsError("Could not reach the bot admin proxy.");
    }
  }, []);

  const fetchAudit = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bot/actions/audit", { cache: "no-store" });
      const body = (await res.json()) as { enabled: boolean; entries: BotActionAuditEntry[] | null; error?: string };
      if (!res.ok || body.entries == null) {
        setAuditError(body.error ?? "Could not load the action audit.");
        return;
      }
      setAudit({ enabled: body.enabled, entries: body.entries });
      setAuditError(undefined);
    } catch {
      setAuditError("Could not reach the bot admin proxy.");
    }
  }, []);

  useEffect(() => {
    if (!elevated) return;
    fetchEvents();
    fetchAudit();
  }, [elevated, fetchEvents, fetchAudit]);

  if (!elevated) {
    return (
      <Card title="Logs">
        <EmptyNote>Session events and the action audit are limited to superadmins/owners.</EmptyNote>
      </Card>
    );
  }

  function refresh() {
    fetchEvents();
    fetchAudit();
  }

  // Contract returns oldest-first; the UI shows newest-first.
  const newestFirst = events ? [...events].reverse() : null;
  const cols = audit ? auditColumns(audit.entries) : [];

  return (
    <>
      <Card
        title="Session events"
        headerRight={
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            Refresh
          </Button>
        }
      >
        {eventsError && <Toast message={eventsError} />}
        {newestFirst == null ? (
          <EmptyNote>Loading session events…</EmptyNote>
        ) : newestFirst.length === 0 ? (
          <EmptyNote>No session events recorded yet.</EmptyNote>
        ) : (
          <ul className="bot-event-list">
            {newestFirst.map((ev, i) => (
              <li
                key={`${ev.ts}-${i}`}
                className={`bot-event-list__item${HIGHLIGHT_STATUSES.has(ev.status) ? " bot-event-list__item--alert" : ""}`}
              >
                <StatusBadge label={ev.status} />
                <span className="bot-event-list__time">{formatRelativeTime(ev.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Action audit">
          {auditError && <Toast message={auditError} />}
          {audit == null ? (
            <EmptyNote>Loading the action audit…</EmptyNote>
          ) : !audit.enabled ? (
            <EmptyNote>Action audit logging isn&apos;t enabled for this bot.</EmptyNote>
          ) : audit.entries.length === 0 ? (
            <EmptyNote>No audited actions yet.</EmptyNote>
          ) : (
            <div className="lux-table" style={{ ["--lux-tcols" as string]: cols.map(() => "1fr").join(" ") }}>
              <div className="lux-table__head">
                {cols.map((c) => (
                  <Eyebrow key={c} style={{ fontSize: 10, opacity: 0.5 }}>
                    {c}
                  </Eyebrow>
                ))}
              </div>
              {audit.entries.map((row, i) => (
                <div className="lux-table__row" key={i}>
                  {cols.map((c) => (
                    <span key={c} style={{ font: "400 13px var(--font-body)" }}>
                      {stringifyCell(row[c])}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// Union of keys across all entries — keeps the table stable even when rows
// have slightly different shapes (a generic renderer, per the doc).
function auditColumns(entries: BotActionAuditEntry[]): string[] {
  const cols = new Set<string>();
  for (const e of entries) Object.keys(e).forEach((k) => cols.add(k));
  return Array.from(cols);
}

function stringifyCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
