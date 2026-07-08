import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listComplianceGates, type ComplianceGate } from "@/lib/adminData";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { GateStatusForm } from "@/components/admin/GateStatusForm";
import { patchGateAction } from "./actions";

const SUBTITLE =
  "The launch gates that must be green before real employee-data ingestion begins.";

export default async function AdminCompliancePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Compliance Gates" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  let gates: ComplianceGate[];
  try {
    gates = await listComplianceGates(userId, tenant);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Admin" title="Compliance Gates" subtitle={SUBTITLE} />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              This page is limited to administrators.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  return (
    <>
      <PageHeader eyebrow="Admin" title="Compliance Gates" subtitle={SUBTITLE} />
      <p style={{ margin: "0 2px 16px", font: "400 13px/1.5 var(--font-body)", color: "rgba(26,25,22,.5)", maxWidth: 640 }}>
        Real employee-data ingestion does not begin until every gate below is green — including the
        technical day-one gate (G.4: crypto-shred + scrubber) and the legal gates (G.1 lawful basis/DPIA/LIA,
        G.6 counsel engaged).
      </p>

      {gates.length === 0 ? (
        <EmptyNote>No compliance gates configured yet.</EmptyNote>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {gates.map((gate) => (
            <Card
              key={gate.id}
              title={`${gate.key} — ${gate.title}`}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "rgba(26,25,22,.65)" }}>
                  {gate.description}
                </p>
                {gate.evidence_url && (
                  <a
                    href={gate.evidence_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}
                  >
                    Evidence
                  </a>
                )}
                <GateStatusForm gate={gate} action={patchGateAction.bind(null, gate.id)} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
