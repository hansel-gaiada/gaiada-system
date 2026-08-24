import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listExpiringDocuments } from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR › Compliance — document expiry (HR-FULL wave A).
//
// Before this existed, an expired work permit, an expired contract and a current one were
// byte-identical to every query in the system. Three nullable columns on `hr_records` and a reminder
// ledger closed that; this page is the read.
//
// ⚠ ALREADY-EXPIRED ROWS ARE ALWAYS SHOWN, whatever the window. A permit that lapsed three months
//   ago is more urgent than one lapsing next week, and a naive "next 90 days" filter hides it
//   completely — which is the failure mode this page exists to prevent, not to reproduce.
export default async function HrCompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const { days } = await searchParams;
  const window = Math.max(1, Math.min(365, Number(days ?? 90) || 90));
  const { documents } = await listExpiringDocuments(userId, tenant, window);

  const expired = documents.filter((d) => d.expired);
  const soon = documents.filter((d) => !d.expired && d.daysRemaining <= 30);
  const later = documents.filter((d) => !d.expired && d.daysRemaining > 30);

  const table = (rows: typeof documents) => (
    <HairlineTable
      columns={[
        { label: "Person" }, { label: "Type" }, { label: "Reference" },
        { label: "Expires" }, { label: "Days", align: "right" },
      ]}
      rows={rows.map((d) => [
        d.subjectName ?? "—",
        d.recordType,
        d.reference ?? "—",
        d.expiresOn,
        // Negative days read as "expired 12 days ago", which is the sentence somebody needs.
        d.expired ? `${Math.abs(d.daysRemaining)}d ago` : String(d.daysRemaining),
      ])}
    />
  );

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Expired" value={String(expired.length)} foot="already lapsed" />
        <KpiTile label="Within 30 days" value={String(soon.length)} />
        <KpiTile label={`Within ${window} days`} value={String(later.length)} foot="beyond 30 days" />
        <KpiTile label="Tracked" value={String(documents.length)} foot="documents with an expiry date" />
      </div>

      {expired.length > 0 && (
        <Card
          title="Expired — act now"
          hint="Shown regardless of the window. An already-lapsed document does not become less urgent by falling outside a date filter."
          style={{ marginBottom: 22 }}
        >
          {table(expired)}
        </Card>
      )}

      <Card title="Expiring within 30 days" style={{ marginBottom: 22 }}>
        {soon.length === 0 ? <EmptyNote>Nothing lapses in the next 30 days.</EmptyNote> : table(soon)}
      </Card>

      <Card title={`Expiring within ${window} days`}>
        {later.length === 0 ? (
          <EmptyNote>
            Nothing else in this window.
            {documents.length === 0 && (
              <>
                {" "}Note that only records carrying an <code>expiresOn</code> date appear here — a contract
                uploaded without one is invisible to this page and to the reminder sweep, which is a real gap
                in the data rather than a clean bill of health.
              </>
            )}
          </EmptyNote>
        ) : table(later)}
      </Card>
    </>
  );
}
