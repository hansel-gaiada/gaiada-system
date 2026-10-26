// PGL-09 (PV-D47) — the two new client mail templates, `contract.sent` and `invoice.issued`, as pure renders. No database.
// Each is a POINTER mail: the portal link and a fixed sentence, plus (invoice) the number and the total and (contract) the
// title. The rules the owner set, each with teeth (a hostile payload that carries the forbidden thing must still not leak it):
//   * the ONLY link is the plain portal deep link: no token, no query string, no fragment, no second URL
//   * no action-by-reply: nothing tells the reader to reply, approve, accept or confirm by mail
//   * no amount beyond the invoice's number and total; no contract text
//   * English only; the subject cannot be header-injected
// The same templates, from a real mail_log row through `GET /api/admin/mail/log/:id/preview`, are in `client-mail.db.test.ts`.
import { describe, it, expect } from "vitest";
import { renderTemplate } from "./templates";

const HREF_INVOICE = "https://erp.example.invalid/portal/invoices/7d3b2c10-0000-4000-8000-000000000001";
const HREF_CONTRACT = "https://erp.example.invalid/portal/contracts/7d3b2c10-0000-4000-8000-000000000002";

/** Every absolute URL in a rendered mail (subject, text and html), so "the only link" is checked, not assumed. */
function urlsIn(r: { subject: string; text: string; html: string }): string[] {
  const all = [r.subject, r.text, r.html].join("\n");
  return [...all.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
}

/** Things that must never appear in a client pointer mail. */
const FORBIDDEN_WORDING = [
  /\breply\b/i, /\bapprove\b/i, /\baccept\b/i, /\bconfirm\b/i, /\bclick (the|this) (button|link) to (sign|pay)\b/i,
];

describe("PGL-09 template invoice.issued", () => {
  const payload = { href: HREF_INVOICE, invoiceNo: "PGL/2026/10/SVC/0001", total: "15000000.00", currency: "IDR" };

  it("shows the invoice number and the total, with the portal link", () => {
    const r = renderTemplate("invoice.issued", payload);
    expect(r.subject).toBe("Invoice PGL/2026/10/SVC/0001 is ready");
    expect(r.text).toContain("Invoice PGL/2026/10/SVC/0001");
    expect(r.text).toContain("total IDR 15,000,000.00");
    expect(r.text).toContain(HREF_INVOICE);
    expect(r.html).toContain(`href="${HREF_INVOICE}"`);
    expect(r.html).toContain("<strong>IDR 15,000,000.00</strong>");
  });

  it("the ONLY link is the plain portal deep link: no token, no query string, no fragment, no second URL", () => {
    const r = renderTemplate("invoice.issued", payload);
    const urls = urlsIn(r);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set([HREF_INVOICE]));
    const all = [r.subject, r.text, r.html].join("\n");
    expect(all).not.toMatch(/token\s*=/i);
    expect(all).not.toMatch(/[?&#][a-z_]+=/i);
    expect(all).not.toMatch(/\b(magic|otp|code|session|key|secret|jwt|bearer)\b/i);
  });

  it("carries no figure beyond the number and the total: a hostile payload's other money fields never render", () => {
    const r = renderTemplate("invoice.issued", {
      ...payload,
      subtotal: "13513513.51", taxTotal: "1486486.49", dueDate: "2031-12-31", bankAccountNo: "9876543210", lines: [{ amount: 424242 }],
      subjectTitle: "SECRET-LINE-TITLE", body: "SECRET-BODY",
    });
    const all = [r.subject, r.text, r.html].join("\n");
    for (const leak of ["13513513", "13,513,513", "1486486", "1,486,486", "2031-12-31", "9876543210", "424242", "SECRET-LINE-TITLE", "SECRET-BODY"]) {
      expect(all, `leaked ${leak}`).not.toContain(leak);
    }
    // the digits that DO appear are the total and the number (and nothing else numeric beyond the year/month in the number)
    const withoutAllowed = all.replace(/PGL\/2026\/10\/SVC\/0001/g, "").replace(/15,000,000\.00/g, "").replace(/https?:\/\/[^\s"'<>]+/g, "");
    expect(withoutAllowed).not.toMatch(/\d{3,}/);
  });

  it("has no action-by-reply wording", () => {
    const r = renderTemplate("invoice.issued", payload);
    const all = [r.subject, r.text, r.html].join("\n");
    for (const re of FORBIDDEN_WORDING) expect(all, String(re)).not.toMatch(re);
  });

  it("a malformed total is omitted rather than printed; the mail still points at the portal", () => {
    for (const total of ["NaN", "1e21", "-5", "12.3.4", "1,000", "IDR 5", "<script>", ""]) {
      const r = renderTemplate("invoice.issued", { href: HREF_INVOICE, invoiceNo: "N-1", total, currency: "IDR" });
      expect(r.text, `total=${JSON.stringify(total)}`).not.toMatch(/total/);
      expect(r.text).toContain(HREF_INVOICE);
    }
  });

  it("groups the integer part without touching the decimals (no float round trip)", () => {
    const grouped = (total: string) => renderTemplate("invoice.issued", { href: HREF_INVOICE, invoiceNo: "N-1", total, currency: "usd" }).text;
    expect(grouped("999")).toContain("total USD 999,");
    expect(grouped("1000")).toContain("USD 1,000,");
    expect(grouped("1234567.5")).toContain("USD 1,234,567.5,");
    expect(grouped("9007199254740993.01")).toContain("USD 9,007,199,254,740,993.01"); // beyond 2^53: exact, because it is a string
  });

  it("escapes a hostile invoice number and cannot inject a header through the subject", () => {
    const r = renderTemplate("invoice.issued", { href: HREF_INVOICE, invoiceNo: "X\r\nBcc: evil@example.invalid <script>alert(1)</script>", total: "1.00", currency: "IDR" });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("is English, and still renders (a pointer, no amount) when the payload has nothing but the link", () => {
    const r = renderTemplate("invoice.issued", { href: HREF_INVOICE });
    expect(r.subject).toBe("A new invoice is ready");
    expect(r.text).toContain("Sign in to view it and pay");
    expect(r.text).toContain(HREF_INVOICE);
  });

  it("refuses a non-http(s) link: it renders as inert text, not a clickable script URL", () => {
    const r = renderTemplate("invoice.issued", { href: "javascript:alert(1)", invoiceNo: "N-1", total: "1.00", currency: "IDR" });
    expect(r.html).toContain('href=""');
  });
});

describe("PGL-09 template contract.sent", () => {
  const payload = { href: HREF_CONTRACT, contractTitle: "Master services agreement" };

  it("names the contract by its title only, and points at the portal page", () => {
    const r = renderTemplate("contract.sent", payload);
    expect(r.subject).toBe("A contract is ready for you to review and sign");
    expect(r.text).toContain('("Master services agreement")');
    expect(r.text).toContain("in your client portal");
    expect(r.text).toContain(HREF_CONTRACT);
    expect(r.html).toContain(`href="${HREF_CONTRACT}"`);
  });

  it("the ONLY link is the plain portal deep link: no token, no query string, no fragment, no second URL", () => {
    const r = renderTemplate("contract.sent", payload);
    expect(new Set(urlsIn(r))).toEqual(new Set([HREF_CONTRACT]));
    const all = [r.subject, r.text, r.html].join("\n");
    expect(all).not.toMatch(/token\s*=/i);
    expect(all).not.toMatch(/[?&#][a-z_]+=/i);
    expect(all).not.toMatch(/\b(magic|otp|session|secret|jwt|bearer)\b/i);
  });

  it("carries no contract text and no amounts: a hostile payload's body, value and dates never render", () => {
    const r = renderTemplate("contract.sent", {
      ...payload, bodyMd: "SECRET-CLAUSE-7: the client owes 99,999,999", value: "99999999", currency: "IDR", startsOn: "2031-01-01",
      body: "SECRET-BODY", subjectTitle: "Please review and sign: SECRET-SUBJECT",
    });
    const all = [r.subject, r.text, r.html].join("\n");
    for (const leak of ["SECRET-CLAUSE-7", "99999999", "99,999,999", "2031-01-01", "SECRET-BODY", "SECRET-SUBJECT"]) {
      expect(all, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it("has no action-by-reply wording, and signing is never offered by mail", () => {
    const r = renderTemplate("contract.sent", payload);
    const all = [r.subject, r.text, r.html].join("\n");
    for (const re of FORBIDDEN_WORDING) expect(all, String(re)).not.toMatch(re);
    expect(r.text).toContain("Sign in to read it");
  });

  it("escapes a hostile title, and renders without one", () => {
    const hostile = renderTemplate("contract.sent", { href: HREF_CONTRACT, contractTitle: "<img src=x onerror=alert(1)>" });
    expect(hostile.html).not.toContain("<img");
    expect(hostile.html).toContain("&lt;img");
    const bare = renderTemplate("contract.sent", { href: HREF_CONTRACT });
    expect(bare.text).toContain("A contract is ready");
    expect(bare.text).not.toContain('("');
  });
});
