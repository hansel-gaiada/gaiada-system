"use client";
// SCP-5 W5-A4 (BFF §63.24.5, §63.24.7): "Generate with AI" on the Social reports page. For ONE client it calls the create route (one gateway call, answered in the request) and opens the report; for "all
// my clients" ("all clients" for the four approvers) it starts a RUN, a background job, and shows its progress in place: each client's result as it lands, each linking to its report. The panel polls the
// run's read at a modest interval and stops when the run settles (`done` or `failed`), then refreshes the page so the list below shows the new drafts. A run the person did not start on this page (a
// scheduled or "Run now" run, opened by `?run=<id>`) is followed the same way, read through the same route. Idempotent: the click carries a fresh id, so a replay is the same report or run, and a run
// already going for the kind and period is followed instead of refused.
//
// Who: the officer drafts for their own clients, the four for every client (the server's listing decides; this page only words it). Every refusal is the contract's code, said in words, never as a code.
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { SimulatedMark } from "@/components/social/SimulatedMark";
import { newUuid } from "@/lib/socialClient";
import type { Refusal } from "@/lib/socialPipeline";
import { periodChoices, isShortKind, kindNoun, type KindRule, type PeriodicKind } from "@/lib/socialReportKinds";
import { RUN_POLL_MS, isSettled, progressLine, resultHref, resultWords, runStatusWords, runTitle, runningRunId, tallyLine, tallyOf, type RunListItem, type RunProgress } from "@/lib/socialReportRuns";
import { periodWords, reportHref } from "@/lib/socialReports";
import { draftReport, readRun, startRun } from "@/lib/socialReportsActions";
import "./cycles.css";
import "./reports.css";

export interface DraftableClient { engagementId: string; clientName: string }
const ALL = "__all__";

