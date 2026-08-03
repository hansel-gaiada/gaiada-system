"use client";
import { useActionState } from "react";
import { Field } from "./Field";
import { Eyebrow, Button } from "@/components/ui";
import type { Company } from "@/lib/entities";
import "./forms.css";

export interface CompanyFormState { error?: string }

const TYPES = ["agency", "resort", "printing", "marine", "retail", "holding", "other"];
const MODULES = ["agency"]; // known toggleable modules today

export function CompanyForm({
  action, companies, company,
}: {
  action: (prev: CompanyFormState | null, formData: FormData) => Promise<CompanyFormState>;
  companies: { id: string; name: string }[];
  company?: Company & { parent_company_id?: string | null };
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const parents = companies.filter((c) => c.id !== company?.id);

  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      <Field name="name" label="Company name" required defaultValue={company?.name} />
      <Field name="type" label="Type" type="select" options={TYPES} defaultValue={company?.type ?? "agency"} />
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Parent (holding)</Eyebrow>
        <select name="parentCompanyId" className="lux-field__control" defaultValue={company?.parent_company_id ?? (companies[0]?.id ?? "")}>
          <option value="">— none (top level) —</option>
          {parents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {company && <Field name="status" label="Status" type="select" options={["active", "suspended", "archived"]} defaultValue={company.status} />}
      {/* Modules are only settable at CREATE time here. On edit this form must not touch them:
          it knows about `agency` alone, so submitting the checkbox set would silently strip every
          other enabled module (hr, pm, reports, …) from the company. Editing goes through
          Settings → Modules & Fields, which lists the full catalog one key at a time. */}
      {company ? (
        <div className="lux-field" style={{ gridColumn: "1 / -1" }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Enabled modules</Eyebrow>
          <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
            {(company.enabled_modules ?? []).join(", ") || "None"} — change these in Settings → Modules &amp; Fields.
          </p>
        </div>
      ) : (
        <label className="lux-field lux-field--checkbox">
          <input type="checkbox" name="module_agency" className="lux-field__checkbox" />
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Enable Agency module</Eyebrow>
        </label>
      )}

      {state?.error && (
        <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{state.error}</p>
      )}
      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : company ? "Save company" : "Create company"}</Button>
      </div>
      {/* Create-only: the module set is derived from the checkbox(es) above. Absent on edit, so
          updateCompanyAction omits `modules` entirely and the backend's COALESCE keeps the
          existing array. */}
      {!company && <input type="hidden" name="knownModules" value={MODULES.join(",")} />}
    </form>
  );
}
