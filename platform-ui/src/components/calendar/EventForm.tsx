"use client";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import type { UnitChoice } from "@/lib/deptCalendar";
import {
  BUSY_PEOPLE_MAX, busyClashes, busyDayWindow, busyText, validateEventForm,
  type BusyPerson, type EventActionResult, type EventFormInput, type LoadBusy,
} from "@/lib/calendarEvents";
import "@/components/forms/forms.css";
import "./calendar.css";

// DW-8g: the one form for scheduling a meeting (create) and editing an event. Controlled, because the checks are the
// pure `validateEventForm` (the same sentences the tests pin) and run before any round trip. Dates and times are read
// in the DISPLAY zone, which the form says in words, so nobody has to guess which clock they are typing.
//
// The actions are passed in (not imported) so a test can drive the form with a mock, and so the page decides which
// event and which company a save belongs to.
//
// DW-8o (§47.4, DW-D28): with `loadBusy`, a timed event, a picked day and at least one person, the form shows the chosen
// people's busy TIMES for that day ("Busy that day"), in the display zone, and calls out a clash with the chosen time in
// words. Times only: the answer carries no title, place or organizer. A failed or unknown read says so, never "all free".

export interface PickMember { id: string; name: string }
export interface PickClient { id: string; name: string }
export interface PickProject { id: string; name: string; clientId: string | null }

export type SaveEventAction = (input: EventFormInput, names: Record<string, string>) => Promise<EventActionResult>;

