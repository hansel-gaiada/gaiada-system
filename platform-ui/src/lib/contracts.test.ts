import { describe, expect, it } from "vitest";
import {
  SEND_BLOCKED_REASON, awaitingText, billingBadgeCount, contractActions, countersignErrorText, decideErrorText,
  groupContracts, hasDocument, paymentDecisionState, signatureLine, validateContractForm, type Contract,
} from "./contracts";

// PV3-08 — the state-to-button rules behind /clients/[id]/billing. Pure, so every rule is pinned without
// rendering. The components render FROM these (`contractActions`, `paymentDecisionState`), and
// `components/clients/billing/billing.test.tsx` pins that they actually do.

const k = (over: Partial<Contract> = {}): Contract => ({
  id: "k1", clientId: "cl-1", clientName: "Northwind", projectId: null, projectName: null, title: "Agreement",
  reference: null, version: 1, supersedesId: null, status: "draft", fileId: null, bodyMd: null, value: null,
  currency: "USD", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdBy: null,
  createdAt: "2026-10-01T00:00:00Z", clientSigned: false, providerSigned: false, termEnded: false, canCountersign: false,
  ...over,
});

describe("groupContracts", () => {
  it("returns Draft · Sent · Signed · Void in that order, every group present even when empty", () => {
    const groups = groupContracts([]);
    expect(groups.map((g) => g.label)).toEqual(["Draft", "Sent", "Signed", "Void"]);
    expect(groups.every((g) => g.rows.length === 0)).toBe(true);
  });

  it("puts each contract under its own status and keeps the arrival order within a group", () => {
    const rows = [k({ id: "a", status: "sent" }), k({ id: "b", status: "draft" }), k({ id: "c", status: "sent" }), k({ id: "d", status: "signed" }), k({ id: "e", status: "void" })];
    const by = Object.fromEntries(groupContracts(rows).map((g) => [g.key, g.rows.map((r) => r.id)]));
    expect(by).toEqual({ draft: ["b"], sent: ["a", "c"], signed: ["d"], void: ["e"] });
  });

  it("🔴 never drops a declined or expired contract: they get a fifth group, present only when it has rows", () => {
    const groups = groupContracts([k({ id: "x", status: "declined" }), k({ id: "y", status: "expired" })]);
    expect(groups.map((g) => g.key)).toEqual(["draft", "sent", "signed", "void", "closed"]);
    expect(groups[4].rows.map((r) => r.id)).toEqual(["x", "y"]);
    expect(groupContracts([k({ status: "draft" })]).map((g) => g.key)).not.toContain("closed");
  });
});

describe("contractActions · what a row offers", () => {
  it("🔴 Send is disabled WITH its reason when the draft has neither terms nor a file", () => {
    const a = contractActions(k({ status: "draft", bodyMd: null, fileId: null }));
    expect(a.send).toEqual({ shown: true, enabled: false, reason: SEND_BLOCKED_REASON });
    expect(contractActions(k({ status: "draft", bodyMd: "   " })).send.enabled).toBe(false);
  });

  it("Send is enabled for a draft with terms, or with a file, and carries no reason", () => {
    expect(contractActions(k({ bodyMd: "Terms." })).send).toEqual({ shown: true, enabled: true, reason: null });
    expect(contractActions(k({ fileId: "f1" })).send).toEqual({ shown: true, enabled: true, reason: null });
  });

  it("Send is not shown for anything but a draft, and Edit is a draft's only", () => {
    for (const status of ["sent", "signed", "declined", "expired", "void"] as const) {
      const a = contractActions(k({ status, bodyMd: "x" }));
      expect(a.send.shown, status).toBe(false);
      expect(a.edit, status).toBe(false);
    }
    expect(contractActions(k({ status: "draft" })).edit).toBe(true);
  });

  it("🔴 Countersign is offered ONLY when the backend says canCountersign is true", () => {
    expect(contractActions(k({ status: "sent", canCountersign: true })).countersign).toBe(true);
    // A sent contract with the flag false (a company_admin, or already signed by us) never offers it,
    // whatever the signatures say: no role or status is read in the browser.
    expect(contractActions(k({ status: "sent", canCountersign: false, clientSigned: true })).countersign).toBe(false);
    expect(contractActions(k({ status: "sent", canCountersign: false, providerSigned: false })).countersign).toBe(false);
    // An older backend that omits the field reads as "not offered", not as truthy-undefined.
    const old = k({ status: "sent" }) as Partial<Contract>;
    delete old.canCountersign;
    expect(contractActions(old as Contract).countersign).toBe(false);
  });

  it("Void is offered from every state except void itself", () => {
    for (const status of ["draft", "sent", "signed", "declined", "expired"] as const) expect(contractActions(k({ status })).void, status).toBe(true);
    expect(contractActions(k({ status: "void" })).void).toBe(false);
  });

  it("hasDocument: terms or a file, and whitespace is not terms", () => {
    expect(hasDocument({ bodyMd: "x", fileId: null })).toBe(true);
    expect(hasDocument({ bodyMd: null, fileId: "f" })).toBe(true);
    expect(hasDocument({ bodyMd: "  \n", fileId: null })).toBe(false);
  });
});

