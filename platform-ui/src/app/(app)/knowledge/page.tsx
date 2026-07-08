import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getSystemStatus, getKnowledgeSources } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReviewButtons } from "@/components/systems/ReviewButtons";
import { reviewSource } from "./actions";

// Knowledge is tenant-scoped — the knowledge/memory platform (D9) keeps
// provenance and quarantine per company. This page renders METADATA ONLY
// (source name, provenance, status) — never document content.
export default async function KnowledgePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const [status, sources] = await Promise.all([
    getSystemStatus(userId, "knowledge"),
    tenant ? getKnowledgeSources(userId, tenant) : Promise.resolve([]),
  ]);

  const quarantined = sources.filter((s) => s.status === "quarantined");

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Knowledge"
        subtitle="The knowledge/memory platform for this company — source provenance, pre-filter-before-rank retrieval and quarantine review. Metadata only, never document content."
      />

      <StatusCard status={status} />

      <div style={{ marginTop: 20 }}>
        <Card title="Sources">
          {sources.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Source" }, { label: "Provenance" }, { label: "Status" }]}
              rows={sources.map((s) => [
                s.source,
                s.provenance ?? "—",
                <StatusBadge key={`${s.id}-status`} label={s.status} />,
              ])}
            />
          ) : (
            <EmptyNote>Knowledge sources appear once the knowledge admin API is connected.</EmptyNote>
          )}
        </Card>
      </div>

      {quarantined.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Card title="Quarantine">
            <HairlineTable
              columns={[{ label: "Source" }, { label: "Provenance" }, { label: "Review", align: "right" }]}
              rows={quarantined.map((s) => [
                s.source,
                s.provenance ?? "—",
                <ReviewButtons
                  key={s.id}
                  approveAction={reviewSource.bind(null, s.id, "approved")}
                  rejectAction={reviewSource.bind(null, s.id, "rejected")}
                />,
              ])}
            />
          </Card>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <Card title="Search test console">
          <Field name="query" label="Query" disabled />
          <p style={{ margin: "10px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
            Search testing arrives once the knowledge admin API is connected.
          </p>
        </Card>
      </div>
    </>
  );
}
