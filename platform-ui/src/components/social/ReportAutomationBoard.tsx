"use client";
// SCP-5 W5-A6 (BFF §63.24.9) — the cards of Report automation. One card per schedule: the kind, the clients, the timing in words, the owner, on or paused (said in text, with the reason), the next
// run, the last run with its counts and its link to the results, and the spend (SCP-Q40: tracked, never capped, so there is no limit control anywhere here). Add and Edit open the dialog; Pause and
// Resume act at once; Delete and Run now ask first (Run now names the period it will draft). The server decides every write: a refusal is shown in words beside the card it came from.
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/overlay/Modal";
import { ReportScheduleDialog, type ClientOption } from "@/components/social/ReportScheduleDialog";
import { formatDateTime, formatTimestamp, todayIsoInDisplayZone } from "@/lib/format";
import {
  KIND_LABEL, clientsWords, formatUsd, lastEndedPeriod, lastRunWords, missedWords, pausedWords, periodWords, runHref, spendWords, type ReportSchedule,
} from "@/lib/socialReportSchedules";
import { deleteSchedule, getRunProgress, runScheduleNow, setScheduleOn } from "@/lib/socialReportSchedulesActions";
import "@/components/social/cycles.css";
import "@/components/social/reportAutomation.css";

type Dialog = { kind: "edit"; schedule: ReportSchedule | null } | { kind: "delete" | "run"; schedule: ReportSchedule } | null;
interface Said { id: string; tone: "ok" | "error"; message: string; href?: string; linkText?: string }