export function GenerateReports({ deptId, kind, clients, isApprover, today, rule, fiscalYearStartMonth, runs, followRunId, initialRun = null }: {
  deptId: string;
  kind: PeriodicKind;
  /** The clients the person may draft for one by one: their own, or every open client for the four. */
  clients: readonly DraftableClient[];
  isApprover: boolean;
  /** The company's report day (ISO), from the server. */
  today: string;
  /** The company's rule for this kind, or null when the rules could not be read. */
  rule: KindRule | null;
  fiscalYearStartMonth: number;
  /** The recent runs, or null when they could not be read. */
  runs: readonly RunListItem[] | null;
  /** A run to follow on load (`?run=`). */
  followRunId: string | null;
  /** A run already read (a settled one is drawn on the first paint and not asked for again; a running one is followed from it). */
  initialRun?: RunProgress | null;
}) {
  const uid = useId();
  const router = useRouter();
  const aiOff = rule !== null && !rule.aiDrafting;
  const [who, setWho] = useState<string>(!aiOff && clients.length !== 1 ? ALL : clients[0]?.engagementId ?? "");
  const all = who === ALL;
  const choices = useMemo(
    () => periodChoices(kind, today, { fiscalYearStartMonth, allowCurrent: all ? isShortKind(kind) : isShortKind(kind) || kind === "monthly" }),
    [kind, today, fiscalYearStartMonth, all],
  );
  const [picked, setPicked] = useState<string>("");
  const period = choices.some((c) => c.value === picked) ? picked : choices[0]?.value ?? "";
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(followRunId ?? initialRun?.runId ?? null);
  const [progress, setProgress] = useState<RunProgress | null>(initialRun);
  const [pollNote, setPollNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const settledSeen = useRef<string | null>(null);

  // Follow the run: read it now and every few seconds until it settles; a refusal that will not change (gone, not yours) stops the polling and says so.
  useEffect(() => {
    if (!runId) return;
    if (progress && progress.runId === runId && isSettled(progress.status)) return; // already read and settled: nothing more to ask
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let again = true;
      try {
        const r = await readRun(runId);
        if (cancelled) return;
        if (r.ok) {
          setProgress(r.run);
          setPollNote(null);
          if (isSettled(r.run.status)) {
            again = false;
            if (settledSeen.current !== r.run.runId) { settledSeen.current = r.run.runId; router.refresh(); }
          }
        } else {
          setPollNote(r.message);
          again = r.refusal.status >= 500 || r.refusal.status === 0;
        }
      } catch {
        if (cancelled) return;
        setPollNote("The run's progress could not be read just now. Trying again.");
      }
      if (again && !cancelled) timer = setTimeout(tick, RUN_POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runId, router]);

  if (clients.length === 0 && !isApprover && !runId && (runs ?? []).length === 0) return null;

  function generate() {
    setRefusal(null); setNotice(null);
    if (all) {
      start(async () => {
        const r = await startRun(kind, period, newUuid());
        if (r.ok) { setProgress(null); setRunId(r.run.runId); return; }
        const going = runningRunId(r.refusal);
        if (going) { setNotice("A run for this kind and period is already going. Its progress is shown below."); setProgress(null); setRunId(going); return; }
        setRefusal({ refusal: r.refusal, message: r.message });
      });
      return;
    }
    start(async () => {
      const r = await draftReport(who, kind, period, newUuid());
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      router.push(reportHref(deptId, r.report.id));
    });
  }

  const noun = kindNoun(kind).toLowerCase();
  const running = progress !== null && !isSettled(progress.status);
  return (
    <section className="scp-run" aria-label="Generate with AI">
      <form className="scp-reports__draft" aria-label={`Generate ${noun}s with AI`} onSubmit={(e) => { e.preventDefault(); if (period) generate(); }}>
        <div className="scp-field">
          <label htmlFor={`${uid}-who`}>Client</label>
          <select id={`${uid}-who`} className="scp-input" value={who} onChange={(e) => setWho(e.target.value)}>
            {!aiOff && <option value={ALL}>{isApprover ? "All clients" : "All my clients"}</option>}
            {clients.map((c) => <option key={c.engagementId} value={c.engagementId}>{c.clientName}</option>)}
          </select>
        </div>
        <div className="scp-field">
          <label htmlFor={`${uid}-period`}>{kind === "daily" ? "Day" : kind === "weekly" ? "Week" : kind === "monthly" ? "Month" : kind === "quarterly" ? "Quarter" : kind === "semester" ? "Half-year" : "Year"}</label>
          <select id={`${uid}-period`} className="scp-input" value={period} onChange={(e) => setPicked(e.target.value)}>
            {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || running || !period || (!all && !who)}>
          {pending ? (all ? "Starting…" : "Drafting…") : "Generate with AI"}
        </button>
        <span className="scp-field__hint">
          {all
            ? `Drafts a ${noun} for every client you may draft for that is due one. A client that already has one keeps it.`
            : `Drafts this client's ${noun}, or opens it when it exists.`}
          {!all && !isShortKind(kind) && kind !== "monthly" ? " The period must have ended." : ""}
          {aiOff ? " AI drafting is turned off for this kind, so a client's report starts empty and is written by hand." : ""}
        </span>
      </form>
      {notice && <p className="scp-note" role="status">{notice}</p>}
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}

      {runId && (
        <div className="scp-run__panel" role="region" aria-label="Run progress" aria-busy={running}>
          {progress ? (
            <>
              <h3 className="scp-post__section-title">{runTitle(progress.kind, periodWords(progress.period, progress.kind, fiscalYearStartMonth))}</h3>
              <p className="scp-note" role="status" style={{ margin: 0 }}>
                <strong>{runStatusWords(progress.status)}.</strong> {progressLine(progress)}{isSettled(progress.status) ? ` ${tallyLine(tallyOf(progress.results))}.` : ""}
                {progress.status === "failed" ? " The run could not go on; the results so far are kept." : ""}
              </p>
              <progress className="scp-run__bar" max={Math.max(progress.total, 1)} value={progress.done} aria-label="Clients done" />
              <ul className="scp-run__results" aria-label="Results by client">
                {progress.results.map((r) => {
                  const href = resultHref(deptId, r);
                  return (
                    <li key={r.engagementId} className={`scp-run__result scp-run__result--${r.status}`}>
                      <strong>{href ? <Link className="scp-link" href={href}>{r.clientName}</Link> : r.clientName}</strong>{" "}
                      {r.simulated && <SimulatedMark of="metrics" />} <span>{resultWords(r, progress.kind)}</span>
                    </li>
                  );
                })}
                {running && progress.done < progress.total && <li className="scp-field__hint">{progress.total - progress.done} still to draft…</li>}
              </ul>
            </>
          ) : (
            !pollNote && <p className="scp-note" role="status">Starting the run…</p>
          )}
          {pollNote && <p className="scp-note scp-note--reason" role="alert">{pollNote}</p>}
        </div>
      )}

      {runs === null ? (
        <p className="scp-note" role="status">The recent runs could not be read just now.</p>
      ) : runs.length > 0 && (
        <details className="scp-run__recent">
          <summary>Recent runs ({runs.length})</summary>
          <ul>
            {runs.map((r) => (
              <li key={r.runId}>
                <span>{runTitle(r.kind, periodWords(r.period, r.kind, fiscalYearStartMonth))}</span>{" "}
                <span className="scp-field__hint">{runStatusWords(r.status)}: {tallyLine(r.counts)}.</span>{" "}
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Show the results of the ${runTitle(r.kind, periodWords(r.period, r.kind, fiscalYearStartMonth))} run`}
                  onClick={() => { setProgress(null); setPollNote(null); setRunId(r.runId); }}>Show results</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
