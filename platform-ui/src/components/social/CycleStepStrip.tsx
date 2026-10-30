// SCP-5f (BFF §63.27.4) — the Plan tab's strip of the month's steps: the company's steps for this cycle, in the rules' order, each with its due date and its state in
// words (Done, Late with the day it was due, Open with its due date, or no task yet), linking to its PM task. A late step is said, never shown by colour alone: the
// colour of its edge is a second signal beside the words. A cycle with no project says why it has no steps; an answer with no `steps` at all (an older server) draws
// nothing, because "no steps" would be a claim. The steps are the server's (they are each company's own, BFF §63.30): nothing here lists them. No page, no key.
import Link from "next/link";
import {
  STEPS_REASON_TEXT, stepStateOf, stepStateText, stepTaskHref, stepsSummary, type CycleStep, type StepsReason,
} from "@/lib/socialCycleSteps";

export function CycleStepStrip({ steps, reason }: { steps: readonly CycleStep[] | null; reason: StepsReason | null }) {
  if (reason) {
    return (
      <section aria-label="The month's steps" className="scp-steps">
        <h3 className="scp-plan__sub">The month&rsquo;s steps</h3>
        <p className="scp-note scp-note--reason" data-testid="steps-reason">{STEPS_REASON_TEXT[reason]}</p>
      </section>
    );
  }
  if (steps === null) return null;
  if (steps.length === 0) {
    return (
      <section aria-label="The month's steps" className="scp-steps">
        <h3 className="scp-plan__sub">The month&rsquo;s steps</h3>
        <p className="scp-note">No steps are set in this company&rsquo;s monthly cycle rules.</p>
      </section>
    );
  }
  return (
    <section aria-label="The month's steps" className="scp-steps">
      <h3 className="scp-plan__sub">The month&rsquo;s steps <span className="scp-steps__sum" data-testid="steps-summary">{stepsSummary(steps)}</span></h3>
      <ol className="scp-steps__list">
        {steps.map((s) => {
          const state = stepStateOf(s);
          const words = stepStateText(s);
          return (
            <li key={s.step} className="scp-step" data-step={s.step} data-state={state}>
              {s.taskId ? <Link href={stepTaskHref(s.taskId)} className="scp-step__title">{s.title}</Link> : <span className="scp-step__title">{s.title}</span>}
              <span className="scp-step__state">{words}</span>
              {!s.done && s.holder && <span className="scp-step__holder">With {s.holder.charAt(0).toLowerCase()}{s.holder.slice(1)}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
