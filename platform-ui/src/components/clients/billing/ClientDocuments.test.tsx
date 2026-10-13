import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ClientDocuments } from "./ClientDocuments";
import type { StaffDocumentItem } from "@/lib/documents";

// PV5-08 — the hub's Documents section. The "Client sees this" marker comes from the backend's `clientVisible` only:
// true says it, false says Internal, and a payload without the field says nothing (never a guess). Downloads use the
// staff file route.

const ITEMS: StaffDocumentItem[] = [
  { id: "k1", kind: "signed_contract", title: "Master agreement", date: "2026-10-05T08:00:00Z", fileId: "f-sealed", ready: true, clientVisible: true },
  { id: "k2", kind: "signed_contract", title: "Campaign SOW", date: "2026-10-04T08:00:00Z", fileId: "f-orig", ready: false, clientVisible: true },
  { id: "p1", kind: "receipt", title: "Payment proof", date: "2026-10-02", fileId: "f-proof", ready: true, clientVisible: false },
  { id: "i1", kind: "invoice", title: "INV/2026/0007", date: "2026-10-01T08:00:00Z", fileId: null, ready: false },
];

describe("ClientDocuments", () => {
  it("shows each row's marker from the backend flag only, and nothing when the flag is absent", () => {
    render(<ClientDocuments items={ITEMS} />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("Client sees this")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Internal")).toBeInTheDocument();
    expect(within(rows[3]).queryByText("Internal")).toBeNull();
    expect(within(rows[3]).queryByText("Client sees this")).toBeNull();
  });

  it("links through the staff file route, labels an unsealed original, and says when a document is being prepared", () => {
    render(<ClientDocuments items={ITEMS} />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/api/files/f-sealed", "/api/files/f-orig", "/api/files/f-proof"]);
    expect(screen.getByRole("link", { name: /Download the original of Campaign SOW \(not yet sealed\)/ })).toBeInTheDocument();
    expect(screen.getByText(/The invoice PDF is being prepared/)).toBeInTheDocument();
  });

  it("an empty list is stated, not blank", () => {
    render(<ClientDocuments items={[]} />);
    expect(screen.getByText(/No signed agreement, issued invoice or payment receipt/)).toBeInTheDocument();
  });
});