export function EventForm({
  mode, initial, members, clients, projects, linksUnavailable = false, units = [], canRecord, hiddenPersonId, viewerId, zoneLabel, save, cancelHref, loadBusy,
}: {
  mode: "create" | "edit";
  initial: EventFormInput;
  /** The company's people (`GET /:t/members`). */
  members: PickMember[];
  clients: PickClient[];
  projects: PickProject[];
  /** The client or project list could not be read: say so, so empty pickers never read as "there are none". */
  linksUnavailable?: boolean;
  /** DW-10c-2 (BFF §59.3): the departments the person may share an event with, each offered as "My department: <unit>" in the
   *  visibility select. A mirror: the server narrows every write (403 outside the person's reporting line). */
  units?: UnitChoice[];
  /** The company has the Meetings row: only then is "Record this meeting" offered (and only when creating). */
  canRecord: boolean;
  /** The organizer: always invited, so not listed as a choice. */
  hiddenPersonId: string;
  /** Who is using the form, so their own row reads "You". Defaults to the organizer (right on the schedule page; on the edit
   *  page a company admin editing someone else's event passes their own id). */
  viewerId?: string;
  /** The display zone, in words, e.g. "Asia/Singapore". */
  zoneLabel: string;
  save: SaveEventAction;
  cancelHref: string;
  /** Busy times of the chosen people for a window (BFF §47.4). Without it, no "Busy that day" block is drawn. */
  loadBusy?: LoadBusy;
}) {
  const router = useRouter();
  const [v, setV] = useState<EventFormInput>(initial);
  const [error, setError] = useState<{ error: string; field?: string } | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState("");

  const names = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.name])), [members]);
  const set = <K extends keyof EventFormInput>(k: K, val: EventFormInput[K]) => setV((p) => ({ ...p, [k]: val }));
  const err = (f: string) => (error?.field === f ? error.error : undefined);

  const shownProjects = v.clientId ? projects.filter((p) => p.clientId === v.clientId) : projects;
  const others = members.filter((m) => m.id !== hiddenPersonId);
  const needle = filter.trim().toLowerCase();
  const listed = others.filter((m) => !needle || m.name.toLowerCase().includes(needle) || v.attendeeIds.includes(m.id));

  // ── busy times: who (the organizer and the invited, in the order shown), which day, and the fetch ──────────────────────
  const people = useMemo(() => [hiddenPersonId, ...v.attendeeIds.filter((id) => id !== hiddenPersonId)], [hiddenPersonId, v.attendeeIds]);
  const busyWindow = !v.allDay ? busyDayWindow(v.date) : null;
  const busyWanted = !!loadBusy && !!busyWindow && people.length > 0;
  const tooMany = busyWanted && people.length > BUSY_PEOPLE_MAX;
  const busyKey = busyWanted && !tooMany ? `${v.date}|${people.join(",")}` : "";
  type BusyState = { kind: "loading" } | { kind: "unavailable"; key: string } | { kind: "ready"; key: string; busy: BusyPerson[] };
  const [busyState, setBusyState] = useState<BusyState>({ kind: "loading" });
  const loadBusyRef = useRef(loadBusy);
  loadBusyRef.current = loadBusy;
  useEffect(() => {
    if (!busyKey) return;
    const w = busyDayWindow(v.date);
    const fn = loadBusyRef.current;
    if (!w || !fn) return;
    let stale = false;
    setBusyState({ kind: "loading" });
    const timer = setTimeout(() => {
      fn(people, w.from, w.to).then(
        (r) => { if (!stale) setBusyState(r.ok ? { kind: "ready", key: busyKey, busy: r.busy } : { kind: "unavailable", key: busyKey }); },
        () => { if (!stale) setBusyState({ kind: "unavailable", key: busyKey }); },
      );
    }, 400);
    return () => { stale = true; clearTimeout(timer); };
    // `people` and `v.date` are what `busyKey` is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey]);
  // The visibility select's one value: `attendees`, `company`, or `department:<unit id>`. An event already shared with a unit that is
  // not offered (it has left the tree) keeps an option of its own, so the select never shows another choice than the event holds.
  const unitOptions = v.visibility === "department" && v.unitNodeId && !units.some((u) => u.id === v.unitNodeId)
    ? [...units, { id: v.unitNodeId, name: "", label: "A department no longer in the structure" }]
    : units;
  const visibilityValue = v.visibility === "department" ? `department:${v.unitNodeId}` : v.visibility;
  function chooseVisibility(raw: string) {
    if (raw.startsWith("department:")) setV((p) => ({ ...p, visibility: "department", unitNodeId: raw.slice("department:".length) }));
    else setV((p) => ({ ...p, visibility: raw === "company" ? "company" : "attendees", unitNodeId: "" }));
  }
  const youId = viewerId ?? hiddenPersonId;
  const busyName = (id: string) => (id === youId ? "You" : names[id] ?? "Someone");

  function toggle(id: string) {
    set("attendeeIds", v.attendeeIds.includes(id) ? v.attendeeIds.filter((x) => x !== id) : [...v.attendeeIds, id]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const check = validateEventForm(v, mode);
    if (!check.ok) { setError({ error: check.error, field: check.field }); return; }
    setError(null);
    start(async () => {
      const r = await save(v, names);
      if (r.ok) { router.push(r.href ?? "/calendar"); return; }
      setError({ error: r.error, field: r.field });
    });
  }

  const Row = ({ id, label, req, hint, children }: { id: string; label: string; req?: boolean; hint?: string; children: ReactNode }) => (
    <div className="lux-field">
      <label htmlFor={id} className={`lux-field__label${req ? " lux-field__label--req" : ""}`}>{label}</label>
      {children}
      {err(id) ? <span className="lux-field__error" role="alert">{err(id)}</span> : hint ? <span className="lux-field__hint">{hint}</span> : null}
    </div>
  );
  const cls = (f: string) => `lux-field__control${err(f) ? " lux-field__control--error" : ""}`;

  return (
    <form onSubmit={submit} noValidate className="cal-form" aria-label={mode === "create" ? "Schedule a meeting" : "Edit event"}>
      {Row({ id: "title", label: "Title", req: true, children: (
        <input id="title" className={cls("title")} value={v.title} maxLength={400} onChange={(e) => set("title", e.target.value)} aria-invalid={!!err("title")} />
      ) })}

      <label className="lux-field lux-field--checkbox">
        <input type="checkbox" className="lux-field__checkbox" checked={v.allDay} onChange={(e) => set("allDay", e.target.checked)} />
        <span className="lux-field__checkbox-text"><span className="lux-field__label">All day</span></span>
      </label>

      {v.allDay ? (
        <div className="lux-form-grid">
          {Row({ id: "startDate", label: "First day", req: true, children: (
            <input id="startDate" type="date" className={cls("startDate")} value={v.startDate} onChange={(e) => set("startDate", e.target.value)} />
          ) })}
          {Row({ id: "endDate", label: "Last day", req: true, children: (
            <input id="endDate" type="date" className={cls("endDate")} value={v.endDate} onChange={(e) => set("endDate", e.target.value)} />
          ) })}
        </div>
      ) : (
        <div className="lux-form-grid">
          {Row({ id: "date", label: "Date", req: true, children: (
            <input id="date" type="date" className={cls("date")} value={v.date} onChange={(e) => set("date", e.target.value)} />
          ) })}
          {Row({ id: "startTime", label: "Starts", req: true, children: (
            <input id="startTime" type="time" className={cls("startTime")} value={v.startTime} onChange={(e) => set("startTime", e.target.value)} />
          ) })}
          {Row({ id: "endTime", label: "Ends", req: true, children: (
            <input id="endTime" type="time" className={cls("endTime")} value={v.endTime} onChange={(e) => set("endTime", e.target.value)} />
          ) })}
        </div>
      )}
      <p className="lux-field__hint">Times are in {zoneLabel}.</p>

      <fieldset className="cal-form__people">
        <legend className="lux-field__label">Invite people</legend>
        <input
          type="search" className="lux-field__control" placeholder="Find a person" aria-label="Find a person"
          value={filter} onChange={(e) => setFilter(e.target.value)}
        />
        {others.length === 0 ? (
          <p className="lux-field__hint">There is nobody else in this company to invite.</p>
        ) : (
          <ul className="cal-form__list">
            {listed.map((m) => (
              <li key={m.id}>
                <label className="lux-field lux-field--checkbox">
                  <input type="checkbox" className="lux-field__checkbox" checked={v.attendeeIds.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span className="lux-field__checkbox-text">{m.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <span className="lux-field__hint">
          {v.attendeeIds.filter((id) => id !== hiddenPersonId).length} invited. You are always included.
        </span>
        {err("attendeeIds") && <span className="lux-field__error" role="alert">{err("attendeeIds")}</span>}
      </fieldset>

      {busyWanted && (
        <section className="cal-busy" aria-labelledby="cal-busy-h">
          <h3 id="cal-busy-h" className="lux-field__label">Busy that day</h3>
          {tooMany ? (
            <p className="lux-field__hint" role="status">Busy times are shown for up to {BUSY_PEOPLE_MAX} people at a time.</p>
          ) : busyState.kind === "loading" || busyState.key !== busyKey ? (
            <p className="lux-field__hint" role="status">Checking busy times...</p>
          ) : busyState.kind === "unavailable" ? (
            <p className="lux-field__hint" role="status">Busy times are unavailable right now.</p>
          ) : (
            <ul className="cal-busy__list">
              {people.map((id) => {
                const p = busyState.busy.find((b) => b.userId === id);
                // A person the answer left out is UNKNOWN, not free.
                const text = p ? busyText(p.intervals, v.date) : "Not available";
                const clash = !!p && busyClashes(p.intervals, v.date, v.startTime, v.endTime);
                return (
                  <li key={id} className="cal-busy__row">
                    <span className="cal-busy__who">{busyName(id)}</span>{" "}
                    <span className="cal-busy__times">{text}</span>
                    {clash && <>{" "}<strong className="cal-busy__clash">Clashes with the chosen time</strong></>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <div className="lux-form-grid">
        {Row({ id: "location", label: "Place", children: (
          <input id="location" className={cls("location")} value={v.location} onChange={(e) => set("location", e.target.value)} />
        ) })}
        {Row({ id: "videoUrl", label: "Video link", hint: "A web address starting with https://", children: (
          <input id="videoUrl" type="url" className={cls("videoUrl")} value={v.videoUrl} placeholder="https://" onChange={(e) => set("videoUrl", e.target.value)} />
        ) })}
      </div>

      {Row({ id: "description", label: "Notes", children: (
        <textarea id="description" className={`${cls("description")} lux-field__control--textarea`} value={v.description} onChange={(e) => set("description", e.target.value)} />
      ) })}

      <div className="lux-form-grid">
        {Row({ id: "clientId", label: "Client (optional)", children: (
          <span className="lux-field__selectwrap">
            <select id="clientId" className={cls("clientId")} value={v.clientId}
              onChange={(e) => setV((p) => ({ ...p, clientId: e.target.value, projectId: projects.some((x) => x.id === p.projectId && x.clientId === e.target.value) ? p.projectId : "" }))}>
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </span>
        ) })}
        {Row({ id: "projectId", label: "Project (optional)", children: (
          <span className="lux-field__selectwrap">
            <select id="projectId" className={cls("projectId")} value={v.projectId} onChange={(e) => set("projectId", e.target.value)}>
              <option value="">No project</option>
              {shownProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </span>
        ) })}
      </div>
      {linksUnavailable && (
        <p className="lux-field__hint" role="status">Clients and projects couldn&apos;t be loaded right now. You can still schedule without them.</p>
      )}

      {Row({ id: "visibility", label: "Who can see it", hint: v.visibility === "department" ? "Everyone in that department can see it on its calendar. Only the people you invite are notified." : undefined, children: (
        <span className="lux-field__selectwrap">
          <select id="visibility" className={cls("visibility")} value={visibilityValue} onChange={(e) => chooseVisibility(e.target.value)} aria-invalid={!!err("visibility")}>
            <option value="attendees">Only the people invited</option>
            <option value="company">Everyone in the company</option>
            {unitOptions.map((u) => <option key={u.id} value={`department:${u.id}`}>{u.label}</option>)}
          </select>
        </span>
      ) })}

      {canRecord && mode === "create" && (
        <label className="lux-field lux-field--checkbox">
          <input type="checkbox" className="lux-field__checkbox" aria-labelledby="event-record-label" aria-describedby="event-record-hint" checked={v.record} disabled={v.allDay} onChange={(e) => set("record", e.target.checked)} />
          <span className="lux-field__checkbox-text">
            <span id="event-record-label" className="lux-field__label">Record this meeting</span>
            <span id="event-record-hint" className="lux-field__hint">
              Recordings are visible to everyone in the company.
              {v.allDay ? " A recording needs a start time, so it can't be set on an all-day event." : ""}
            </span>
            {err("record") && <span className="lux-field__error" role="alert">{err("record")}</span>}
          </span>
        </label>
      )}

      {error && !error.field && <p className="lux-field__error" role="alert">{error.error}</p>}
      {error?.field && !FIELD_IDS.has(error.field) && <p className="lux-field__error" role="alert">{error.error}</p>}

      <div className="cal-actions">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : mode === "create" ? "Schedule" : "Save changes"}</Button>
        <Link href={cancelHref} className="lux-btn lux-btn--ghost lux-btn--sm">Cancel</Link>
      </div>
    </form>
  );
}

/** Fields the form draws an inline error for. A refusal on any other field (the backend's `field`) is shown at the end. */
const FIELD_IDS = new Set(["title", "startDate", "endDate", "date", "startTime", "endTime", "attendeeIds", "location", "videoUrl", "description", "clientId", "projectId", "visibility", "record"]);
