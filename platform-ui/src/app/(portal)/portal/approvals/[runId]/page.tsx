import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalRun } from "@/lib/portal-data";
import { portalDate } from "@/lib/portal";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalGateActions } from "@/components/portal/PortalGateActions";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalLink, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";
import { MailThreadPanel } from "@/components/mail/MailThreadPanel";
import "@/components/pipeline/pipeline.css";

// CP-12 — one delivery, in full. MOVED from `/portal/[runId]` (see the approvals list for why).
//
// Ownership is not re-checked here: the BFF resolves the caller's own clients and answers 404 for a run
// outside them, deliberately the SAME response as a run that does not exist — a client must not be able
// to tell another client's run id from a nonexistent one. `notFound()` is therefore correct and complete.
//
// Dates use `portalDate` rather than `toLocaleDateString()`. The bare call reads the host's ICU data, so
// server render and client hydration can disagree and React logs a mismatch — the locale/timezone trap
// in platform-ui/CLAUDE.md. Fixed while moving the file rather than carried over.
export default async function PortalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const run = await getPortalRun(userId, tenant, runId);
  if (!run) notFound();

  const signed = run.scopeSignoffs ?? [];
  const decided = run.gates.filter((g) => g.status !== "pending");
  const artifacts = run.stages.filter((s) => s.artifact_ref);

  return (
    <>
      <PortalPageHead
        eyebrow="Your delivery"
        title={run.title ?? "Delivery"}
        actions={<PortalLive topics={["approvals", "projects"]} />}
      />

      <div className="cp-stack">
        <Card title="Where things stand" headerRight={<PortalStatus status={run.status} />}>
          <div className={run.gates.some((g) => g.status === "pending") ? "cp-callout" : "cp-callout cp-callout--calm"}>
            {run.currentBlockage}
          </div>
          <PortalGateActions runId={run.id} gates={run.gates} stages={run.stages} />
        </Card>

        <Card title="Progress">
          {run.stages.length === 0 ? (
            <EmptyNote>Nothing has started yet.</EmptyNote>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {run.stages.map((s, i) => (
                <span
                  key={i}
                  style={{
                    font: "500 12px/1 var(--font-body)", padding: "6px 10px", borderRadius: 999,
                    background: s.status === "done"
                      ? "color-mix(in srgb, var(--status-ok) 12%, transparent)"
                      : "var(--wash)",
                  }}
                >
                  {s.name.replace(/_/g, " ")} · {s.status}
                </span>
              ))}
            </div>
          )}
        </Card>

        {/* The documents, readable OUTSIDE a signature prompt. Without this a client could only ever see
            an artifact while being asked to sign it, and never re-read what they already agreed to. */}
        <Card title="Documents">
          {artifacts.length === 0 ? (
            <EmptyNote>No documents yet.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {artifacts.map((s, i) => (
                <div key={i}>
                  <Eyebrow style={{ display: "block", marginBottom: 6 }}>{s.name.replace(/_/g, " ")}</Eyebrow>
                  <div style={{ padding: "10px 12px", background: "var(--wash)", borderRadius: 8 }}>
                    <ArtifactMarkdown text={s.artifact_ref!} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {(decided.length > 0 || signed.length > 0) && (
          <Card title="Your decisions">
            <div style={{ display: "grid", gap: 8 }}>
              {decided.map((g) => (
                <div key={g.id} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", font: "400 13px var(--font-body)" }}>
                  <span style={{ fontWeight: 500 }}>{g.kind.replace(/_/g, " ")}</span>
                  <span style={{ color: "var(--ink-muted)" }}>{g.decision ?? "decided"}</span>
                  <span style={{ color: "var(--ink-subtle)" }}>{portalDate(g.created_at)}</span>
                </div>
              ))}
              {signed.map((s, i) => (
                <div key={`s${i}`} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", font: "400 13px var(--font-body)" }}>
                  {/* Both parties are shown, not just the client's own signature: a scope agreement is
                      only in force once BOTH have signed, so hiding the provider side would let a client
                      believe an agreement was settled when it is still waiting on us. */}
                  <span style={{ fontWeight: 500 }}>Scope signed — {s.party === "client" ? "you" : "our team"}</span>
                  <span style={{ color: "var(--ink-muted)" }}>{s.signer_name ?? ""}</span>
                  <span style={{ color: "var(--ink-subtle)" }}>{portalDate(s.signed_at)}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* MAIL-15 — portal variant of the thread panel (design §8A/§6.1: "the portal reuses the same
            rule through the portal BFF" — a client principal is never treated as elevated). */}
        <MailThreadPanel userId={userId} tenantId={tenant} entityType="pipeline_run" entityId={run.id} portal title="Replies" />

        <PortalLink href="/portal/approvals">All approvals</PortalLink>
      </div>
    </>
  );
}
