"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { scheduleMeetingAction, type ScheduleResult } from "@/lib/schedulingActions";
import { defaultSlotValue, formatScheduled, isOverdue } from "@/lib/schedulingView";
import "@/components/departments/departments.css";

// W1 — the SCHEDULE step of engagement setup (owner decision D-3).
//
// Before this, the first artefact of any engagement was a recording created at record time. Now a
// meeting row exists — scoped to client and project — before anyone presses record, which is the whole
// point: the client is already attached, and the recorder attaches TO this row rather than minting a
// new one.
//
// Deliberately small. A PM arranging a kickoff needs a time, a name and a medium; anything more here
// competes with the calendar tool they already use.
export interface UpcomingMeeting {
  id: string;
  title: string | null;
  status: string;
  /** Optional to match `MeetingRecording`: rows created by the older `start` path predate scheduling
   *  and carry no value at all, so the field is absent rather than null on those. Narrowing it to
   *  `string | null` here would force every caller to launder the registry type. */
  scheduled_at?: string | null;
  kind: string;
}

export function ScheduleMeetingPanel({
  clientId,
  projectId,
  upcoming,
}: {
  clientId?: string;
  projectId?: string;
  upcoming: UpcomingMeeting[];
}) {
  const [state, action, pending] = useActionState<ScheduleResult | null, FormData>(scheduleMeetingAction, null);
  const [open, setOpen] = useState(upcoming.length === 0);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          Schedule the meeting first and the recording attaches to it — so the client, the project and
          everyone attending are already attached before anyone presses record.
        </p>
        {!open && (
          <button type="button" className="btn" onClick={() => setOpen(true)} style={{ fontSize: 13 }}>
            Schedule a meeting
          </button>
        )}
      </div>

      {upcoming.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {upcoming.map((m) => {
            const overdue = isOverdue(m.scheduled_at ?? null, m.status);
            return (
              <div
                key={m.id}
                style={{
                  display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
                  padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10,
                }}
              >
                <span style={{ font: "500 13px var(--font-body)", color: "var(--ink)", flex: "1 1 160px" }}>
                  {m.title || "Untitled meeting"}
                </span>
                <span style={{ font: "400 12px var(--font-body)", color: overdue ? "var(--erp-accent)" : "var(--ink-muted)" }}>
                  {formatScheduled(m.scheduled_at ?? null)}
                </span>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                  {m.kind === "video" ? "Audio + video" : "Audio"}
                </span>
                {/* A scheduled time that has passed with no recording is the state a PM most needs to
                    see: the capture never happened, so nothing downstream will ever exist for it. */}
                {overdue && (
                  <span style={{ font: "500 12px var(--font-body)", color: "var(--erp-accent)" }}>
                    Time passed — not recorded
                  </span>
                )}
                <Link href={`/meetings/${m.id}`} className="btn" style={{ fontSize: 12, textDecoration: "none" }}>
                  Open
                </Link>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <form action={action} style={{ display: "grid", gap: 10, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10 }}>
          {clientId && <input type="hidden" name="clientId" value={clientId} />}
          {projectId && <input type="hidden" name="projectId" value={projectId} />}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              name="title"
              placeholder="Meeting title (e.g. Kickoff)"
              style={{ flex: "1 1 200px", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}
            />
            <label style={{ display: "grid", gap: 4, flex: "1 1 190px" }}>
              <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>When</span>
              <input
                type="datetime-local"
                name="scheduledAt"
                required
                defaultValue={defaultSlotValue()}
                style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, flex: "1 1 150px" }}>
              <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Record as</span>
              <select name="kind" defaultValue="audio" style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}>
                <option value="audio">Audio</option>
                <option value="video">Audio + video</option>
              </select>
            </label>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-primary" disabled={pending} style={{ fontSize: 13 }}>
              {pending ? "Scheduling…" : "Schedule"}
            </button>
            <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              You can add who&rsquo;s attending on the meeting page.
            </span>
          </div>
          {state && !state.ok && state.error && (
            <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{state.error}</p>
          )}
          {state?.ok && state.id && (
            <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
              Scheduled.{" "}
              <Link href={`/meetings/${state.id}`} style={{ color: "var(--erp-accent)" }}>
                Add participants
              </Link>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
