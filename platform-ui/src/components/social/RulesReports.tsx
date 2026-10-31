"use client";
// SCP-5 W5-C5 (BFF §63.30.5) — the Reports section of the company rules: the fiscal year and the six report kinds (`reports`), and the ideas settings (`ideas`), each saved on its own as the server keeps them.
// The preview shows the next due date of each kind under the unsaved rules, for a chosen client when a kind is due on that client's own report day.
import { RulesPanel } from "@/components/social/RulesPanel";
import { RulesPreviewBox, type ClientChoice } from "@/components/social/RulesPreview";
import { RulesReportKind } from "@/components/social/RulesReportKind";
import { SelectField, ToggleField } from "@/components/social/RulesFields";
import { formatDate } from "@/lib/format";
import { MONTH_NAMES, PERIODIC_KINDS, kindName, type ReportDueRow, type RulesAnswer } from "@/lib/socialRules";

const onOff = (b: boolean): string => (b ? "on" : "off");
const rangeWords = (r: { start: string; end: string }): string => (r.start === r.end ? formatDate(r.start) : `${formatDate(r.start)} to ${formatDate(r.end)}`);

function dueCell(r: ReportDueRow, needsClient: boolean): string {
  if (!r.enabled) return "Turned off";
  if (r.due) return formatDate(r.due);
  return needsClient ? "Needs a client's report day: choose a client" : "No report day set for this client";
}

export function RulesReports({ answer, clients }: { answer: RulesAnswer; clients: ClientChoice[] | null }) {
  return (
    <section aria-labelledby="rules-group-reports" className="scp-slot" data-slot="rules-reports">
      <h3 className="scp-slot__title" id="rules-group-reports">Reports</h3>
      <p className="scp-note" style={{ marginTop: 0, marginBottom: 12 }}>
        How the company&rsquo;s periodic reports work: when each kind is due, when it freezes, what it holds and what the check requires. A change applies to new periods only: a report already made keeps the rules
        it was made under. Who checks and sends a report, one report per client, kind and period, and that AI only drafts are fixed and not set here.
      </p>
      <div className="rules">
        <RulesPanel
          section="reports" title="Report rules" answer={answer}
          intro="The fiscal year, then each kind of report. Open a kind to change it."
          preview={({ draft }) => (
            <RulesPreviewBox
              section="reports" value={draft} clients={clients} title="Next due dates under these rules" button="Preview the next due dates"
              render={(p) => (
                <table className="rules__table">
                  <caption className="rules__sr">The next due date of each report kind under the unsaved rules</caption>
                  <thead><tr><th scope="col">Kind</th><th scope="col">Period</th><th scope="col">Due</th></tr></thead>
                  <tbody>
                    {(p.reports ?? []).map((r) => (
                      <tr key={r.kind}>
                        <th scope="row">{kindName(r.kind)}</th>
                        <td>{r.period} ({rangeWords(r.range)})</td>
                        <td>{dueCell(r, p.reason === "no_client" && draft.kinds[r.kind].due.rule === "report_due_day")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            />
          )}
        >
          {({ draft, setDraft, defaults }) => (
            <>
              <SelectField
                path="reports.fiscalYearStartMonth" label="The fiscal year starts in" value={String(draft.fiscalYearStartMonth)}
                options={MONTH_NAMES.map((n, i) => ({ value: String(i + 1), label: n }))}
                onChange={(v) => setDraft({ ...draft, fiscalYearStartMonth: Number(v) })} def={MONTH_NAMES[defaults.fiscalYearStartMonth - 1]}
                hint="Quarters, half years and years follow it, and a fiscal year is named by the calendar year it starts in. January means calendar periods."
              />
              {PERIODIC_KINDS.map((kind) => (
                <RulesReportKind
                  key={kind} kind={kind} value={draft.kinds[kind]} defaults={defaults.kinds[kind]}
                  onChange={(next) => setDraft({ ...draft, kinds: { ...draft.kinds, [kind]: next } })}
                />
              ))}
            </>
          )}
        </RulesPanel>

        <RulesPanel
          section="ideas" title="Ideas for next month" answer={answer}
          intro="How the ideas for next month behave. These two switches apply to ideas as they are written and as the monthly report is made."
        >
          {({ draft, setDraft, defaults }) => (
            <>
              <ToggleField path="ideas.metricRequired" label="An idea must name the metric it would move" checked={draft.metricRequired} onChange={(b) => setDraft({ ...draft, metricRequired: b })} def={onOff(defaults.metricRequired)} />
              <ToggleField
                path="ideas.sharedInMonthlyReport" label="Ideas marked as shared print in the next monthly report" checked={draft.sharedInMonthlyReport}
                onChange={(b) => setDraft({ ...draft, sharedInMonthlyReport: b })} def={onOff(defaults.sharedInMonthlyReport)}
              />
            </>
          )}
        </RulesPanel>
      </div>
    </section>
  );
}
