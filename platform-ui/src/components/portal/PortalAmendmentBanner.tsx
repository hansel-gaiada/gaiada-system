import Link from "next/link";
import type { PortalContract } from "@/lib/portal";

// PV4-08 — the banner on an amendment's page: which agreement it amends, and the request it came from.
//
// An amendment changes the terms of an EARLIER signed contract and never voids or replaces it (§16b), so this says
// so in words. `amendsReference` and `changeRequestId` come already scoped by the server: a contact who cannot see
// the amended contract (or the request) reads `null`, so nothing here ever names something out of reach. With no
// reference the banner still says "an earlier agreement", never an empty "Amendment to".
// The portal has no page for a single request, so "From your request" links to the Requests list.
export function PortalAmendmentBanner({ contract }: {
  contract: Pick<PortalContract, "kind" | "amendsId" | "amendsReference" | "changeRequestId">;
}) {
  if (contract.kind !== "amendment") return null;
  const ref = contract.amendsReference;
  return (
    <div className="cp-callout cp-callout--calm" role="note" aria-label="This is an amendment">
      <div style={{ font: "600 14px/1.4 var(--font-body)", color: "var(--ink-strong)" }}>
        {ref ? (
          <>
            Amendment to{" "}
            {contract.amendsId
              ? <Link href={`/portal/contracts/${contract.amendsId}`} style={{ color: "var(--ink-strong)", textDecoration: "underline" }}>{ref}</Link>
              : ref}
          </>
        ) : (
          "Amendment to an earlier agreement"
        )}
      </div>
      <p style={{ margin: "4px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
        It changes the terms of that agreement and does not replace it.
      </p>
      {contract.changeRequestId && (
        <p style={{ margin: "6px 0 0", font: "500 13px/1.5 var(--font-body)" }}>
          <Link href="/portal/requests" style={{ color: "var(--ink-strong)", textDecoration: "underline" }}>From your request</Link>
        </p>
      )}
    </div>
  );
}
