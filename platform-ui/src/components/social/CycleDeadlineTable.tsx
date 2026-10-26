"use client";
// SCP-1c — the deadline table of one content month (BFF §63.5): each client's A/B pre-fill, an editable deadline, the computed ready-by, the posts
// counted against the target (stories and extra posts beside it), and the client's schedule-health chip.
//
// The pre-fill is a SUGGESTION from the client's delivery batch: "Use" copies it into the deadline box, nothing is saved until "Save deadlines".
// Saving sends only the rows whose deadline changed (`PUT cycles`, one transaction: one bad row refuses all), and the answer is the month's table
// again, so ready-by and health show what the server computed. Editable only with `canPlan`; otherwise the box and the buttons are disabled with
// the reason in words (`aria-describedby`) and as `title`. The server's 403 `not_a_social_approver` is the boundary; this is the hint.
import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCycleDeadlines } from "@/lib/socialCyclesActions";
import { PLAN_REFUSAL_REASON, deadlineRange, type CycleRow, type CycleTable } from "@/lib/socialCycles";
import { dayLabel, monthTitle, shortDay } from "@/lib/deptCalendar";
import { HealthChip } from "./HealthChip";

const BATCH_LABEL = { A: "Batch A", B: "Batch B" } as const;

/** "8 of 12", or "8" with no target; the stories and extra posts that sit beside the target, when there are any. */
export function postsText(r: CycleRow): { main: string; beside: string | null } {
  const main = r.target !== null ? `${r.counts.counted} of ${r.target}` : String(r.counts.counted);
  const beside = [
    r.counts.extra > 0 ? `${r.counts.extra} extra` : null,
    r.counts.stories > 0 ? `${r.counts.stories} ${r.counts.stories === 1 ? "story" : "stories"}` : null,
  ].filter(Boolean).join(" · ");
  return { main, beside: beside || null };
}

export function CycleDeadlineTable({ table }: { table: CycleTable }) {
  const router = useRouter();
  const reasonId = useId();
  const range = useMemo(() => deadlineRange(table.month), [table.month]);
  const locked = !table.canPlan;
  const [current, setCurrent] = useState<CycleTable>(table);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(table.rows.map((r) => [r.engagementId, r.deadline ?? ""])));
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const dirtyRows = current.rows.filter((r) => (draft[r.engagementId] ?? "") !== "" && draft[r.engagementId] !== (r.deadline ?? ""));
  const fillable = current.rows.filter((r) => r.prefill.deadline && (draft[r.engagementId] ?? "") === "");

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveCycleDeadlines(current.month, dirtyRows.map((r) => ({ engagementId: r.engagementId, deadline: draft[r.engagementId] })));
      if (!res.ok) { setMsg({ kind: "error", text: res.message }); return; }
      setCurrent(res.table);
      setDraft(Object.fromEntries(res.table.rows.map((r) => [r.engagementId, r.deadline ?? ""])));
      setMsg({ kind: "ok", text: `Saved ${dirtyRows.length} ${dirtyRows.length === 1 ? "deadline" : "deadlines"}.` });
      router.refresh();
    });
  }

  if (current.rows.length === 0) {
    return <p className="scp-note">No client has an open engagement yet, so there is nothing to plan for this month.</p>;
  }

  return (
    <div>
      <div className="scp-tablewrap">
        <table className="scp-table">
          <caption>
            Deadline per client for {monthTitle(current.month)}. Ready-by is the deadline less {current.bufferWorkingDays} working {current.bufferWorkingDays === 1 ? "day" : "days"}
            {current.holidaysKnown ? "" : " (weekends only: no holiday calendar)"}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Pre-fill</th>
              <th scope="col">Deadline</th>
              <th scope="col">Ready by</th>
              <th scope="col">Posts</th>
              <th scope="col">Health</th>
            </tr>
          </thead>
          <tbody>
            {current.rows.map((r) => {
              const value = draft[r.engagementId] ?? "";
              const posts = postsText(r);
              const canUse = !locked && !pending && r.prefill.deadline !== null && value !== r.prefill.deadline;
              return (
                <tr key={r.engagementId}>
                  <td>
                    <span className="scp-table__client">{r.clientName}</span>
                    <span className="scp-table__sub">{r.officer ? `Officer: ${r.officer.name || "named"}` : "No officer yet"}</span>
                  </td>
                  <td>
                    {r.prefill.deadline
                      ? (
                        <span className="scp-prefill">
                          <span title={dayLabel(r.prefill.deadline)}>{shortDay(r.prefill.deadline)}</span>
                          <span className="scp-table__sub">{r.prefill.batch ? BATCH_LABEL[r.prefill.batch] : ""}</span>
                          <button
                            type="button" className="scp-link" disabled={!canUse}
                            title={locked ? PLAN_REFUSAL_REASON : undefined} aria-describedby={locked ? reasonId : undefined}
                            aria-label={`Use the pre-fill for ${r.clientName}`}
                            onClick={() => setDraft((d) => ({ ...d, [r.engagementId]: r.prefill.deadline as string }))}
                          >
                            Use
                          </button>
                        </span>
                      )
                      : <span className="scp-table__sub">No batch set</span>}
                  </td>
                  <td>
                    <input
                      className="scp-input" type="date" value={value} min={range.min} max={range.max}
                      onChange={(e) => setDraft((d) => ({ ...d, [r.engagementId]: e.target.value }))}
                      disabled={locked || pending} aria-label={`Deadline for ${r.clientName}`}
                      aria-describedby={locked ? reasonId : undefined}
                    />
                  </td>
                  <td className="scp-table__num">{r.readyBy ? <span title={dayLabel(r.readyBy)}>{shortDay(r.readyBy)}</span> : <span className="scp-table__sub">Not set</span>}</td>
                  <td className="scp-table__num">
                    {posts.main}
                    {posts.beside && <span className="scp-table__sub">+ {posts.beside}</span>}
                  </td>
                  <td><HealthChip health={r.health} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="scp-actions">
        <button
          type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={save} disabled={locked || pending || dirtyRows.length === 0}
          title={locked ? PLAN_REFUSAL_REASON : undefined} aria-describedby={locked ? reasonId : undefined}
        >
          {pending ? "Saving…" : `Save deadlines${dirtyRows.length > 0 ? ` (${dirtyRows.length})` : ""}`}
        </button>
        <button
          type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={locked || pending || fillable.length === 0}
          title={locked ? PLAN_REFUSAL_REASON : undefined} aria-describedby={locked ? reasonId : undefined}
          onClick={() => setDraft((d) => ({ ...d, ...Object.fromEntries(fillable.map((r) => [r.engagementId, r.prefill.deadline as string])) }))}
        >
          Fill empty rows from the pre-fill
        </button>
      </div>
      {locked && <p className="scp-note scp-note--reason" id={reasonId}>{PLAN_REFUSAL_REASON}</p>}
      {msg && <p className={`scp-msg scp-msg--${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</p>}
    </div>
  );
}
