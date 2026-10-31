// SCP-5 W5-C5 (BFF §63.30.5) — the company rules on {D}/settings: one section each (Reports with the ideas settings, Monthly cycle, Audit scorecard, Saved, Onboarding), in their own components so
// the rest of the page is not touched. The page reads `GET rules` once and hands it here; the component is not async because the page's tests render it in a browser DOM.
//
// A refused read says so and a failed read says it cannot tell. Neither draws the defaults, which would pass for the company's own values: a company that changed a rule would be read the wrong one.
import type { ReadResult } from "@/lib/readResult";
import type { RulesAnswer } from "@/lib/socialRules";
import type { ClientChoice } from "@/components/social/RulesPreview";
import { RulesReports } from "@/components/social/RulesReports";
import { RulesCycle } from "@/components/social/RulesCycle";
import { RulesAudit } from "@/components/social/RulesAudit";
import { RulesSaved } from "@/components/social/RulesSaved";
import { RulesOnboarding } from "@/components/social/RulesOnboarding";
import type { ProjectTemplate } from "@/lib/socialOnboardingTemplate";
import "@/components/social/cycles.css";
import "@/components/social/rules.css";

export function CompanyRules({ rules, clients, onboarding }: {
  /** `GET rules` as the page read it. */
  rules: ReadResult<RulesAnswer>;
  /** The open clients of the company, for the previews that name one; null when they could not be read. */
  clients: ClientChoice[] | null;
  /** The onboarding template: not a rules section (PM keeps it), so it has its own reads. `canEdit` is the settings read's `canPlan`. */
  onboarding: { canEdit: boolean; chosen: { id: string; name: string } | null; templates: ReadResult<ProjectTemplate[]> | null };
}) {
  const a = rules.kind === "ok" ? rules.data : null;
  return (
    <div className="rules" data-slot="company-rules">
      {a ? (
        <>
          <RulesReports answer={a} clients={clients} />
          <RulesCycle answer={a} clients={clients} />
          <RulesAudit answer={a} clients={clients} />
          <RulesSaved answer={a} />
        </>
      ) : (
        <section aria-labelledby="rules-title" className="scp-slot" data-slot="company-rules-unavailable">
          <h3 className="scp-slot__title" id="rules-title">Company rules</h3>
          <p className="scp-note" role="status" style={{ marginTop: 0 }}>
            {rules.kind === "forbidden"
              ? "The company's rules cannot be shown to you: reading them needs a Social Media read tier."
              : `The company's rules cannot be shown right now (${rules.kind === "unavailable" ? rules.reason : ""}). They are not lost, and they are not the defaults; try again in a moment.`}
          </p>
        </section>
      )}
      <RulesOnboarding canEdit={onboarding.canEdit} chosen={onboarding.chosen} templates={onboarding.templates} />
    </div>
  );
}