export function ReportAutomationBoard({ deptId, schedules, clients }: { deptId: string; schedules: ReportSchedule[]; clients: ClientOption[] | null }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [cost, setCost] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  // The modal gives focus back to whatever opened it when it unmounts, so the opener needs no bookkeeping here.
  const open = (d: Dialog) => { setSaid(null); setDialog(d); };
  const close = () => setDialog(null);

  function toggleOn(s: ReportSchedule) {
    setSaid(null);
    start(async () => {
      const r = await setScheduleOn(s.id, !s.enabled);
      if (!r.ok) { setSaid({ id: s.id, tone: "error", message: r.message }); return; }
      setSaid({ id: s.id, tone: "ok", message: s.enabled ? "Paused. It will not run until someone resumes it." : "Resumed. You are now its owner: its runs act as you." });
      router.refresh();
    });
  }
  function confirmDelete(s: ReportSchedule) {
    start(async () => {
      const r = await deleteSchedule(s.id);
      setDialog(null);
      if (!r.ok) { setSaid({ id: s.id, tone: "error", message: r.message }); return; }
      setSaid({ id: "", tone: "ok", message: `The ${KIND_LABEL[s.kind].toLowerCase()} schedule was deleted. A run already started finishes.` });
      router.refresh();
    });
  }
  function confirmRun(s: ReportSchedule) {
    start(async () => {
      const r = await runScheduleNow(s.id);
      setDialog(null);
      if (!r.ok) { setSaid({ id: s.id, tone: "error", message: r.message }); return; }
      const a = r.answer;
      if (a.started) {
        setSaid({ id: s.id, tone: "ok", message: `Started: drafting ${a.total} ${a.total === 1 ? "client" : "clients"} for ${periodWords(s.kind, a.period)}. It drafts only; nothing is approved or sent.`, href: runHref(deptId, a.runId), linkText: "See its progress and results" });
      } else {
        setSaid({ id: s.id, tone: "ok", message: `This schedule already drafted ${periodWords(s.kind, a.period)}, so nothing new was started.`, ...(a.runId ? { href: runHref(deptId, a.runId), linkText: "See that run's results" } : {}) });
      }
      router.refresh();
    });
  }
  function showCost(s: ReportSchedule) {
    if (!s.lastRun) return;
    const runId = s.lastRun.runId;
    start(async () => {
      const r = await getRunProgress(runId);
      if (!r.ok) { setSaid({ id: s.id, tone: "error", message: r.message }); return; }
      const u = r.run.usage;
      const state = r.run.status === "done" ? "finished" : r.run.status === "failed" ? "stopped" : "still drafting";
      setCost((c) => ({
        ...c,
        [s.id]: `This run ${state}, ${r.run.done} of ${r.run.total} clients: ${u.calls} AI ${u.calls === 1 ? "call" : "calls"}, ${(u.promptTokens + u.completionTokens).toLocaleString("en-US")} tokens, cost ${u.costUsd === null ? "not recorded" : formatUsd(u.costUsd)}.`,
      }));
    });
  }

  const sayFor = (id: string) => (said && said.id === id ? said : null);

  return (
    <div className="scp-auto">
      <div className="scp-actions" style={{ marginTop: 0 }}>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => open({ kind: "edit", schedule: null })} disabled={pending}>Add a schedule</button>
      </div>
      {said && said.id === "" && <p className={`scp-msg scp-msg--${said.tone}`} role={said.tone === "error" ? "alert" : "status"}>{said.message}</p>}

      {schedules.length === 0 ? (
        <p className="scp-note" role="status">No report is drafted by itself yet. Add a schedule to have a kind drafted every period.</p>
      ) : (
        <ul className="scp-auto__cards">
          {schedules.map((s) => {
            const say = sayFor(s.id);
            const title = `${KIND_LABEL[s.kind]} report`;
            return (
              <li key={s.id} className="scp-auto__card" aria-label={title}>
                <div className="scp-auto__head">
                  <h4 className="scp-auto__title">{title}</h4>
                  <span className={`scp-auto__state scp-auto__state--${s.enabled ? "on" : "paused"}`}>{s.enabled ? "On" : pausedWords(s.pausedReason)}</span>
                </div>
                <dl className="scp-auto__facts">
                  <div><dt>Clients</dt><dd>{clientsWords(s)}</dd></div>
                  <div><dt>When</dt><dd>{s.timingText || "The timing could not be read."}</dd></div>
                  <div><dt>Owner</dt><dd>{s.owner.name ?? "A person who is no longer listed"} (the runs act as them)</dd></div>
                  <div>
                    <dt>Next run</dt>
                    <dd>{s.enabled && s.nextRunAt ? <>{formatDateTime(s.nextRunAt)}{s.nextPeriod ? `, for ${periodWords(s.kind, s.nextPeriod)}` : ""}</> : "None while it is paused"}</dd>
                  </div>
                  <div>
                    <dt>Last run</dt>
                    <dd>
                      {s.lastRun
                        ? (
                          <>
                            {s.lastRunAt ? `${formatTimestamp(s.lastRunAt)}, ` : ""}{s.lastPeriod ? `for ${periodWords(s.kind, s.lastPeriod)}. ` : ""}{lastRunWords(s.lastRun)}.
                            {s.lastRun.missed > 0 ? ` ${missedWords(s.lastRun.missed)}.` : ""}{" "}
                            <Link href={runHref(deptId, s.lastRun.runId)} className="scp-link">See the results</Link>
                            {" · "}
                            <button type="button" className="scp-link" onClick={() => showCost(s)} disabled={pending}>Show this run&apos;s cost</button>
                            {cost[s.id] && <span className="scp-auto__cost" role="status"> {cost[s.id]}</span>}
                          </>
                        )
                        : "It has not run yet."}
                    </dd>
                  </div>
                  <div>
                    <dt>Spend</dt>
                    <dd>
                      <span className="scp-auto__spend">Last 30 days: {spendWords(s.spend.last30Days)}.</span>{" "}
                      <span className="scp-auto__spend">This month: {spendWords(s.spend.monthToDate)}.</span>{" "}
                      <span className="scp-field__hint">AI spend is tracked, never capped.</span>
                    </dd>
                  </div>
                </dl>
                <div className="scp-auto__buttons">
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => open({ kind: "edit", schedule: s })} disabled={pending} aria-label={`Edit the ${title.toLowerCase()} schedule`}>Edit</button>
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => toggleOn(s)} disabled={pending} aria-label={`${s.enabled ? "Pause" : "Resume"} the ${title.toLowerCase()} schedule`}>{s.enabled ? "Pause" : "Resume"}</button>
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => open({ kind: "run", schedule: s })} disabled={pending} aria-label={`Run the ${title.toLowerCase()} schedule now`}>Run now</button>
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => open({ kind: "delete", schedule: s })} disabled={pending} aria-label={`Delete the ${title.toLowerCase()} schedule`}>Delete</button>
                </div>
                {say && (
                  <p className={`scp-msg scp-msg--${say.tone}`} role={say.tone === "error" ? "alert" : "status"}>
                    {say.message}{say.href && <> <Link href={say.href} className="scp-link">{say.linkText}</Link></>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.kind === "edit" && (
        <ReportScheduleDialog
          schedule={dialog.schedule} clients={clients} onClose={close}
          onSaved={(message) => { setDialog(null); setSaid({ id: dialog.schedule?.id ?? "", tone: "ok", message }); router.refresh(); }}
        />
      )}
      {dialog?.kind === "delete" && (
        <Modal
          open onClose={close} title="Delete this schedule?" size="sm"
          footer={
            <>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={close} disabled={pending}>Keep it</button>
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => confirmDelete(dialog.schedule)} disabled={pending}>{pending ? "Working…" : "Delete schedule"}</button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            The {KIND_LABEL[dialog.schedule.kind].toLowerCase()} report will no longer be drafted by itself. Reports it already drafted stay where they are, and a run already started finishes.
          </p>
        </Modal>
      )}
      {dialog?.kind === "run" && (
        <Modal
          open onClose={close} title="Run this schedule now?" size="sm"
          footer={
            <>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={close} disabled={pending}>Cancel</button>
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => confirmRun(dialog.schedule)} disabled={pending}>{pending ? "Working…" : "Run now"}</button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This drafts the {KIND_LABEL[dialog.schedule.kind].toLowerCase()} report for <strong>{periodWords(dialog.schedule.kind, lastEndedPeriod(dialog.schedule.kind, todayIsoInDisplayZone()))}</strong>{" "}
            for {dialog.schedule.scope === "all" ? "every client you may draft for" : "the chosen clients you may draft for"}, as you, whether the schedule is on or paused. Its next scheduled run does not move.
            It only drafts, and the AI spend is recorded.
          </p>
        </Modal>
      )}
    </div>
  );
}