describe("signatures and waiting text", () => {
  it("a signature line names the party, the signer, their title and the date", () => {
    const fmt = (iso: string) => iso.slice(0, 10);
    expect(signatureLine({ party: "client", signer: "u1", signerName: "Dana Whitfield", signerTitle: "Head of Marketing", signedAt: "2026-10-03T08:00:00Z" }, fmt))
      .toBe("Client: Dana Whitfield, Head of Marketing, 2026-10-03");
    expect(signatureLine({ party: "provider", signer: "u2", signerName: "Olive Owner", signerTitle: null, signedAt: "2026-10-04T08:00:00Z" }, fmt))
      .toBe("Our company: Olive Owner, 2026-10-04");
  });

  it("says what a sent contract waits for, in either signing order, and nothing for other states", () => {
    expect(awaitingText({ status: "sent", clientSigned: true, providerSigned: false })).toMatch(/Waiting for our countersignature/);
    expect(awaitingText({ status: "sent", clientSigned: false, providerSigned: true })).toMatch(/Waiting for the client/);
    expect(awaitingText({ status: "sent", clientSigned: false, providerSigned: false })).toMatch(/both parties/);
    expect(awaitingText({ status: "signed", clientSigned: true, providerSigned: true })).toBeNull();
    expect(awaitingText({ status: "draft", clientSigned: false, providerSigned: false })).toBeNull();
  });
});

describe("paymentDecisionState · Confirm, and Reject needs a reason", () => {
  it("confirm never needs a reason", () => {
    expect(paymentDecisionState("confirm", "")).toEqual({ canSubmit: true, reason: null });
  });

  it("🔴 reject is blocked, with its reason, until a non-blank reason is typed", () => {
    for (const r of ["", "   ", "\n\t"]) {
      const s = paymentDecisionState("reject", r);
      expect(s.canSubmit, JSON.stringify(r)).toBe(false);
      expect(s.reason).toMatch(/Say why/);
    }
    expect(paymentDecisionState("reject", "no matching transfer")).toEqual({ canSubmit: true, reason: null });
  });
});

describe("refusal wording", () => {
  it("🔴 the maker-checker 403 reads as 'you recorded this payment', not as a bare forbidden", () => {
    const text = decideErrorText(403, "a payment must be confirmed by someone other than whoever recorded it");
    expect(text).toMatch(/You recorded this payment/);
    expect(text).toMatch(/someone else/);
  });

  it("a plain 403 says the person may not decide payments; an already-decided 400 says to refresh; the rest pass through", () => {
    expect(decideErrorText(403, "not authorized: cerbos denied update on invoice")).toMatch(/permission to decide payments/);
    expect(decideErrorText(400, "this payment is already confirmed")).toMatch(/already been decided/);
    expect(decideErrorText(500, "boom")).toBe("boom");
  });

  it("a countersign 403 says only an owner can sign", () => {
    expect(countersignErrorText(403, "not authorized: cerbos denied countersign on contract")).toMatch(/Only a company owner/);
    expect(countersignErrorText(400, "a draft contract cannot be countersigned")).toBe("a draft contract cannot be countersigned");
  });
});

describe("billingBadgeCount", () => {
  it("adds pending payments to the contracts awaiting our countersignature", () => {
    expect(billingBadgeCount(2, 1)).toBe(3);
    expect(billingBadgeCount(0, 0)).toBe(0);
    expect(billingBadgeCount(4, 0)).toBe(4);
  });
});

describe("validateContractForm", () => {
  const ok = { title: "MSA", value: "", startsOn: "", endsOn: "" };
  it("accepts a title alone", () => expect(validateContractForm(ok)).toBeNull());
  it("needs a title", () => expect(validateContractForm({ ...ok, title: "  " })).toMatchObject({ field: "title" }));
  it("a value is a number that is not negative", () => {
    expect(validateContractForm({ ...ok, value: "12.5" })).toBeNull();
    expect(validateContractForm({ ...ok, value: "0" })).toBeNull();
    expect(validateContractForm({ ...ok, value: "-1" })).toMatchObject({ field: "value" });
    expect(validateContractForm({ ...ok, value: "abc" })).toMatchObject({ field: "value" });
  });
  it("the end cannot be before the start", () => {
    expect(validateContractForm({ ...ok, startsOn: "2026-10-10", endsOn: "2026-10-09" })).toMatchObject({ field: "endsOn" });
    expect(validateContractForm({ ...ok, startsOn: "2026-10-10", endsOn: "2026-10-10" })).toBeNull();
    expect(validateContractForm({ ...ok, endsOn: "2026-10-09" })).toBeNull();
  });
});
