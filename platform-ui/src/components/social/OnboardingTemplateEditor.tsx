"use client";
// SCP-5 W5-C5 (BFF §63.29.1, §63.30.1) — the chosen onboarding template's phases, roles and steps, edited through PM's own template route (`PATCH pm/templates/:id`). Each step has a title, a phase, a role, how many working
// days after the kickoff it is due, a description and sub-steps. A template already applied keeps its own copy, so only the onboardings started after a save use the new steps. PM's route carries no version: if two
// people save at once the last save wins, and the page says so. A refused field is said in words beside its control, as in the rules sections.
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Group, NumberField, RulesErrorContext, SelectField, TextField, type FieldError } from "@/components/social/RulesFields";
import { ItemButtons } from "@/components/social/RulesList";
import { cloneJson, moveItem, sameJson } from "@/lib/socialRules";
import { TEMPLATE_LIMITS, newPhase, newRole, newTask, offsetWords, phaseInUse, roleInUse, tasksByPhase, type ProjectTemplate, type TemplatePayload } from "@/lib/socialOnboardingTemplate";
import { saveTemplateSteps } from "@/lib/socialOnboardingTemplateActions";
import "@/components/social/cycles.css";
import "@/components/social/rules.css";

/** Move a step up or down among the steps of its own phase. */
function moveInPhase(tasks: TemplatePayload["tasks"], index: number, delta: -1 | 1): TemplatePayload["tasks"] {
  const phase = tasks[index].phase;
  let j = index + delta;
  while (j >= 0 && j < tasks.length && tasks[j].phase !== phase) j += delta;
  if (j < 0 || j >= tasks.length) return tasks;
  const out = [...tasks];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

export function OnboardingTemplateEditor({ template }: { template: ProjectTemplate }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<TemplatePayload>(() => cloneJson(template.payload));
  const [seen, setSeen] = useState(template.updatedAt);
  const [said, setSaid] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [error, setError] = useState<FieldError | null>(null);
  const [pending, start] = useTransition();
  // The template changed on the server (our save, or someone else's): start again from it.
  if (seen !== template.updatedAt) { setSeen(template.updatedAt); setDraft(cloneJson(template.payload)); setError(null); }
  const dirty = !sameJson(draft, template.payload);
  const edit = (next: TemplatePayload) => { setError(null); setDraft(next); };

  useEffect(() => {
    if (pending || !error?.field || !root.current) return;
    Array.from(root.current.querySelectorAll<HTMLElement>("[data-rule-field]")).find((n) => n.getAttribute("data-rule-field") === error.field)?.focus();
  }, [error, pending]);

  function onSave() {
    setSaid(null); setError(null);
    start(async () => {
      const r = await saveTemplateSteps(template.id, draft);
      if (r.ok) { setSaid({ tone: "ok", text: "Saved. Onboardings already started keep the steps they were started with; the next ones use these." }); router.refresh(); return; }
      setError({ field: r.refusal.error === "invalid_field" ? r.refusal.field ?? null : null, message: r.message });
      setSaid({ tone: "error", text: `Not saved. ${r.message}` });
    });
  }

  const phaseOpts = draft.phases.map((p) => ({ value: p.key, label: p.title || p.key }));
  const roleOpts = draft.roles.map((r) => ({ value: r.key, label: r.label || r.key }));
  const L = TEMPLATE_LIMITS;
  return (
    <div ref={root} className="rules__panel" data-slot="onboarding-steps" role="group" aria-labelledby="onb-steps-title">
      <div className="rules__head"><h4 className="rules__title" id="onb-steps-title">Steps of &ldquo;{template.name}&rdquo;</h4></div>
      <p className="scp-note" style={{ margin: 0 }}>
        Phases, roles and steps of the company&rsquo;s onboarding checklist, as a Project Management template. Each step is due a number of working days after the kickoff. If someone else is editing this template at the same
        time, the last save wins.
      </p>
      <RulesErrorContext.Provider value={error}>
        <fieldset className="rules__fields" disabled={pending}>
          <legend className="rules__sr">Steps of {template.name}</legend>
          <TextField path="payload.title" label="Project title" value={draft.title} maxLength={L.titleMax} wide onChange={(title) => edit({ ...draft, title })} hint="The name the client's onboarding project is given." />

          <Group path="payload.phases" legend={`Phases (${draft.phases.length} of ${L.phases.max})`}>
            <ol className="rules__items">
              {draft.phases.map((p, i) => (
                <li key={p.key} className="rules__item" aria-label={`Phase ${i + 1}: ${p.title}`}>
                  <div className="rules__row">
                    <TextField path={`payload.phases.${i}.title`} label={`Phase ${i + 1} name`} value={p.title} maxLength={L.labelMax} wide onChange={(title) => edit({ ...draft, phases: draft.phases.map((x, j) => (j === i ? { ...x, title } : x)) })} />
                    <ItemButtons
                      label={`phase ${i + 1}, ${p.title}`} index={i} count={draft.phases.length} onMove={(d) => edit({ ...draft, phases: moveItem(draft.phases, i, d) })}
                      onRemove={() => edit({ ...draft, phases: draft.phases.filter((_, j) => j !== i) })} removeDisabled={draft.phases.length <= L.phases.min || phaseInUse(draft, p.key)}
                      removeHint={phaseInUse(draft, p.key) ? "Steps still use this phase. Move or remove them first." : "A template keeps at least one phase."}
                    />
                  </div>
                </li>
              ))}
            </ol>
            <div className="rules__buttons">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={draft.phases.length >= L.phases.max} onClick={() => edit({ ...draft, phases: [...draft.phases, newPhase(draft.phases.map((x) => x.key))] })}>Add a phase</button>
            </div>
          </Group>

          <Group path="payload.roles" legend={`Roles (${draft.roles.length} of ${L.roles.max})`} hint="A role is who a step is for: when onboarding starts, each role is given a person.">
            <ol className="rules__items">
              {draft.roles.map((r, i) => (
                <li key={r.key} className="rules__item" aria-label={`Role ${i + 1}: ${r.label}`}>
                  <div className="rules__row">
                    <TextField path={`payload.roles.${i}.label`} label={`Role ${i + 1} name`} value={r.label} maxLength={L.labelMax} wide onChange={(label) => edit({ ...draft, roles: draft.roles.map((x, j) => (j === i ? { ...x, label } : x)) })} />
                    <ItemButtons
                      label={`role ${i + 1}, ${r.label}`} index={i} count={draft.roles.length} onMove={(d) => edit({ ...draft, roles: moveItem(draft.roles, i, d) })}
                      onRemove={() => edit({ ...draft, roles: draft.roles.filter((_, j) => j !== i) })} removeDisabled={draft.roles.length <= L.roles.min || roleInUse(draft, r.key)}
                      removeHint={roleInUse(draft, r.key) ? "Steps still use this role. Change them first." : "A template keeps at least one role."}
                    />
                  </div>
                </li>
              ))}
            </ol>
            <div className="rules__buttons">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={draft.roles.length >= L.roles.max} onClick={() => edit({ ...draft, roles: [...draft.roles, newRole(draft.roles.map((x) => x.key))] })}>Add a role</button>
            </div>
          </Group>

          <Group path="payload.tasks" legend={`Steps (${draft.tasks.length} of ${L.tasks.max})`}>
            {tasksByPhase(draft).map(({ phase, tasks }) => (
              <section key={phase.key} className="rules__item" aria-label={`Steps of the phase ${phase.title}`}>
                <h5 className="rules__item-title">{phase.title || phase.key}</h5>
                {tasks.length === 0 && <span className="rules__hint">No steps in this phase.</span>}
                <ol className="rules__items">
                  {tasks.map(({ task: t, index }, pos) => (
                    <li key={t.key} className="rules__item" aria-label={`Step ${index + 1}: ${t.title}`}>
                      <div className="rules__item-head">
                        <h6 className="rules__item-title">Step {index + 1} · {offsetWords(t.dueOffsetWorkingDays)}</h6>
                        <ItemButtons
                          label={`step ${index + 1}, ${t.title}`} index={pos} count={tasks.length} onMove={(d) => edit({ ...draft, tasks: moveInPhase(draft.tasks, index, d) })}
                          onRemove={() => edit({ ...draft, tasks: draft.tasks.filter((_, j) => j !== index) })} removeDisabled={draft.tasks.length <= L.tasks.min} removeHint="A template keeps at least one step."
                        />
                      </div>
                      <TextField path={`payload.tasks.${index}.title`} label="Title" value={t.title} maxLength={L.titleMax} wide onChange={(title) => edit({ ...draft, tasks: draft.tasks.map((x, j) => (j === index ? { ...x, title } : x)) })} />
                      <div className="rules__row">
                        <SelectField path={`payload.tasks.${index}.phase`} label="Phase" value={t.phase} options={phaseOpts} onChange={(v) => edit({ ...draft, tasks: draft.tasks.map((x, j) => (j === index ? { ...x, phase: v } : x)) })} />
                        <SelectField path={`payload.tasks.${index}.role`} label="Role" value={t.role} options={roleOpts} onChange={(v) => edit({ ...draft, tasks: draft.tasks.map((x, j) => (j === index ? { ...x, role: v } : x)) })} />
                        <NumberField
                          path={`payload.tasks.${index}.dueOffsetWorkingDays`} label="Working days after the kickoff" value={t.dueOffsetWorkingDays} min={L.offset.min} max={L.offset.max}
                          onChange={(n) => edit({ ...draft, tasks: draft.tasks.map((x, j) => (j === index ? { ...x, dueOffsetWorkingDays: n } : x)) })} hint="0 to 250. 0 is the kickoff day."
                        />
                      </div>
                      <TextField path={`payload.tasks.${index}.description`} label="Description" value={t.description ?? ""} multiline maxLength={L.descriptionMax} wide
                        onChange={(description) => edit({ ...draft, tasks: draft.tasks.map((x, j) => (j === index ? { ...x, description } : x)) })} />
                      <TextField path={`payload.tasks.${index}.subtasks`} label="Sub-steps, one per line" value={(t.subtasks ?? []).join("\n")} multiline wide
                        onChange={(s) => edit({ ...draft, tasks: draft.tasks.map((x, j) => (j === index ? { ...x, subtasks: s === "" ? [] : s.split("\n") } : x)) })} hint="At most 20; an empty line is left out." />
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            <div className="rules__buttons">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={draft.tasks.length >= L.tasks.max || draft.phases.length === 0 || draft.roles.length === 0}
                onClick={() => edit({ ...draft, tasks: [...draft.tasks, newTask(draft)] })}>Add a step</button>
            </div>
          </Group>
        </fieldset>
      </RulesErrorContext.Provider>

      {said && <p className={`scp-msg scp-msg--${said.tone}`} role={said.tone === "error" ? "alert" : "status"} style={{ margin: 0 }}>{said.text}</p>}
      <div className="rules__buttons">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onSave} disabled={pending || !dirty}>{pending ? "Working…" : "Save the template's steps"}</button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setDraft(cloneJson(template.payload)); setError(null); setSaid(null); }} disabled={pending || !dirty}>Discard changes</button>
      </div>
    </div>
  );
}
