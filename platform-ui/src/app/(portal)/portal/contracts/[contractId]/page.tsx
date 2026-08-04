import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalContract } from "@/lib/portal-data";
import { clientStatus, money, portalDate } from "@/lib/portal";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalSignForm } from "@/components/portal/PortalSignForm";
import { PortalFacts, PortalLink, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";
import "@/components/pipeline/pipeline.css";

// CP-14 — one agreement: the terms, the signatures, and the sign form when it is the client's turn.
//
// ── THE TERMS COME FIRST, ABOVE THE FORM ──────────────────────────────────────────────────────────
// Layout order is a correctness property here, not taste. A signature block above the terms lets someone
// sign a document they have not been shown, which is exactly what an e-signature has to be able to
// refute. Terms → signature state → sign form, in that order, always.
//
// ── `canSign` IS THE SERVER'S ANSWER, NOT THIS PAGE'S GUESS ───────────────────────────────────────
// The BFF computes it as `scope.canSign && status === 'sent' && no client signature yet` — the exact
// conjunction `POST /sign` enforces. Recomputing it here from the parts would be a second implementation
// free to disagree, and the way it would disagree is by offering a button that 403s. So the page reads
// the flag and, when it is false, says WHICH reason applies (view-only, already signed, term ended).
export default async function PortalContractPage({ params }: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const k = await getPortalContract(userId, tenant, contractId);
  if (!k) notFound();

  const clientSig = k.signatures.find((s) => s.party === "client");
  const providerSig = k.signatures.find((s) => s.party === "provider");

  return (
    <>
      <PortalPageHead
        eyebrow={k.reference ? `${k.reference}${k.version > 1 ? ` · version ${k.version}` : ""}` : "Agreement"}
        title={k.title}
        actions={<PortalLive topics={["contracts"]} />}
      />

      <div className="cp-stack">
        <Card title="Terms at a glance" headerRight={<PortalStatus status={k.termEnded && k.status === "signed" ? "expired" : k.status} />}>
          <PortalFacts
            rows={[
              ...(k.value !== null ? [{ k: "Value", v: money(k.value, k.currency), strong: true }] : []),
              {
                k: "Term",
                v: `${k.startsOn ? portalDate(k.startsOn) : "—"} → ${k.endsOn ? portalDate(k.endsOn) : "open-ended"}`,
              },
              ...(k.sentAt ? [{ k: "Sent to you", v: portalDate(k.sentAt) }] : []),
              ...(k.signedAt ? [{ k: "Fully signed", v: portalDate(k.signedAt) }] : []),
              ...(k.declineReason ? [{ k: "Declined because", v: k.declineReason }] : []),
            ]}
          />
        </Card>

        {/* The document itself — the attached PDF, the in-app terms, or an honest statement that neither
            is present. A sign form with no readable terms above it must never render. */}
        <Card title="The agreement">
          {k.document ? (
            <div style={{ display: "grid", gap: 10 }}>
              <a
                href={k.document.url ?? `/api/${tenant}/portal/files/${k.document.id}`}
                {...(k.document.url ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="btn"
                style={{ fontSize: 13, textDecoration: "none", justifySelf: "start" }}
              >
                Download {k.document.filename}
              </a>
              {k.bodyMd && (
                <div style={{ padding: "10px 12px", background: "var(--wash)", borderRadius: 8 }}>
                  <ArtifactMarkdown text={k.bodyMd} />
                </div>
              )}
            </div>
          ) : k.bodyMd ? (
            <div style={{ padding: "12px 14px", background: "var(--wash)", borderRadius: 8 }}>
              <ArtifactMarkdown text={k.bodyMd} />
            </div>
          ) : (
            <EmptyNote>
              The document for this agreement hasn&apos;t been attached yet. Please ask your account
              manager to send it before signing.
            </EmptyNote>
          )}
        </Card>

        <Card title="Signatures">
          <div style={{ display: "grid", gap: 12 }}>
            <SignatureRow who="Your organisation" sig={clientSig} />
            <SignatureRow who="Gaia Digital Agency" sig={providerSig} />
          </div>
          {!providerSig && clientSig && (
            <p style={{ margin: "12px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
              You&apos;ve signed. This agreement takes effect once we countersign — we&apos;ll let you know.
            </p>
          )}
        </Card>

        {/* Sign, or say precisely why not. Only rendered when the DOCUMENT exists: offering a signature on
            terms the client cannot read is the one state this page must refuse to produce. */}
        {k.canSign && (k.document || k.bodyMd) ? (
          <Card title="Sign this agreement">
            <PortalSignForm contractId={k.id} title={k.title} />
          </Card>
        ) : (
          <Card title="Signing">
            <EmptyNote>
              {k.viewOnly
                ? "Your access to this portal is view-only, so a colleague with signing rights needs to sign this. You can read everything here and forward it to them."
                : clientSig
                  ? "You've already signed this agreement."
                  : k.termEnded
                    ? "This agreement's term has ended. Ask your account manager to re-issue it."
                    : k.status !== "sent"
                      ? `This agreement is ${clientStatus(k.status).toLowerCase()} and can't be signed here.`
                      : "The document needs to be attached before this can be signed."}
            </EmptyNote>
          </Card>
        )}

        <PortalLink href="/portal/contracts">All agreements</PortalLink>
      </div>
    </>
  );
}

function SignatureRow({ who, sig }: {
  who: string;
  sig?: { signerName: string | null; signerTitle: string | null; signedAt: string };
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
      <Eyebrow style={{ minWidth: 150, opacity: 0.6 }}>{who}</Eyebrow>
      {sig ? (
        <span style={{ font: "400 14px/1.4 var(--font-body)", color: "var(--ink-body)" }}>
          <span style={{ fontWeight: 500, color: "var(--ink-strong)" }}>{sig.signerName ?? "Signed"}</span>
          {sig.signerTitle && <span style={{ color: "var(--ink-muted)" }}> · {sig.signerTitle}</span>}
          <span style={{ color: "var(--ink-subtle)" }}> · {portalDate(sig.signedAt)}</span>
        </span>
      ) : (
        <span style={{ font: "400 14px var(--font-body)", color: "var(--ink-subtle)" }}>Not signed yet</span>
      )}
    </div>
  );
}
