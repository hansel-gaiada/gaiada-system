"use client";
// SCP-5 W5-C5 (BFF §63.30.1, §63.27.2) — the Monthly cycle section of the company rules: the steps each client's month goes through, in order (1 to 12). A step has a title (`{month}` is the content month, `{month-1}`
// to `{month-3}` the months before it), a due rule, and how it closes: by hand, or by one condition from the fixed menu (the conditions are code: a company picks one, it cannot write a new one). A cycle already
// made keeps its steps; the next ones take these. The preview dates the next cycle's steps for a chosen client under the unsaved steps.
import { Group, NumberField, SelectField, TextField } from "@/components/social/RulesFields";
import { ItemButtons } from "@/components/social/RulesList";
import { RulesPanel } from "@/components/social/RulesPanel";
import { RulesPreviewBox, type ClientChoice } from "@/components/social/RulesPreview";
import { formatDate } from "@/lib/format";
import {
  AUTO_CLOSE_LABEL, STEP_DUE_LABEL, STEP_KEYS, STEP_KEY_LABEL, autoCloseFor, autoCloseRules, autoCloseWords, moveItem, newStep, stepDueFor, stepDueWords, type CycleStepRule, type RulesAnswer,
} from "@/lib/socialRules";

const DUE_RULES = ["ready_by", "report_due_day", "none"] as const;

