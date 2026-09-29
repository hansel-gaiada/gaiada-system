import {
  registry,
  allDepts,
  deptEnabled,
  type CentreDraft,
} from "@/lib/clientCentre";
import { FieldControl } from "./FieldControl";
import { Breadcrumb } from "./Breadcrumb";

// CMC's `renderGeneral`, titled "Business details" (CC-D9; CMC called it "Company settings", which
// collides with the ERP's own companies): client name (READ-ONLY, CC-D5) + business type select, the
// shared general field groups and department toggles. CMC's "Delete company"/"New company" are not
// rebuilt (CC-D5); on the staff side this view sits inside the client hub, whose header has Delete.
export function CompanySettingsView({
  clientName,
  draft,
  canEdit,
  isPortal,
  onFieldChange,
  onBusinessTypeChange,
  onDeptToggle,
}: {
  clientName: string;
  draft: CentreDraft;
  canEdit: boolean;
  isPortal: boolean;
  onFieldChange: (key: string, value: string) => void;
  onBusinessTypeChange: (businessType: string) => void;
  onDeptToggle: (deptId: string, enabled: boolean) => void;
}) {
  const depts = allDepts(registry, draft.businessType);
  return (
    <div className="cc-content">
      <Breadcrumb items={[clientName, "Business details"]} />
      <div className="cc-head-row"><h1>Business details</h1></div>
      <p className="cc-lede">
        The basics every section shares. Each section&apos;s own settings page adds what that specialist
        needs on top. Changes save automatically.
      </p>

      <h2 className="cc-sec-h">Business</h2>
      <div className="cc-form">
        <label className="cc-field" htmlFor="cc-company-name">
          <span className="cc-field__label">
            {isPortal ? "Name" : "Client name"}
          </span>
          {/* CC-D5: read-only for EVERY caller here — it is the CRM `clients.name` shown on issued
              invoices and signed contracts. */}
          <span className="cc-readonly-value" id="cc-company-name">{clientName}</span>
          <span className="cc-field__help">
            {isPortal
              ? "This is the name on your invoices and contracts. Ask your account manager to change it."
              : "This is the name on invoices and contracts. Change it with Edit at the top of the client page."}
          </span>
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
    </div>
  );
}
