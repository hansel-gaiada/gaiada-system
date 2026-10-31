"use client";
// SCP-5 W5-C5 (BFF §63.30.1) — one report kind's rules: on or off, the due day, when it freezes, what the report holds (narrative limit, next-period line, notes areas, action plan), what the check requires,
// and whether AI may draft it. Every control is a field of the server's `reports.kinds.<kind>`, with the same limits; the server still decides. What is NOT here is by design (63.30.2): who checks or sends,
// the one report per client, kind and period, and that AI only drafts.
import { Group, NumberField, SelectField, TextField, ToggleField } from "@/components/social/RulesFields";
import { ItemButtons } from "@/components/social/RulesList";
import {
  CHECK_PARTS, CHECK_PART_LABEL, SHORT_KINDS, checkPartOn, dueChoices, dueFor, dueRuleWords, kindName, moveItem, newArea, pruneCheck, type CheckPart, type PeriodicKind, type ReportKindRules,
} from "@/lib/socialRules";
import { WEEKDAY_NAMES } from "@/lib/socialReportSchedules";

const onOff = (b: boolean): string => (b ? "on" : "off");

export function RulesReportKind({ kind, value, defaults, onChange }: { kind: PeriodicKind; value: ReportKindRules; defaults: ReportKindRules; onChange: (next: ReportKindRules) => void }) {
  const p = `reports.kinds.${kind}`;
  const set = (patch: Partial<ReportKindRules>) => onChange(pruneCheck({ ...value, ...patch }));
  const setContent = (patch: Partial<ReportKindRules["content"]>) => set({ content: { ...value.content, ...patch } });
  const short = SHORT_KINDS.includes(kind);
  const areas = value.content.notes.areas;
  const unlimited = value.content.narrative.max === null;
  const choices = dueChoices(kind);
  const due = value.due;

  return (
    <details className="rules__details rules__item" data-kind={kind}>
      <summary>
        {kindName(kind)} report: {value.enabled ? "on" : "off"}, due {dueRuleWords(value.due).toLowerCase()}
      </summary>
      <div className="rules__fields">
        <ToggleField path={`${p}.enabled`} label={`Use ${kindName(kind).toLowerCase()} reports`} checked={value.enabled} onChange={(b) => set({ enabled: b })} def={onOff(defaults.enabled)}
          hint="Turned off, nothing can be created or drafted for this kind, and a schedule for it pauses." />

        <Group path={`${p}.due`} legend="When it is due">
          <div className="rules__row">
            <SelectField
              path={`${p}.due.rule`} label="Due rule" value={due.rule} options={choices.map((c) => ({ value: c.rule, label: c.label }))}
              onChange={(r) => set({ due: dueFor(r as ReportKindRules["due"]["rule"]) })} def={dueRuleWords(defaults.due)}
            />
            {due.rule === "working_days_after" && (
              <NumberField path={`${p}.due.n`} label="Working days after the period ends" value={due.n} min={0} max={30} onChange={(n) => set({ due: { rule: "working_days_after", n } })}
                def={defaults.due.rule === "working_days_after" ? String(defaults.due.n) : "not used"} hint="0 to 30. 0 is the day the period ends." />
            )}
            {due.rule === "weekday" && (
              <>
                <SelectField path={`${p}.due.weekday`} label="Weekday" value={String(due.weekday)} options={WEEKDAY_NAMES.map((n, i) => ({ value: String(i + 1), label: n }))}
                  onChange={(v) => set({ due: { ...due, weekday: Number(v) } })} def={defaults.due.rule === "weekday" ? WEEKDAY_NAMES[defaults.due.weekday - 1] : "not used"} />
                <SelectField path={`${p}.due.week`} label="Of which week" value={due.week} options={[{ value: "same", label: "The same week" }, { value: "next", label: "The next week" }]}
                  onChange={(v) => set({ due: { ...due, week: v as "same" | "next" } })} def={defaults.due.rule === "weekday" ? defaults.due.week : "not used"} />
              </>
            )}
          </div>
          {due.rule === "report_due_day" && <span className="rules__hint">Each client has its own report day (set in the allocation). The report is due on that day in the month after the period.</span>}
        </Group>

        <SelectField
          path={`${p}.freezeAt`} label="When the report freezes" value={value.freezeAt}
          options={[{ value: "create", label: "When it is created" }, { value: "submit", label: "When it is sent for checking" }]}
          onChange={(v) => set({ freezeAt: v as "create" | "submit" })} def={defaults.freezeAt === "create" ? "When it is created" : "When it is sent for checking"}
          hint="Frozen figures stop following the posts' later changes."
        />

        <Group path={`${p}.content`} legend="What the report holds">
          <div className="rules__row">
            <ToggleField path={`${p}.content.narrative.unlimited`} label="No limit on the narrative" checked={unlimited}
              onChange={(b) => setContent({ narrative: { max: b ? null : 1000 } })} def={onOff(defaults.content.narrative.max === null)} />
            {!unlimited && (
              <NumberField path={`${p}.content.narrative.max`} label="Narrative limit (characters)" value={value.content.narrative.max as number} min={100} max={10000}
                onChange={(n) => setContent({ narrative: { max: n } })} def={defaults.content.narrative.max === null ? "no limit" : String(defaults.content.narrative.max)} hint="100 to 10,000." />
            )}
          </div>
          {short
            ? <ToggleField path={`${p}.content.nextPeriodLine`} label="A line about the next period" checked={value.content.nextPeriodLine} onChange={(b) => setContent({ nextPeriodLine: b })} def={onOff(defaults.content.nextPeriodLine)} />
            : <span className="rules__hint">A line about the next period is only for the daily and weekly reports.</span>}
          <div className="rules__row">
            <ToggleField path={`${p}.content.actionPlan.enabled`} label="An action plan" checked={value.content.actionPlan.enabled} onChange={(b) => setContent({ actionPlan: { ...value.content.actionPlan, enabled: b } })} def={onOff(defaults.content.actionPlan.enabled)} />
            {value.content.actionPlan.enabled && (
              <NumberField path={`${p}.content.actionPlan.max`} label="Most action items" value={value.content.actionPlan.max} min={1} max={20} onChange={(n) => setContent({ actionPlan: { ...value.content.actionPlan, max: n } })}
                def={String(defaults.content.actionPlan.max)} hint="1 to 20." />
            )}
          </div>

          <Group path={`${p}.content.notes.areas`} legend="Notes areas" hint="Short written notes under the figures, such as followers or audience. At most 6.">
            {areas.length === 0 && <span className="rules__hint">No notes areas. The default has {defaults.content.notes.areas.length === 0 ? "none" : defaults.content.notes.areas.map((a) => a.label).join(", ")}.</span>}
            <ul className="rules__items">
              {areas.map((a, i) => (
                <li key={a.key} className="rules__item">
                  <div className="rules__row">
                    <TextField path={`${p}.content.notes.areas.${i}.label`} label={`Area ${i + 1} name`} value={a.label} maxLength={60} wide
                      onChange={(s) => setContent({ notes: { areas: areas.map((x, j) => (j === i ? { ...x, label: s } : x)) } })} />
                    <ItemButtons label={`area ${i + 1}, ${a.label}`} index={i} count={areas.length} onMove={(d) => setContent({ notes: { areas: moveItem(areas, i, d) } })}
                      onRemove={() => set({ content: { ...value.content, notes: { areas: areas.filter((_, j) => j !== i) } } })} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="rules__buttons">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={areas.length >= 6}
                onClick={() => setContent({ notes: { areas: [...areas, newArea(areas.map((a) => a.key))] } })}>Add a notes area</button>
            </div>
          </Group>
        </Group>

        <Group path={`${p}.checkRequires`} legend="What the check requires before the report can be sent" hint="A part can be required only when the report holds it.">
          {CHECK_PARTS.map((part: CheckPart) => {
            const on = checkPartOn(value, part);
            const required = value.checkRequires.includes(part);
            return (
              <ToggleField key={part} path={`${p}.checkRequires.${part}`} label={CHECK_PART_LABEL[part]} checked={required && on} disabled={!on}
                onChange={(b) => set({ checkRequires: b ? CHECK_PARTS.filter((x) => x === part || value.checkRequires.includes(x)) : value.checkRequires.filter((x) => x !== part) })}
                def={onOff(defaults.checkRequires.includes(part))} hint={on ? undefined : "The report does not hold this, so it cannot be required."} />
            );
          })}
        </Group>

        <ToggleField path={`${p}.aiDrafting`} label="AI may draft this kind" checked={value.aiDrafting} onChange={(b) => set({ aiDrafting: b })} def={onOff(defaults.aiDrafting)}
          hint="AI only drafts; one of the four approvers always checks and sends. With this off, Generate with AI is not offered and a draft starts empty." />
      </div>
    </details>
  );
}
