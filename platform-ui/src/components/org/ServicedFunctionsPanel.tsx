import type { Envelope } from "@/lib/envelope";
import type { AssignmentSummary } from "@/lib/serviceAssignments";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import { ServiceAssignmentRow } from "./ServiceAssignmentRow";
import "./services.css";

// ORG-13 — "Serviced functions" panel on the TARGET org page: which other
// companies' departments currently serve THIS company, with orphaned/
// suspended banners and the target-side lifecycle actions the contract
// allows (suspend/resume/revoke — "either side"; re-link is provider-only,
// so it's deliberately absent here, see /admin/services for the provider
// perspective which does offer it). Renders nothing when nobody serves this
// company (no empty-state clutter for the common case).
export function ServicedFunctionsPanel({
  envelope,
  onSuspend,
  onResume,
  onRevoke,
}: {
  envelope: Envelope<AssignmentSummary>;
  onSuspend: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onResume: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onRevoke: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const rows = envelope.items.filter((a) => a.status !== "revoked");
  if (rows.length === 0) return null;

  return (
    <section className="svc-panel" aria-label="Serviced functions">
      <div className="svc-panel__head">
        <span className="svc-panel__eyebrow">Serviced by other companies</span>
      </div>
      <EnvelopeBanner companies={envelope.companies} />
      <ul className="svc-list">
        {rows.map((a) => (
          <ServiceAssignmentRow
            key={a.id}
            a={a}
            label={`${a.providerCompanyName ?? a.providerTenantId} · ${a.unitName}`}
            actions={{ suspend: onSuspend, resume: onResume, revoke: onRevoke }}
          />
        ))}
      </ul>
    </section>
  );
}
