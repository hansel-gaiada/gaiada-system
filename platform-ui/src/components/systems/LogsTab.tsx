"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Button, Toast, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { Paginator, usePagination } from "./Paginator";
import { useDebouncedValue } from "./useDebouncedValue";
import { formatRelativeTime } from "@/lib/timeFormat";
import "./systems.css";
import "@/components/forms/forms.css";

// Logs tab: session-events timeline + the action-audit table (frozen nest
// contract `/api/admin/bot/session/events` + `/api/admin/bot/actions/audit`),
// reached through this app's own no-store proxy routes. Fetches once on
// mount (elevated-gated) with a manual Refresh button — these are
// low-churn diagnostic logs, not something that needs a standing poll like
// the Chats tab's live thread.
//
// Both lists are client-side searched + paginated (30/page) below: the fetch above already
// returns the full set in one response, so this is purely a "what's rendered" concern — no new
// request, no backend change.
const HIGHLIGHT_STATUSES = new Set(["FAILED", "STOPPED"]);
const PAGE_SIZE = 30;

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

  // -- Session events: search + pagination. --
  const [eventsQueryInput, setEventsQueryInput] = useState("");
  const eventsQuery = useDebouncedValue(eventsQueryInput, 300);
  const trimmedEventsQuery = eventsQuery.trim().toLowerCase();
  // Contract returns oldest-first; the UI shows newest-first.
  const newestFirst = events ? [...events].reverse() : null;
  const filteredEvents = trimmedEventsQuery
    ? (newestFirst ?? []).filter((ev) => ev.status.toLowerCase().includes(trimmedEventsQuery))
    : (newestFirst ?? []);
  const eventsPaging = usePagination(filteredEvents, PAGE_SIZE, trimmedEventsQuery);

  // -- Action audit: search + pagination. --
  const [auditQueryInput, setAuditQueryInput] = useState("");
  const auditQuery = useDebouncedValue(auditQueryInput, 300);
  const trimmedAuditQuery = auditQuery.trim().toLowerCase();
  const auditCols = audit ? auditColumns(audit.entries) : [];
  const filteredAuditEntries = trimmedAuditQuery
    ? (audit?.entries ?? []).filter((row) => rowSearchText(row, auditCols).includes(trimmedAuditQuery))
    : (audit?.entries ?? []);
  const auditPaging = usePagination(filteredAuditEntries, PAGE_SIZE, trimmedAuditQuery);

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
        {newestFirst == null && eventsError ? (
          // Same trap as the Chats thread: a failed fetch leaves the list null, and without
          // this branch the panel claims to be loading forever.
          <EmptyNote>Session events couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
        ) : newestFirst == null ? (
          <EmptyNote>Loading session events…</EmptyNote>
        ) : newestFirst.length === 0 ? (
          <EmptyNote>No session events recorded yet.</EmptyNote>
        ) : (
          <>
            <div className="sys-searchable__toolbar">
              <label className="sys-searchable__label">
                <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Search session events</Eyebrow>
                <input
                  type="search"
                  className="lux-field__control"
                  aria-label="Search session events"
                  placeholder="Filter by status…"
                  value={eventsQueryInput}
                  onChange={(e) => setEventsQueryInput(e.target.value)}
                />
              </label>
              <span className="sys-searchable__count">
                {trimmedEventsQuery ? `${filteredEvents.length} of ${newestFirst.length}` : `${newestFirst.length}`}
              </span>
            </div>
            {filteredEvents.length === 0 ? (
              <EmptyNote>No session events match &ldquo;{eventsQuery.trim()}&rdquo;.</EmptyNote>
            ) : (
              <>
                <ul className="bot-event-list">
                  {eventsPaging.pageItems.map((ev, i) => (
                    <li
                      key={`${ev.ts}-${i}`}
                      className={`bot-event-list__item${HIGHLIGHT_STATUSES.has(ev.status) ? " bot-event-list__item--alert" : ""}`}
                    >
                      <StatusBadge label={ev.status} />
                      <span className="bot-event-list__time">{formatRelativeTime(ev.ts)}</span>
                    </li>
                  ))}
                </ul>
                <Paginator
                  page={eventsPaging.page}
                  pageCount={eventsPaging.pageCount}
                  rangeStart={eventsPaging.rangeStart}
                  rangeEnd={eventsPaging.rangeEnd}
                  total={eventsPaging.total}
                  onPageChange={eventsPaging.setPage}
                />
              </>
            )}
          </>
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Action audit">
          {auditError && <Toast message={auditError} />}
          {audit == null && auditError ? (
            <EmptyNote>The action audit couldn&apos;t be loaded — see the error above, then Refresh.</EmptyNote>
          ) : audit == null ? (
            <EmptyNote>Loading the action audit…</EmptyNote>
          ) : !audit.enabled ? (
            <EmptyNote>Action audit logging isn&apos;t enabled for this bot.</EmptyNote>
          ) : audit.entries.length === 0 ? (
            /* An empty audit is the normal state, not a fault — say what would fill it so it
               doesn't read as a broken panel. */
            <EmptyNote>
              No audited actions yet. Entries appear when someone asks the bot to perform an
              action (adding or removing a group member, promoting an admin, renaming a group) —
              including attempts that are denied or need step-up. Ordinary messages and digests
              aren&apos;t audited here.
            </EmptyNote>
          ) : (
            <>
              <div className="sys-searchable__toolbar">
                <label className="sys-searchable__label">
                  <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Search action audit</Eyebrow>
                  <input
                    type="search"
                    className="lux-field__control"
                    aria-label="Search action audit"
                    placeholder="Filter across every column…"
                    value={auditQueryInput}
                    onChange={(e) => setAuditQueryInput(e.target.value)}
                  />
                </label>
                <span className="sys-searchable__count">
                  {trimmedAuditQuery
                    ? `${filteredAuditEntries.length} of ${audit.entries.length}`
                    : `${audit.entries.length}`}
                </span>
              </div>
              {filteredAuditEntries.length === 0 ? (
                <EmptyNote>No audit entries match &ldquo;{auditQuery.trim()}&rdquo;.</EmptyNote>
              ) : (
                <>
                  <div className="lux-table" style={{ ["--lux-tcols" as string]: auditCols.map(() => "1fr").join(" ") }}>
                    <div className="lux-table__head">
                      {auditCols.map((c) => (
                        <Eyebrow key={c} style={{ fontSize: 10, opacity: 0.5 }}>
                          {c}
                        </Eyebrow>
                      ))}
                    </div>
                    {auditPaging.pageItems.map((row, i) => (
                      <div className="lux-table__row" key={i}>
                        {auditCols.map((c) => (
                          <span key={c} style={{ font: "400 13px var(--font-body)" }}>
                            {stringifyCell(row[c])}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                  <Paginator
                    page={auditPaging.page}
                    pageCount={auditPaging.pageCount}
                    rangeStart={auditPaging.rangeStart}
                    rangeEnd={auditPaging.rangeEnd}
                    total={auditPaging.total}
                    onPageChange={auditPaging.setPage}
                  />
                </>
              )}
            </>
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

// Full-row haystack for the action-audit search box — every column's stringified value, lowercased
// and joined, so a search for a name/action/id matches regardless of which column it lives in.
function rowSearchText(row: BotActionAuditEntry, cols: string[]): string {
  return cols
    .map((c) => stringifyCell(row[c]))
    .join(" ")
    .toLowerCase();
}
