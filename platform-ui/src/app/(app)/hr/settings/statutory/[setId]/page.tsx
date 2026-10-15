import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getParameterSetResult } from "@/lib/hr-full-data";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { RatifyButton } from "@/components/hr/PolicyForms";
import { ratifyParameterSet } from "@/lib/hrPolicyActions";

type Params = Promise<{ setId: string }>;

// HR › Settings › one statutory parameter set (DW-7f-5). The list at /hr/settings?tab=statutory links here.
//
// This is where RATIFY lives, beside the numbers being signed off. Ratify is its own server action (`ratify` on hr_policy),
// held by company_admin alone and only at high assurance, so the control is shown only where the capability mirror says
// hr.policy.ratify; the server still decides, and a refusal is shown in its own words. A ratified set shows no control:
// the server refuses a second signature. The set and its parameters come from ONE read, so a refusal refuses both and
// is said in words; a 404 is a real "no such set".
function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export default async function HrStatutorySetPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { setId } = await params;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const back = (
    <p style={{ margin: "0 0 14px", font: "400 13px var(--font-body)" }}>
      <Link href="/hr/settings?tab=statutory" style={{ color: "var(--erp-accent)" }}>← All statutory parameter sets</Link>
    </p>
  );

  const result = await getParameterSetResult(userId, tenant, setId);
  if (result.kind === "forbidden") {
    return <>{back}<ReadRefusal subject="this statutory parameter set" kind="forbidden" /></>;
  }
  if (result.kind === "unavailable") {
    return <>{back}<ReadRefusal subject="This statutory parameter set" kind="unavailable" reason={result.reason} /></>;
  }
  const set = result.data;
  if (!set) notFound();

  const canRatify = can(me, "hr.policy.ratify", tenant);
  const ratified = set.ratified || !!set.ratifiedAt;

  return (
    <>
      {back}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Status" value={ratified ? "Ratified" : "Unratified"} foot={ratified && set.ratifiedAt ? set.ratifiedAt.slice(0, 10) : "not signed off"} />
        <KpiTile label="Effective" value={set.effectiveFrom} foot={`until ${set.effectiveTo ?? "open"}`} />
        <KpiTile label="Country" value={set.countryCode} />
        <KpiTile label="Parameters" value={String(set.parameters.length)} />
      </div>

      <Card
        title={set.name}
        hint="The payroll runner reads these numbers, never a constant in code. A payroll run is approved against a ratified set without an override."
        style={{ marginBottom: 22 }}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0, font: "400 13px var(--font-body)" }}>
            <StatusBadge label={ratified ? "ratified" : "unratified"} /> {set.countryCode} · {set.effectiveFrom} → {set.effectiveTo ?? "open"}
          </p>
          {set.sourceNote && (
            <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)" }}>Source: {set.sourceNote}</p>
          )}
          {ratified ? (
            <p role="note" style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
              This set is ratified. A ratified set cannot be signed again.
            </p>
          ) : canRatify ? (
            <RatifyButton tenantId={tenant} setId={set.id} setName={set.name} action={ratifyParameterSet} />
          ) : (
            <p role="note" style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
              Ratifying a set is a company-administrator act at high assurance, deliberately separate from creating one:
              the routine change that fixes a typo must not also be able to declare the tax tables legally correct.
            </p>
          )}
        </div>
      </Card>

      <Card title="Parameters" hint="Each is a number or a structured value, with its unit where it has one.">
        {set.parameters.length === 0 ? (
          <EmptyNote>This set holds no parameters.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Key" }, { label: "Value", align: "right" }, { label: "Unit" }, { label: "Note" }]}
            rows={set.parameters.map((p) => [
              p.key,
              p.valueNum !== null && p.valueNum !== undefined ? p.valueNum : show(p.valueJson),
              p.unit ?? "—",
              p.note ?? "—",
            ])}
          />
        )}
      </Card>
    </>
  );
}
