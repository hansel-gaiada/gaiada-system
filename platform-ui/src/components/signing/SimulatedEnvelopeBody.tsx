import { Card } from "@/components/ui";
import { CopyHash } from "@/components/billing/CopyHash";
import { formatDate } from "@/lib/format";
import { portalDate } from "@/lib/portal";
import { signerStateText, type SimulatedEnvelopeView } from "@/lib/simulatedPsre";
import { SimulatedBanner } from "./SimulatedBanner";
import "./simulatedPsre.css";

// PV5-11 — what a simulated PSrE signing page shows, portal and staff alike: the banner, the document the signer is
// signing, its SHA-256, who has signed. The form (when the backend says `canSign`) or the reason it is not offered goes in
// `children`, BELOW the document: a signature block above the terms would let someone sign what they have not been shown.
//
// Every field is the backend's. `canSign`, `reason` and `yourRole` are never derived from a role in the browser.
export function SimulatedEnvelopeBody({ view, variant, children }: {
  view: SimulatedEnvelopeView;
  variant: "portal" | "staff";
  children?: React.ReactNode;
}) {
  const date = variant === "portal" ? portalDate : formatDate;
  return (
    <div className="sp-stack">
      <SimulatedBanner label={view.label} notice={view.notice} />

      <Card title="The document">
        <div className="sp-stack">
          <p className="sp-meta">{view.title}{view.documentFilename ? ` · ${view.documentFilename}` : ""}</p>
          {view.documentText ? (
            <pre className="sp-doc" role="region" aria-label="Text of the document" tabIndex={0}>{view.documentText}</pre>
          ) : null}
          <a className="sp-link" href={view.documentPath}>
            {view.documentText ? "Download the simulator's copy" : `Download ${view.documentFilename ?? "the document"}`}
          </a>
          {view.documentSha256 ? <CopyHash hash={view.documentSha256} label="SHA-256 of the document" /> : null}
        </div>
      </Card>

      <Card title="Signers">
        <ul className="sp-signers" aria-label="Signers">
          {view.signers.map((s) => (
            <li key={s.role}>
              <span className="sp-signers__who">{s.displayName}</span>
              <span>{signerStateText(s, date)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {children}
    </div>
  );
}
