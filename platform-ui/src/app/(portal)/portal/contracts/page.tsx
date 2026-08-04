import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalContracts } from "@/lib/portal-data";
import { money, portalDate, relativeDays } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalFacts, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-14 — the client's agreements. Called "Agreements" in the UI and `contracts` in the schema: the
// former is what a client says, the latter is what the table is.
//
// Anything awaiting their signature is hoisted to the top under its own heading. `draft` contracts never
// reach this page (the BFF excludes them) — a draft is our working copy, and showing a client terms
// nobody has decided to offer them is worse than showing nothing.
export default async function PortalContractsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const contracts = await listPortalContracts(userId, tenant);
  const now = new Date();
  const awaiting = contracts.filter((k) => k.status === "sent" && !k.clientSigned);
  const rest = contracts.filter((k) => !(k.status === "sent" && !k.clientSigned));

  return (
    <>
      <PortalPageHead
        eyebrow="Your account"
        title="Agreements"
        lead="What we've agreed, for how much, and until when."
        actions={<PortalLive topics={["contracts"]} />}
      />

      {contracts.length === 0 ? (
        <EmptyNote>No agreements yet.</EmptyNote>
      ) : (
        <div className="cp-stack">
          {awaiting.length > 0 && (
            <>
              <h2 style={{ margin: 0, font: "600 15px/1.3 var(--font-body)", color: "var(--ink-strong)" }}>
                Waiting for your signature
              </h2>
              {awaiting.map((k) => <ContractCard key={k.id} k={k} now={now} actionable />)}
            </>
          )}
          {rest.length > 0 && (
            <>
              {awaiting.length > 0 && (
                <h2 style={{ margin: "10px 0 0", font: "600 15px/1.3 var(--font-body)", color: "var(--ink-muted)" }}>
                  Everything else
                </h2>
              )}
              {rest.map((k) => <ContractCard key={k.id} k={k} now={now} />)}
            </>
          )}
        </div>
      )}
    </>
  );
}

function ContractCard({ k, now, actionable }: {
  k: Awaited<ReturnType<typeof listPortalContracts>>[number];
  now: Date;
  actionable?: boolean;
}) {
  const ending = k.status === "signed" && k.endsOn && !k.termEnded;
  return (
    <Card
      title={k.title}
      headerRight={
        // `termEnded` is derived on read, not written back by a nightly job — so a live agreement can
        // never show as expired because a cron missed a night, and vice versa.
        <PortalStatus status={k.termEnded && k.status === "signed" ? "expired" : k.status} />
      }
    >
      <PortalFacts
        rows={[
          ...(k.reference ? [{ k: "Reference", v: `${k.reference}${k.version > 1 ? ` · v${k.version}` : ""}` }] : []),
          ...(k.projectName ? [{ k: "Covers", v: k.projectName }] : [{ k: "Covers", v: "Your whole account" }]),
          ...(k.value !== null ? [{ k: "Value", v: money(k.value, k.currency), strong: true }] : []),
          ...(k.startsOn || k.endsOn
            ? [{
                k: "Term",
                v: `${k.startsOn ? portalDate(k.startsOn) : "—"} → ${k.endsOn ? portalDate(k.endsOn) : "open-ended"}`,
              }]
            : []),
          {
            k: "Signatures",
            // Both sides, always. A client seeing only their own signature would believe an agreement was
            // in force when it is still waiting on us.
            v: `${k.clientSigned ? "You ✓" : "You — not yet"} · ${k.providerSigned ? "Us ✓" : "Us — not yet"}`,
          },
        ]}
      />
      {ending && (
        <p style={{ margin: "12px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          Runs out {portalDate(k.endsOn)} ({relativeDays(k.endsOn, now)}).
        </p>
      )}
      <div style={{ marginTop: 16 }}>
        <Link
          href={`/portal/contracts/${k.id}`}
          className={actionable ? "btn btn-primary" : "btn"}
          style={{ fontSize: 13, textDecoration: "none" }}
        >
          {actionable ? "Read & sign" : "Read agreement"}
        </Link>
      </div>
    </Card>
  );
}
