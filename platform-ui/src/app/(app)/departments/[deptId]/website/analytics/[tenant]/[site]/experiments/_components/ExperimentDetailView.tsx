import Link from "next/link";
import { Card } from "@/components/ui";
import {
  armName, decisionWords, fmtCount, fmtPct, fmtPctPoints, goalWords, STATUS_WORDS, unavailableWords,
  type Analysis, type Experiment, type Progress, type Results, type Srm,
} from "@/lib/experimentsModel";
import "@/components/webdesk/content/content.css";
import "@/components/webdesk/analytics/analytics.css";
import "@/components/webdesk/analytics/aiVisibility.css";
import { ExperimentActions } from "./ExperimentActions";

function ProgressCard({ p, srm }: { p: Progress; srm: Srm }) {
  return (
    <Card title="Progress">
      <table className="wa-table" data-testid="exp-progress">
        <thead><tr><th>Variant</th><th className="wa-num">Visitors so far</th><th className="wa-num">Needed</th></tr></thead>
        <tbody>{p.perArm.map((a) => (
          <tr key={a.key}><td>{armName(a.key)}</td><td className="wa-num">{fmtCount(a.exposures)}</td><td className="wa-num">{a.target}</td></tr>
        ))}</tbody>
      </table>
      <p className="wa-foot" data-testid="exp-days">
        Day {p.elapsedDays}. The test runs at least {p.minDays} days and at most {p.maxDays}.{" "}
        {p.exposuresReached ? "Every variant has enough visitors." : "Not every variant has enough visitors yet."}{" "}
        {p.minDaysReached ? "The minimum time has passed." : "The minimum time has not passed yet."}
      </p>
      <p className={srm.mismatch ? "wa-range__err" : "wa-foot"} role={srm.mismatch ? "alert" : undefined} data-testid="exp-srm">{srm.message}</p>
    </Card>
  );
}

function Rate({ r }: { r: number | null }) {
  return <>{r === null ? "not shown (fewer than 5 goals)" : fmtPct(r)}</>;
}

function AnalysisCard({ a, e }: { a: Analysis; e: Experiment }) {
  const control = e.arms[0]?.key ?? a.control.key;
  return (
    <Card title="Result">
      <p data-testid="exp-decision"><strong>{decisionWords(a.decision)}</strong></p>
      <table className="wa-table" data-testid="exp-analysis">
        <thead><tr><th>Variant</th><th className="wa-num">Visitors</th><th className="wa-num">Goals reached</th><th className="wa-num">Rate</th><th>Against the control</th></tr></thead>
        <tbody>
          <tr><td>{armName(a.control.key, control)}</td><td className="wa-num">{fmtCount(a.control.units)}</td><td className="wa-num">{fmtCount(a.control.conversions)}</td><td className="wa-num"><Rate r={a.control.rate} /></td><td>Baseline</td></tr>
          {a.comparisons.map((c) => (
            <tr key={c.key}>
              <td>{armName(c.key, control)}</td><td className="wa-num">{fmtCount(c.units)}</td><td className="wa-num">{fmtCount(c.conversions)}</td><td className="wa-num"><Rate r={c.rate} /></td>
              <td>
                {fmtPctPoints(c.difference)} (likely between {fmtPctPoints(c.ciLower)} and {fmtPctPoints(c.ciUpper)}). Chance this is luck: {fmtPct(c.pAdjusted)}.
                {c.significantWinner ? " A clear winner." : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export interface ExperimentDetailViewProps {
  experiment: Experiment;
  results: Results;
  canUpdate: boolean;
  listHref: string;
  propertyId: string;
}

export function ExperimentDetailView({ experiment: e, results, canUpdate, listHref, propertyId }: ExperimentDetailViewProps) {
  const pre = e.preRegistration;
  return (
    <div className="wa-page" data-testid="experiment-detail">
      <p className="wc-lede"><Link href={listHref}>Back to all tests</Link></p>
      <h2 className="av-h">{e.key}: {STATUS_WORDS[e.status]}</h2>
      <p>{e.hypothesis}</p>
      <ExperimentActions propertyId={propertyId} experimentId={e.id} status={e.status} canUpdate={canUpdate} />

      <Card title="The plan, fixed before the test">
        <ul className="wa-foot" data-testid="exp-plan">
          <li>Goal: counts when {goalWords(e.goal.event)}.</li>
          <li>Shares: {e.arms.map((a) => `${armName(a.key)} ${a.weight}%`).join(", ")}.</li>
          <li>Starting rate {fmtPct(pre.baselineRate)} ({pre.baselineSource === "supplied" ? "entered by you" : "from the last 28 days"}); smallest change to find {fmtPct(pre.relativeMde, 0)} relative.</li>
          <li>Needs {pre.nPerArm} visitors per variant, about {pre.projectedDays} days.</li>
          <li>{pre.locked ? "The plan is locked." : "The plan can still be changed while the test is a draft."}</li>
        </ul>
      </Card>

      {results.state === "not_started" ? <p className="wa-note" role="status" data-testid="exp-state-not_started">{results.message || "The test has not started, so there is nothing to show yet."}</p> : null}
      {results.state === "aborted" ? <p className="wa-note" role="status" data-testid="exp-state-aborted">{results.message || "The test was aborted. No result is recorded."}</p> : null}
      {results.state === "unavailable" ? <p className="wa-note" role="status" data-testid="exp-state-unavailable">{unavailableWords(results.reason)}</p> : null}
      {results.state === "ok" && !results.horizonReached ? (
        <>
          <p className="wa-note" data-testid="exp-hidden-note">
            {results.inconclusive
              ? "The test reached its time limit without enough visitors for a clear result. Keep the control."
              : "The test has not reached its planned size, so no result is shown. This is on purpose: a number seen too early can mislead."}
          </p>
          <ProgressCard p={results.progress} srm={results.srm} />
        </>
      ) : null}
      {results.state === "ok" && results.horizonReached ? (
        <>
          {results.decided ? <p className="wa-note" data-testid="exp-decided">Decided on {results.decided.decidedAt.slice(0, 10)}.{results.decided.note ? ` Note: ${results.decided.note}` : ""}</p> : null}
          <ProgressCard p={results.progress} srm={results.srm} />
          <AnalysisCard a={results.analysis} e={e} />
        </>
      ) : null}
      {results.state === "ok" && results.warnings.length > 0 ? (
        <ul className="wa-foot" data-testid="exp-warnings">{results.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      ) : null}
    </div>
  );
}
