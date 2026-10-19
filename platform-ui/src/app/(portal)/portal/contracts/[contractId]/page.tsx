import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalContract } from "@/lib/portal-data";
import { certifiedCopyLabel, contractSigningState, money, portalDate, signatureViaText, SIMULATED_SIGNATURE_NOTE } from "@/lib/portal";
import { contractDocumentState } from "@/lib/billingView";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalAmendmentBanner } from "@/components/portal/PortalAmendmentBanner";
import { PortalSignForm } from "@/components/portal/PortalSignForm";
import { PortalCertifiedSign } from "@/components/portal/PortalCertifiedSign";
import { PortalSignedNote } from "@/components/portal/PortalSignedNote";
import { PortalSchedule } from "@/components/portal/PortalSchedule";
import { PortalFacts, PortalLink, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";
import "@/components/pipeline/pipeline.css";
import "@/components/signing/simulatedPsre.css";

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
//
// ── "SIGNED — THANK YOU" IS RENDERED HERE, FROM THE RECORDED SIGNATURE ────────────────────────────
// Not only from the sign form's local action state: the sign action revalidates this page, and the
// refreshed read (canSign false) unmounts the form together with that state — which is exactly what
// Next 16.3 started doing correctly. `contractSigningState` (lib/portal.ts) has the full reasoning.
//
// ── THE SIGNED COPY (PV5-09) ──────────────────────────────────────────────────────────────────────
// Once BOTH parties have signed, the client's copy is one sealed PDF: the contract, its evidence page and the company
// seal (PV-D25). It is rendered after the commit (PV5-07), so for a while a signed contract has no file: the page says
// "being prepared" then, never a dead link. An older server omits `signedCopyFileId`, which reads the same. A contract that
// is not signed shows nothing here, because there is no copy to promise yet.
//
// ── CERTIFIED SIGNING (PV5-11) ────────────────────────────────────────────────────────────────────
// A certified contract is never signed by typed name. When the backend says `certifiedSigning.canStart`, the card is
// "Sign with <label>" (PortalCertifiedSign), which creates the envelope and sends the client to the signing page. While the
// provider is the SIMULATED PSrE (review stage) the card, the signature rows and the signed copy all say so in words.
// Every flag is the backend's; nothing is derived from a role in the browser.
export default async function PortalContractPage({ params }: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const company = await getActivePortalCompany(me);
  const tenant = company?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const k = await getPortalContract(userId, tenant, contractId);
  if (!k) notFound();

  const clientSig = k.signatures.find((s) => s.party === "client");
  const providerSig = k.signatures.find((s) => s.party === "provider");
  const signing = contractSigningState(k);
  const signedCopy = contractDocumentState(k);
  // PV5-11: a certified contract's final copy is the one signed through the provider; `simulated` is the backend's flag.
  const certified = k.certifiedSigning ?? null;
  const certifiedLabel = certifiedCopyLabel(certified);

  return (
    <>
      <PortalPageHead
        eyebrow={k.reference ? `${k.reference}${k.version > 1 ? ` · version ${k.version}` : ""}` : "Contract"}
        title={k.title}
        actions={<PortalLive topics={["contracts"]} />}
      />

      <div className="cp-stack">
        {/* PV4-08: an amendment says which agreement it amends and the request it came from (renders nothing otherwise). */}
        <PortalAmendmentBanner contract={k} />
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

        {/* DW-10f-2b (BFF §61.6): how the price is invoiced, with the terms and above the signature, so what is signed is all in view.
            Nothing renders for an agreement with no schedule. */}
        <PortalSchedule schedule={k.schedule} company={company?.name} />

        {k.status === "signed" && (
          <Card
            title="Your signed copy"
            hint={certified
              ? "One PDF: the agreement as signed through the certified provider, with the provider's record of who signed it and when."
              : "One PDF: the agreement, the record of who signed it and when, and our company seal."}
            headerRight={certifiedLabel ? <span className="sp-cert-badge">{certifiedLabel}</span> : undefined}
          >
            {signedCopy.kind === "link" ? (
              <a
                href={`/api/${tenant}/portal/files/${signedCopy.fileId}`}
                className="btn"
                style={{ fontSize: 13, textDecoration: "none", justifySelf: "start" }}
              >
                {certified ? "Download the copy signed through the provider (PDF)" : "Download your signed copy (PDF)"}
              </a>
            ) : (
              <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
                Your signed copy is being prepared. It will appear here shortly.
              </p>
            )}
          </Card>
        )}

        <Card title="Signatures">
          <div style={{ display: "grid", gap: 12 }}>
            <SignatureRow who="Your organisation" sig={clientSig} via={signatureViaText(clientSig?.provider, certified)} />
            <SignatureRow who="Our company" sig={providerSig} via={signatureViaText(providerSig?.provider, certified)} />
          </div>
          {!providerSig && clientSig && (
            <p style={{ margin: "12px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
              You&apos;ve signed. This agreement takes effect once we countersign — we&apos;ll let you know.
            </p>
          )}
        </Card>

        {/* Signed, sign, or say precisely why not. The form is only offered when the DOCUMENT exists:
            offering a signature on terms the client cannot read is the one state this page must refuse to
            produce (`contractSigningState` enforces it). */}
        {signing.kind === "signed" ? (
          <Card title="Signed">
            <PortalSignedNote title={k.title} signerName={signing.signerName}
                              signerTitle={signing.signerTitle} signedAt={signing.signedAt} />
          </Card>
        ) : signing.kind === "certified" ? (
          <Card title="Sign this agreement">
            <PortalCertifiedSign contractId={k.id} contentSha256={k.contentSha256} label={signing.label} simulated={signing.simulated} />
          </Card>
        ) : signing.kind === "sign" ? (
          <Card title="Sign this agreement">
            <PortalSignForm contractId={k.id} title={k.title} contentSha256={k.contentSha256} />
          </Card>
        ) : (
          <Card title="Signing">
            <EmptyNote>{signing.reason}</EmptyNote>
            {certified?.simulated && <p className="sp-note" style={{ marginTop: 10 }}>{SIMULATED_SIGNATURE_NOTE}</p>}
          </Card>
        )}

        <PortalLink href="/portal/contracts">All contracts</PortalLink>
      </div>
    </>
  );
}

function SignatureRow({ who, sig, via }: {
  who: string;
  sig?: { signerName: string | null; signerTitle: string | null; signedAt: string };
  /** PV5-11: "through <provider> (simulated)" for a certified signature; empty for a typed name. */
  via?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
      <Eyebrow style={{ minWidth: 150, color: "var(--ink-subtle)" }}>{who}</Eyebrow>
      {sig ? (
        <span style={{ font: "400 14px/1.4 var(--font-body)", color: "var(--ink-body)" }}>
          <span style={{ fontWeight: 500, color: "var(--ink-strong)" }}>{sig.signerName ?? "Signed"}</span>
          {sig.signerTitle && <span style={{ color: "var(--ink-muted)" }}> · {sig.signerTitle}</span>}
          <span style={{ color: "var(--ink-subtle)" }}> · {portalDate(sig.signedAt)}</span>
          {via && <span style={{ color: "var(--ink-muted)" }}> · {via}</span>}
        </span>
      ) : (
        <span style={{ font: "400 14px var(--font-body)", color: "var(--ink-subtle)" }}>Not signed yet</span>
      )}
    </div>
  );
}
