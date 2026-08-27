import Link from "next/link";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { formatDateTime } from "@/lib/format";
import { DegradeBanner } from "./DegradeBanner";
import {
  isBehindLatest,
  type SiteConsoleRow, type ContractPinStatus, type DegradeMeta,
} from "@/lib/webdesk";

/** design §08 v1.1: "content and frontend promote independently, so the row splits into two
 *  columns — a single merged env chip hides the question people actually ask." This is the
 *  BACKEND half: derived from the newest of the three release-family facts WSK-23's contract
 *  actually guarantees (`kind` + `receivedAt` — never anything out of the untyped `data` payload,
 *  which the contract itself flags as unpinned/best-effort until a real emitter exists). No env
 *  column exists on `webdev_provisioned_sites` today (flagged in this ticket's report), so this is
 *  inferred from release facts, not read off a field that doesn't exist. */
export function backendEnvState(site: SiteConsoleRow): { label: string; asOf: string | null } {
  const candidates = [
    site.lastKnownPromotion && { label: "Production", fact: site.lastKnownPromotion },
    site.lastKnownRollback && { label: "Rolled back", fact: site.lastKnownRollback },
    site.lastKnownDeployment && { label: "Staging", fact: site.lastKnownDeployment },
  ].filter((c): c is { label: string; fact: NonNullable<SiteConsoleRow["lastKnownDeployment"]> } => c !== null);
  if (candidates.length === 0) return { label: "No deploy on file", asOf: null };
  const newest = candidates.sort((a, b) => b.fact.receivedAt.localeCompare(a.fact.receivedAt))[0];
  return { label: newest.label, asOf: newest.fact.receivedAt };
}

/** The FRONTEND half of the same split. Unlike backend env, there is genuinely NO data source for
 *  this yet anywhere in the stack: no field on `ProvisionedSite`, no fact kind in
 *  `webdev_zoneb_event_log`'s CHECK-enumerated vocabulary names a deploy target, and the routing
 *  rule itself (WSK-D26: delphi staging / helios production / Hostinger for WP) is blocked on an
 *  owner ruling plus host reachability (design §03a) — it cannot even be executed yet, only
 *  planned. Rendering anything per-row here would be fabricating a value the backend has never
 *  sent; the honest answer is the same fixed sentence on every row until a real bridge fact exists. */
const FRONTEND_DEPLOYMENT_NOTE = "Not reported — WSK-D26 (delphi/helios/Hostinger) has no deploy state reaching the ERP yet.";

function contractCell(slug: string, pins: ContractPinStatus[], pinsAvailable: boolean) {
  if (!pinsAvailable) return <span style={{ color: "var(--erp-ink-50)" }}>—</span>;
  const pin = pins.find((p) => p.webdeskTenantSlug === slug);
  if (!pin) return <span style={{ color: "var(--erp-ink-50)" }}>No pin on file</span>;
  const behind = isBehindLatest(pin);
  if (behind === null) {
    return <span style={{ color: "var(--erp-ink-50)" }}>{pin.pinned ? `@ ${pin.pinned.contractVersion} (latest unknown)` : "Unpinned"}</span>;
  }
  return (
    <span style={{ color: behind ? "var(--status-critical-fg)" : "var(--status-ok-fg)" }}>
      {behind ? `@ ${pin.pinned!.contractVersion} (behind — latest ${pin.latest.version})` : `@ ${pin.pinned!.contractVersion} (current)`}
    </span>
  );
}

export function SiteRegistryPanel({
  deptId, sites, meta, pins, pinsAvailable,
}: {
  deptId: string;
  sites: SiteConsoleRow[];
  meta: DegradeMeta;
  pins: ContractPinStatus[];
  /** false when the contract-pins read itself was refused/not-enabled — distinct from "read OK,
   *  zero pins" (an empty result read as no-data is the exact failure mode this whole tab exists
   *  to avoid rendering). */
  pinsAvailable: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <DegradeBanner meta={meta} subject="this site registry" />

      {sites.length === 0 ? (
        <TeachState
          glyph="◇"
          title="No sites provisioned yet"
          body="Sites provisioned for this company through WebDesk will list here, along with their contract pin, release history, and submissions."
        />
      ) : (
        <Card title="Site registry">
          <HairlineTable
            columns={[
              { label: "Site" }, { label: "Status" }, { label: "Backend env" },
              { label: "Frontend deployment" }, { label: "Contract" },
            ]}
            tcols="1.4fr 1fr 1.2fr 1.6fr 1.4fr"
            rows={sites.map((s) => {
              const env = backendEnvState(s);
              return [
                <Link key="slug" href={`/departments/${deptId}/sites/${encodeURIComponent(s.slug)}`}>
                  {s.slug}
                </Link>,
                <StatusBadge key="status" label={s.status} />,
                <span key="env">
                  {env.label}
                  {env.asOf && <span style={{ display: "block", font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>as of {formatDateTime(env.asOf)}</span>}
                </span>,
                <span key="frontend" style={{ color: "var(--erp-ink-50)", fontStyle: "italic" }}>{FRONTEND_DEPLOYMENT_NOTE}</span>,
                <span key="contract">{contractCell(s.slug, pins, pinsAvailable)}</span>,
              ];
            })}
          />
        </Card>
      )}
    </div>
  );
}