function StepEditor({ i, step, def, count, onChange, onMove, onRemove }: {
  i: number; step: CycleStepRule; def: CycleStepRule | undefined; count: number; onChange: (s: CycleStepRule) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  const p = `cycle.steps.${i}`;
  const due = step.due;
  const ac = step.autoClose;
  return (
    <li className="rules__item" aria-label={`Step ${i + 1}: ${step.title}`}>
      <div className="rules__item-head">
        <h5 className="rules__item-title">Step {i + 1}</h5>
        <ItemButtons label={`step ${i + 1}, ${step.title}`} index={i} count={count} onMove={onMove} onRemove={onRemove} removeDisabled={count <= 1} removeHint="A cycle keeps at least one step." />
      </div>
      <TextField path={`${p}.title`} label="Title" value={step.title} maxLength={200} wide onChange={(title) => onChange({ ...step, title })} def={def?.title}
        hint="{month} is the content month; {month-1} to {month-3} are the months before it." />
      <div className="rules__row">
        <SelectField path={`${p}.due.rule`} label="Due" value={due.rule} options={DUE_RULES.map((r) => ({ value: r, label: STEP_DUE_LABEL[r] }))}
          onChange={(r) => onChange({ ...step, due: stepDueFor(r as CycleStepRule["due"]["rule"]) })} def={def ? stepDueWords(def.due) : undefined} />
        {due.rule === "ready_by" && (
          <>
            <SelectField path={`${p}.due.lessEstimatesFrom`} label="Count back the estimates from" value={due.lessEstimatesFrom ?? ""}
              options={[{ value: "", label: "No estimates" }, ...STEP_KEYS.map((k) => ({ value: k, label: `${STEP_KEY_LABEL[k]} on` }))]}
              onChange={(v) => onChange({ ...step, due: { ...due, lessEstimatesFrom: v === "" ? null : (v as (typeof STEP_KEYS)[number]) } })}
              hint="The client's own step estimates, from that step to the end." />
            <NumberField path={`${p}.due.lessWorkingDays`} label="And extra working days" value={due.lessWorkingDays} min={0} max={30} onChange={(n) => onChange({ ...step, due: { ...due, lessWorkingDays: n } })} hint="0 to 30." />
          </>
        )}
        {due.rule === "report_due_day" && (
          <NumberField path={`${p}.due.monthOffset`} label="Months before the content month" value={-due.monthOffset} min={0} max={3} onChange={(n) => onChange({ ...step, due: { rule: "report_due_day", monthOffset: -n } })}
            hint="0 is the content month itself; 0 to 3." />
        )}
      </div>
      <div className="rules__row">
        <SelectField path={`${p}.autoClose.rule`} label="Closes" value={ac.rule} options={autoCloseRules().map((r) => ({ value: r, label: AUTO_CLOSE_LABEL[r] }))}
          onChange={(r) => onChange({ ...step, autoClose: autoCloseFor(r) })} def={def ? autoCloseWords(def.autoClose) : undefined}
          hint="By hand, or when the ERP sees that condition met. The conditions are fixed." />
        {ac.rule === "report_delivered" && (
          <NumberField path={`${p}.autoClose.reportMonthOffset`} label="Report of how many months back" value={-ac.reportMonthOffset} min={0} max={3} onChange={(n) => onChange({ ...step, autoClose: { rule: "report_delivered", reportMonthOffset: -n } })}
            hint="0 is the content month's own report; 0 to 3." />
        )}
      </div>
      {!def && <span className="rules__hint">A step of your own: there is no default for it.</span>}
    </li>
  );
}

export function RulesCycle({ answer, clients }: { answer: RulesAnswer; clients: ClientChoice[] | null }) {
  return (
    <section aria-labelledby="rules-group-cycle" className="scp-slot" data-slot="rules-cycle">
      <h3 className="scp-slot__title" id="rules-group-cycle">Monthly cycle</h3>
      <p className="scp-note" style={{ marginTop: 0, marginBottom: 12 }}>
        The steps each client&rsquo;s content month goes through, as tasks in the client&rsquo;s project. A change applies to the cycles made after it; a cycle already made keeps its steps. How a step closes is picked from a fixed menu.
      </p>
      <div className="rules">
        <RulesPanel
          section="cycle" title="Cycle steps" answer={answer}
          intro="Keep one to 12 steps, in the order they happen. Move a step with Up and Down."
          preview={({ draft }) => (
            <RulesPreviewBox
              section="cycle" value={draft} clients={clients} clientRequired title="The next cycle's steps for a client" button="Preview the next cycle's steps"
              render={(p) => (p.steps && p.steps.length > 0 && p.cycle ? (
                <>
                  <p className="scp-note" style={{ margin: 0 }}>Steps for the {p.cycle.month} cycle, ready by {formatDate(p.cycle.readyBy)}.</p>
                  <table className="rules__table">
                    <caption className="rules__sr">The next cycle&rsquo;s steps under the unsaved steps</caption>
                    <thead><tr><th scope="col">Step</th><th scope="col">Due</th><th scope="col">Closes</th></tr></thead>
                    <tbody>
                      {p.steps.map((s) => (
                        <tr key={s.key}><th scope="row">{s.title}</th><td>{s.due ? formatDate(s.due) : "No due date"}</td><td>{AUTO_CLOSE_LABEL[s.autoClose] ?? s.autoClose}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <p className="scp-note" role="status" style={{ margin: 0 }}>
                  {p.reason === "no_next_cycle" ? "This client has no cycle after this month yet, so there are no dates to show." : "Choose a client to see the dates."}
                </p>
              ))}
            />
          )}
        >
          {({ draft, setDraft, defaults }) => {
            const set = (steps: CycleStepRule[]) => setDraft({ steps });
            const steps = draft.steps;
            return (
              <>
                <Group path="cycle.steps" legend={`Steps (${steps.length} of 12)`}>
                  <ol className="rules__items">
                    {steps.map((s, i) => (
                      <StepEditor
                        key={s.key} i={i} step={s} def={defaults.steps.find((d) => d.key === s.key)} count={steps.length}
                        onChange={(next) => set(steps.map((x, j) => (j === i ? next : x)))} onMove={(d) => set(moveItem(steps, i, d))} onRemove={() => set(steps.filter((_, j) => j !== i))}
                      />
                    ))}
                  </ol>
                  <div className="rules__buttons">
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={steps.length >= 12} onClick={() => set([...steps, newStep(steps.map((x) => x.key))])}>Add a step</button>
                  </div>
                </Group>
                <details className="rules__details">
                  <summary>The default steps ({defaults.steps.length})</summary>
                  <ol className="rules__diff">
                    {defaults.steps.map((s) => <li key={s.key}>{s.title}. Due: {stepDueWords(s.due).toLowerCase()}. Closes: {autoCloseWords(s.autoClose).toLowerCase()}.</li>)}
                  </ol>
                </details>
              </>
            );
          }}
        </RulesPanel>
      </div>
    </section>
  );
}
