"use client";
// SCP-5 W5-C5 (BFF §63.29.2, §63.30.1) — the Onboarding section of the settings page: which Project Management template is the company's onboarding checklist (the picker, `PUT settings`), and that template's
// phases, roles and steps (edited through PM's own template routes). It is not a rules section: nothing here is versioned by the rules routes, and no Reset applies (the checklist is the company's own).
//
// WHO SEES WHAT. The four (`canEdit`, the settings read's `canPlan`) choose the template. Listing and editing templates is PM's own gate (`pm_task` · `manage`), so a person without it still sees the chosen template's
// name and is told why the steps cannot be shown. A refused read says so and a failed one says it cannot tell; neither draws an empty picker.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OnboardingTemplateEditor } from "@/components/social/OnboardingTemplateEditor";
import type { ReadResult } from "@/lib/readResult";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import type { ProjectTemplate } from "@/lib/socialOnboardingTemplate";
import { chooseOnboardingTemplate } from "@/lib/socialOnboardingTemplateActions";
import "@/components/social/cycles.css";
import "@/components/social/rules.css";

function Picker({ chosen, templates }: { chosen: { id: string; name: string } | null; templates: ProjectTemplate[] }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(chosen?.id ?? "");
  const [seen, setSeen] = useState(chosen?.id ?? "");
  const [said, setSaid] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (seen !== (chosen?.id ?? "")) { setSeen(chosen?.id ?? ""); setValue(chosen?.id ?? ""); }
  const dirty = value !== (chosen?.id ?? "");
  function save() {
    setSaid(null);
    start(async () => {
      const r = await chooseOnboardingTemplate(value === "" ? null : value);
      if (!r.ok) { setSaid({ tone: "error", text: `Not saved. ${r.message}` }); return; }
      setSaid({ tone: "ok", text: value === "" ? "No template is chosen now. Starting an onboarding will say so until one is." : "Saved. New onboardings start from this template." });
      router.refresh();
    });
  }
  return (
    <div className="rules__field">
      <label htmlFor={id}>The company&rsquo;s onboarding template</label>
      <div className="rules__row">
        <select id={id} className="scp-input" value={value} onChange={(e) => setValue(e.target.value)} disabled={pending} aria-describedby={`${id}-hint`}>
          <option value="">No template chosen</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={save} disabled={pending || !dirty}>{pending ? "Working…" : "Save the choice"}</button>
      </div>
      <span className="rules__hint" id={`${id}-hint`}>A project template from Project Management. Each client&rsquo;s onboarding project is made from it, with every step due a number of working days after the kickoff.</span>
      {said && <p className={`scp-msg scp-msg--${said.tone}`} role={said.tone === "error" ? "alert" : "status"} style={{ margin: 0 }}>{said.text}</p>}
    </div>
  );
}

export function RulesOnboarding({ canEdit, chosen, templates }: {
  /** The settings read's `canPlan`: may this person choose the template? */
  canEdit: boolean;
  /** The company's template, from `GET settings`. */
  chosen: { id: string; name: string } | null;
  /** `GET pm/templates?kind=project` as the page read it, or null when it was not read (the person may not choose). */
  templates: ReadResult<ProjectTemplate[]> | null;
}) {
  const chosenTemplate = templates?.kind === "ok" && chosen ? templates.data.find((t) => t.id === chosen.id) ?? null : null;
  return (
    <section aria-labelledby="rules-group-onboarding" className="scp-slot" data-slot="rules-onboarding">
      <h3 className="scp-slot__title" id="rules-group-onboarding">Onboarding</h3>
      <p className="scp-note" style={{ marginTop: 0, marginBottom: 12 }}>
        Every new client goes through the company&rsquo;s checklist, as tasks in the client&rsquo;s own project. The checklist is a Project Management template: choose which one here, and edit its steps below. An onboarding
        already started keeps the steps it was started with.
      </p>
      <div className="rules">
        <div className="rules__panel" data-slot="onboarding-template">
          {!canEdit && (
            <>
              <p className="scp-note scp-note--reason" style={{ margin: 0 }}>{PLAN_REFUSAL_REASON} You can read the template here.</p>
              <p style={{ margin: 0 }}>{chosen ? <>The company&rsquo;s onboarding template is <strong>{chosen.name}</strong>.</> : "No onboarding template is chosen yet."}</p>
            </>
          )}
          {canEdit && templates?.kind === "ok" && <Picker chosen={chosen} templates={templates.data} />}
          {canEdit && templates?.kind === "forbidden" && (
            <p className="scp-note" role="status" style={{ margin: 0 }}>
              {chosen ? <>The company&rsquo;s onboarding template is <strong>{chosen.name}</strong>. </> : "No onboarding template is chosen yet. "}
              The templates cannot be listed for you: choosing and editing them needs the right to manage Project Management templates.
            </p>
          )}
          {canEdit && templates?.kind === "unavailable" && (
            <p className="scp-note" role="status" style={{ margin: 0 }}>
              The templates cannot be shown right now ({templates.reason}). {chosen ? <>The company&rsquo;s template is still <strong>{chosen.name}</strong>. </> : ""}Try again in a moment.
            </p>
          )}
          {canEdit && templates === null && <p className="scp-note" role="status" style={{ margin: 0 }}>The templates were not read.</p>}
        </div>
        {canEdit && templates?.kind === "ok" && chosen && !chosenTemplate && (
          <p className="scp-note" role="status" style={{ margin: 0 }}>The chosen template, {chosen.name}, is not in the list of live project templates, so its steps cannot be shown. Choose another or ask for it to be restored.</p>
        )}
        {chosenTemplate && canEdit && <OnboardingTemplateEditor key={chosenTemplate.id} template={chosenTemplate} />}
        {canEdit && templates?.kind === "ok" && !chosen && <p className="scp-note" role="status" style={{ margin: 0 }}>Choose a template above to see and edit its steps.</p>}
      </div>
    </section>
  );
}
