import Link from "next/link";
import {
  registry,
  allDepts,
  deptEnabled,
  type CentreDraft,
} from "@/lib/clientCentre";
import { FieldControl } from "./FieldControl";
import { Breadcrumb } from "./Breadcrumb";

// CMC's `renderGeneral`: company name (READ-ONLY, CC-D5) + business type select, the shared general
// field groups, department toggles, and — instead of CMC's "Delete company"/"New company" (CC-D5:
// not rebuilt) — a staff-only link back to the existing Clients edit/delete flow.
export function CompanySettingsView({
  clientName,
  draft,
  canEdit,
  staffClientHref,
  onFieldChange,
  onBusinessTypeChange,
  onDeptToggle,
}: {
  clientName: string;
  draft: CentreDraft;
  canEdit: boolean;
  /** Staff only: `/clients/:id`, the existing client edit/delete flow. Undefined in the portal. */
  staffClientHref?: string;
  onFieldChange: (key: string, value: string) => void;
  onBusinessTypeChange: (businessType: string) => void;
  onDeptToggle: (deptId: string, enabled: boolean) => void;
}) {
  const depts = allDepts(registry, draft.businessType);
  return (
    <div className="cc-content">
      <Breadcrumb items={[clientName, "Company settings"]} />
      <div className="cc-head-row"><h1>Company settings</h1></div>
      <p className="cc-lede">
        The basics every section shares. Each section&apos;s own settings page adds what that specialist
        needs on top. Changes save automatically.
      </p>

      <h2 className="cc-sec-h">Company</h2>
      <div className="cc-form">
        <label className="cc-field" htmlFor="cc-company-name">
          <span className="cc-field__label">
            Company name (shown in the app)
            {staffClientHref && (
              <Link href={staffClientHref} className="cc-shared" style={{ color: "var(--erp-accent)" }}>
                Edit in Clients
              </Link>
            )}
          </span>
          {/* CC-D5: read-only for EVERY caller here — it is the CRM `clients.name` shown on issued
              invoices and signed contracts; only the Clients edit flow may rename it. */}
          <span className="cc-readonly-value" id="cc-company-name">{clientName}</span>
        </label>
        <label className="cc-field" htmlFor="cc-business-type">
          <span className="cc-field__label">Business type</span>
          {canEdit ? (
            <select
              id="cc-business-type"
              className="cc-select"
              value={draft.businessType}
              onChange={(e) => onBusinessTypeChange(e.target.value)}
            >
              {registry.businessTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          ) : (
            <span className="cc-readonly-value">{registry.businessTypes.find((t) => t.id === draft.businessType)?.label ?? "Other"}</span>
          )}
        </label>
      </div>

      {registry.generalFields.map((g) => (
        <div key={g.title}>
          <h2 className="cc-sec-h">{g.title}</h2>
          <div className="cc-form">
            {g.keys.map((k) => (
              <FieldControl
                key={k}
                fieldKey={k}
                value={draft.profile[k] ?? ""}
                businessType={draft.businessType}
                canEdit={canEdit}
                onChange={onFieldChange}
              />
            ))}
          </div>
        </div>
      ))}
      {draft.profile.maps && (
        <p className="cc-lede" style={{ marginTop: 12 }}>
          <a href={draft.profile.maps} target="_blank" rel="noopener">Open in Google Maps</a>
        </p>
      )}

      <h2 className="cc-sec-h">Departments</h2>
      <p className="cc-lede" style={{ marginBottom: 12 }}>
        Choose which departments this business uses. The first one is specific to your business type.
      </p>
      <div className="cc-toggles">
        {depts.map((d) => (
          <label className="cc-toggle" key={d.id}>
            <input
              type="checkbox"
              checked={deptEnabled(registry, draft.businessType, draft.departments, d.id)}
              disabled={!canEdit}
              onChange={(e) => onDeptToggle(d.id, e.target.checked)}
            />
            <span>{d.name}</span>
          </label>
        ))}
      </div>

      {staffClientHref && (
        <>
          <h2 className="cc-sec-h">Manage this client</h2>
          <div className="cc-danger">
            <span className="cc-field__help">
              Renaming, archiving or deleting {clientName} happens on the Clients page, not here.
            </span>
            <Link href={staffClientHref} className="lux-btn lux-btn--ghost lux-btn--sm">Open in Clients</Link>
          </div>
        </>
      )}    </div>
  );
}
