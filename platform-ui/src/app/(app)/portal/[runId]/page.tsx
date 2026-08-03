import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalRun } from "@/lib/portal";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PortalGateActions } from "@/components/portal/PortalGateActions";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import "@/components/pipeline/pipeline.css";

// C5 — one client project, in full.
//
// `getPortalRun` and `PortalRunDetail` already existed and NOTHING rendered them: the list page fetched
// every run's detail and inlined it, so there was no way to open a single project and the reader was
// dead code. That also made the list 1+N HTTP calls (four queries each). The list is now a summary fed
// by the batched `/portal/runs`, and this is where a client reads the documents and signs.
//
// Ownership is not re-checked here: the BFF resolves the caller's own clients and answers 404 for a run
// outside them, which is deliberately the SAME response as a run that does not exist — a client must
// not be able to tell another client's run id from a nonexistent one. So `notFound()` is the correct
// and complete handling.
export default async function PortalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <Card><EmptyNote>No workspace selected.</EmptyNote></Card>;

  const run = await getPortalRun(userId, tenant, runId);
  if (!run) notFound();

  const signed = run.scopeSignoffs ?? [];
  const decided = run.gates.filter((g) => g.status !== "pending");

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Project Portal", href: "/portal" }, { label: run.title ?? "Project" }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Your project</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 32, lineHeight: 1.15 }}>
          {run.title ?? "Project"}
        </h1>
      </div>

      <div style={{ display: "grid", gap: 20 }}>
        <Card headerRight={<StatusBadge label={run.status.replace(/_/g, " ")} />} title="Where things stand">
          <div style={{ padding: "12px 14px", borderRadius: 12, background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-warning) 30%, transparent)", font: "500 14px/1.45 var(--font-body)" }}>
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
                    background: s.status === "done" ? "color-mix(in srgb, var(--status-ok) 12%, transparent)" : "var(--wash)",
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
          {run.stages.filter((s) => s.artifact_ref).length === 0 ? (
            <EmptyNote>No documents yet.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {run.stages.filter((s) => s.artifact_ref).map((s, i) => (
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
                  <span style={{ color: "var(--ink-subtle)" }}>{new Date(g.created_at).toLocaleDateString()}</span>
                </div>
              ))}
              {signed.map((s, i) => (
                <div key={`s${i}`} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", font: "400 13px var(--font-body)" }}>
                  {/* Both parties are shown, not just the client's own signature: a scope agreement is
                      only in force once BOTH have signed, so hiding the provider side would let a client
                      believe an agreement was settled when it is still waiting on us. */}
                  <span style={{ fontWeight: 500 }}>Scope signed — {s.party === "client" ? "you" : "our team"}</span>
                  <span style={{ color: "var(--ink-muted)" }}>{s.signer_name ?? ""}</span>
                  <span style={{ color: "var(--ink-subtle)" }}>{new Date(s.signed_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Link href="/portal" style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
          ← All your projects
        </Link>
      </div>
    </>
  );
}
