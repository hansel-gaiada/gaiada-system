import type { ContractPrintPayload, ContractPrintSignature } from "@/lib/documents-print-data";
import { formatAmount, formatDecimal, formatUtc } from "@/lib/documents-format";
import { minorUnitOf } from "@/lib/contracts";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";

// PV5-07 (ruling PV-D25, plan decision 21) — the pages platform-nest renders for a signed contract's sealed copy:
// the agreement itself when its terms were written in the ERP (`includeBody`), then ALWAYS the evidence page. When the
// agreement is an attached file, its own pages (or the file itself, embedded) come first and are joined by
// platform-nest; this page renders only the evidence.
//
// The evidence page says, in plain words, what the company seal proves and what it does not. That wording is the
// ruling's, not decoration: the seal shows the PDF is unchanged since it was sealed; it does not certify anyone's
// identity, and the signatures stay uncertified electronic signatures. Do not soften or drop it.
//
// The body goes through ArtifactMarkdown, the house's no-HTML markdown renderer (no dangerouslySetInnerHTML), so stored
// terms cannot inject markup into a legal document.

const SOURCE_WORDS: Record<ContractPrintPayload["document"]["source"], string> = {
  body: "the terms written in the agreement above",
  attached_pdf: "the attached agreement document, whose pages precede this one",
  attached_file: "the attached agreement document, embedded in this PDF as a file attachment",
};

function partyLabel(s: ContractPrintSignature, p: ContractPrintPayload): string {
  return s.party === "client" ? `Client (${p.parties.clientName})` : `Provider (${p.parties.issuerLegalName})`;
}

function tierWords(tier: string): string {
  if (tier === "attested") {
    return "Attested: each party typed their name and confirmed that they agree; our system recorded the time, a salted hash of their IP address and their browser's user agent.";
  }
  return `${tier}`;
}

/** "45000000" -> "45,000,000" and "60.5" in USD -> "60.50": the currency's own decimals, or more if the stored amount has more, from the string. */
function scheduleAmount(a: string, currency: string): string {
  return formatAmount(a, Math.max(minorUnitOf(currency), (formatDecimal(a).split(".")[1] ?? "").length));
}

/** DW-10f-2a (BFF §61.9): the payment schedule that was fixed when the agreement was sent, and its own hash. Nothing renders for a contract
 *  with no schedule, and the payload never carries one that was added after signing. */
