import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ContractDocument } from "./ContractDocument";
import type { ContractPrintPayload } from "@/lib/documents-print-data";

// DW-10f-2a/2b (BFF §61.9) - the sealed copy's evidence page prints the payment schedule FIXED AT SEND, with its own hash. The payload carries
// it only for a schedule fixed at send (never one added after signing: nobody signed that one), and an older payload omits it.

const base: ContractPrintPayload = {
  kind: "contract", renderNonce: "render-xyz", includeBody: true,
  contract: {
    id: "k1", title: "Website retainer", reference: "REF-1", version: 1, kind: "agreement", value: "120000000", currency: "IDR",
    startsOn: "2026-10-01", endsOn: "2027-09-30", sentAt: "2026-10-01T02:00:00.000Z", signedAt: "2026-10-03T03:04:05.000Z",
    contentSha256: "a".repeat(64), contentFixedAt: "2026-10-01T02:00:00.000Z", signatureTier: "attested", bodyMd: "## Scope\nThe words.",
  },
  parties: { issuerLegalName: "Example Issuer Legal Name", clientName: "Example Client" },
  document: { source: "body", filename: null, sha256: "a".repeat(64) },
  signatures: [
    { party: "client", signerName: "Sam Signer", signerTitle: null, signedAt: "2026-10-02T01:00:00.000Z", ipHash: "b".repeat(64), userAgent: "UA", contentSha256: "a".repeat(64) },
  ],
  seal: { legalName: "Example Issuer Legal Name", certificateSerial: "4a1b", certificateFingerprint: "d".repeat(64), certificateValidTo: "2031-10-13T00:00:00.000Z", sealedAt: "2026-10-03T03:05:00.000Z" },
};
const withSchedule: ContractPrintPayload = {
  ...base,
  schedule: {
    currency: "IDR", total: "120000000", sha256: "e".repeat(64),
    instalments: [
      { position: 1, label: "Deposit (50%)", amount: "60000000", due: "on_signing" },
      { position: 2, label: "Balance (50%)", amount: "60000000", due: "2027-03-31" },
    ],
  },
};
const evidence = () => screen.getByRole("region", { name: "Signature evidence" });

describe("sealed copy: the payment schedule", () => {
  it("prints the instalments, the total and the schedule's own hash on the evidence page", () => {
    render(<ContractDocument payload={withSchedule} />);
    expect(within(evidence()).getByRole("heading", { name: "Payment schedule" })).toBeInTheDocument();
    const table = within(evidence()).getByRole("table", { name: "Payment schedule" });
    expect(within(table).getByText("Deposit (50%)")).toBeInTheDocument();
    expect(within(table).getByText("On signing")).toBeInTheDocument();
    expect(within(table).getByText("2027-03-31")).toBeInTheDocument();
    expect(within(table).getAllByText("60,000,000")).toHaveLength(2);
    expect(within(table).getByText("120,000,000")).toBeInTheDocument();
    expect(evidence().textContent).toContain("e".repeat(64));
    expect(evidence().textContent).toMatch(/fixed when the agreement was sent/);
  });

  it("the schedule's hash is its own, not the content hash", () => {
    render(<ContractDocument payload={withSchedule} />);
    expect(evidence().textContent).toContain("SHA-256 of the schedule");
    expect(evidence().textContent).toContain("a".repeat(64));
    expect(evidence().textContent).toContain("e".repeat(64));
  });

  it("amounts are formatted from the decimal strings, exactly (past 2^53), to the currency's own decimals", () => {
    render(<ContractDocument payload={{ ...withSchedule, schedule: { currency: "USD", total: "90071992547409931.50", sha256: "e".repeat(64), instalments: [{ position: 1, label: "All", amount: "90071992547409931.50", due: "on_signing" }] } }} />);
    expect(within(evidence()).getAllByText("90,071,992,547,409,931.50")).toHaveLength(2);
  });

  it("prints nothing for a contract with no schedule: null, empty and an older payload without the field", () => {
    for (const schedule of [null, undefined, { ...withSchedule.schedule!, instalments: [] }]) {
      const { unmount } = render(<ContractDocument payload={{ ...base, schedule }} />);
      expect(screen.queryByRole("heading", { name: "Payment schedule" })).toBeNull();
      expect(evidence().textContent).not.toMatch(/SHA-256 of the schedule/);
      unmount();
    }
  });

  it("an attached agreement's evidence page carries the schedule too", () => {
    render(<ContractDocument payload={{ ...withSchedule, includeBody: false, document: { source: "attached_pdf", filename: "terms.pdf", sha256: "a".repeat(64) } }} />);
    expect(within(evidence()).getByRole("table", { name: "Payment schedule" })).toBeInTheDocument();
  });
});
