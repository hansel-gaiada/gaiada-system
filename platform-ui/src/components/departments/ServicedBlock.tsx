import type { Envelope } from "@/lib/envelope";
import type { ServicedCompanyRow } from "@/lib/departments";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import { StatusBadge } from "@/components/ui";
import "./departments.css";

// UX-2 §3 — "ServicedBlock": renders only when this department currently
// serves at least one other company (§3.3 "Not-serviced (default today):
// Serviced block does not render at all — no empty-state clutter for the 99%
// of departments that don't serve other companies yet"). Read-only here —
// lifecycle actions (suspend/resume/revoke) live on the org page's
// ServicedFunctionsPanel and /admin/services, not this workspace glance view.
export function ServicedBlock({
  envelope,
  scope,
  buildHref,
}: {
  envelope: Envelope<ServicedCompanyRow>;
  scope: "all" | string;
  buildHref: (v: "all" | string) => string;
}) {
  if (envelope.items.length === 0 && envelope.companies.length === 0) return null;

  const visible = scope === "all" ? envelope.items : envelope.items.filter((i) => i.companyId === scope);
  const companies = envelope.companies.map((c) => ({ id: c.id, name: c.name }));

  return (
    <section className="serviced-block" aria-label="Serviced companies">
      <div className="serviced-block__head">
        <span className="serviced-block__eyebrow">Serviced</span>
        <ScopePill companies={companies} value={scope} onChangeHref={buildHref} allLabel="All served" />
      </div>
      {scope === "all" && <EnvelopeBanner companies={envelope.companies} />}
      {visible.length === 0 ? (
        <p className="serviced-block__empty">No active service in this scope.</p>
      ) : (
        <ul className="serviced-block__list">
          {visible.map((row) => (
            <li key={row.assignmentId} className="serviced-block__row">
              <span className="serviced-block__company">{row.companyName}</span>
              <span className="serviced-block__module">{row.module}</span>
              <StatusBadge label={row.unitStatus === "orphaned" ? "orphaned" : row.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