export function PrintedSchedule({ payload }: { payload: ContractPrintPayload }) {
  const sch = payload.schedule;
  if (!sch || sch.instalments.length === 0) return null;
  return (
    <>
      <h2 className="doc-print__h2">Payment schedule</h2>
      <table className="doc-print__table" aria-label="Payment schedule">
        <thead>
          <tr>
            <th scope="col">No.</th>
            <th scope="col">Instalment</th>
            <th scope="col">Due</th>
            <th scope="col">Amount ({sch.currency})</th>
          </tr>
        </thead>
        <tbody>
          {sch.instalments.map((i) => (
            <tr key={i.position}>
              <td>{i.position}</td>
              <td>{i.label}</td>
              <td>{i.due === "on_signing" ? "On signing" : i.due}</td>
              <td>{scheduleAmount(i.amount, sch.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>Total</th>
            <td>{scheduleAmount(sch.total, sch.currency)}</td>
          </tr>
        </tfoot>
      </table>
      <dl className="doc-print__facts">
        <dt>SHA-256 of the schedule</dt>
        <dd className="doc-print__hash">{sch.sha256}</dd>
      </dl>
      <p>The payment schedule was fixed when the agreement was sent, together with its content. It could not change after that.</p>
    </>
  );
}

export function ContractEvidence({ payload }: { payload: ContractPrintPayload }) {
  const { contract: k, parties, document: doc, signatures, seal } = payload;
  const allMatch = signatures.length > 0 && signatures.every((s) => !s.contentSha256 || s.contentSha256 === k.contentSha256);
  return (
    <section className="doc-print__evidence" aria-label="Signature evidence">
      <h1 className="doc-print__title">Signature evidence</h1>
      <dl className="doc-print__facts">
        <dt>Agreement</dt>
        <dd>
          {k.title}
          {k.reference ? ` (${k.reference})` : ""}, version {k.version}
        </dd>
        <dt>Between</dt>
        <dd>
          {parties.issuerLegalName} and {parties.clientName}
        </dd>
        <dt>Content signed</dt>
        <dd>
          {SOURCE_WORDS[doc.source]}
          {doc.filename && doc.source !== "body" ? `: ${doc.filename}` : ""}
        </dd>
        <dt>SHA-256 of the content</dt>
        <dd className="doc-print__hash">{k.contentSha256}</dd>
        <dt>Content fixed</dt>
        <dd>{formatUtc(k.contentFixedAt)} (when the agreement was sent; it could not change after that)</dd>
        <dt>Signature tier</dt>
        <dd>{tierWords(k.signatureTier)}</dd>
        {k.signedAt && (
          <>
            <dt>Fully signed</dt>
            <dd>{formatUtc(k.signedAt)}</dd>
          </>
        )}
      </dl>

      <h2 className="doc-print__h2">Signatures</h2>
      <table className="doc-print__table doc-print__table--evidence">
        <thead>
          <tr>
            <th scope="col">Party</th>
            <th scope="col">Signed by</th>
            <th scope="col">Signed at</th>
            <th scope="col">IP address (salted hash)</th>
            <th scope="col">Browser (user agent)</th>
          </tr>
        </thead>
        <tbody>
          {signatures.map((s) => (
            <tr key={s.party}>
              <td>{partyLabel(s, payload)}</td>
              <td>
                {s.signerName ?? ""}
                {s.signerTitle ? `, ${s.signerTitle}` : ""}
              </td>
              <td>{formatUtc(s.signedAt)}</td>
              <td className="doc-print__hash">{s.ipHash ?? "not recorded"}</td>
              <td className="doc-print__ua">{s.userAgent ?? "not recorded"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {allMatch
          ? "Each signature above was made over the content hash shown above."
          : "Not every signature records the content hash it was made over."}
      </p>

      <PrintedSchedule payload={payload} />

      <h2 className="doc-print__h2">The seal on this PDF</h2>
      <dl className="doc-print__facts">
        <dt>Sealed by</dt>
        <dd>{seal.legalName}</dd>
        <dt>Sealed at</dt>
        <dd>{formatUtc(seal.sealedAt)} (our server&rsquo;s clock)</dd>
        <dt>Certificate serial</dt>
        <dd className="doc-print__hash">{seal.certificateSerial}</dd>
        <dt>Certificate SHA-256</dt>
        <dd className="doc-print__hash">{seal.certificateFingerprint}</dd>
        <dt>Certificate valid until</dt>
        <dd>{formatUtc(seal.certificateValidTo)}</dd>
      </dl>
      <div className="doc-print__notice">
        <h3 className="doc-print__h3">What the seal proves</h3>
        <p>
          This PDF has not been changed since {seal.legalName} sealed it. Changing anything in it, even one character,
          breaks the seal, and a PDF reader that checks signatures will show it as invalid. You can check this yourself,
          without asking us and without our systems.
        </p>
        <h3 className="doc-print__h3">What it does not prove</h3>
        <p>
          The seal&rsquo;s certificate was issued by {seal.legalName} itself, not by a certification authority. A PDF reader
          will therefore say that the signer&rsquo;s identity could not be verified; that is expected. The seal does not make
          the signatures above certified electronic signatures: legally they remain uncertified electronic signatures, and
          this page is the record of how they were made. The time of the seal comes from our own server clock; no
          independent timestamp service was used.
        </p>
      </div>
    </section>
  );
}

export function ContractAgreement({ payload }: { payload: ContractPrintPayload }) {
  const { contract: k, parties } = payload;
  // As many decimals as the stored value has (no currency rule in a template): "150000000" -> "150,000,000".
  const value = k.value !== null ? `${k.currency} ${formatAmount(k.value, (formatDecimal(k.value).split(".")[1] ?? "").length)}` : null;
  return (
    <section className="doc-print__agreement" aria-label="Agreement">
      <h1 className="doc-print__title">{k.title}</h1>
      <dl className="doc-print__facts">
        {k.reference && (
          <>
            <dt>Reference</dt>
            <dd>
              {k.reference}, version {k.version}
            </dd>
          </>
        )}
        <dt>Between</dt>
        <dd>
          {parties.issuerLegalName} and {parties.clientName}
        </dd>
        {value && (
          <>
            <dt>Value</dt>
            <dd>{value}</dd>
          </>
        )}
        {(k.startsOn || k.endsOn) && (
          <>
            <dt>Term</dt>
            <dd>
              {k.startsOn ?? "on signature"} to {k.endsOn ?? "open-ended"}
            </dd>
          </>
        )}
      </dl>
      <div className="doc-print__body">{k.bodyMd ? <ArtifactMarkdown text={k.bodyMd} /> : null}</div>
    </section>
  );
}

export function ContractDocument({ payload }: { payload: ContractPrintPayload }) {
  return (
    <article className="doc-print doc-contract" aria-label={`Signed copy of ${payload.contract.title}`}>
      {payload.includeBody && (
        <>
          <ContractAgreement payload={payload} />
          <div className="doc-print__break" aria-hidden="true" />
        </>
      )}
      <ContractEvidence payload={payload} />
    </article>
  );
}
