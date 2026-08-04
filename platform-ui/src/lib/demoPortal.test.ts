import { describe, it, expect } from "vitest";
import { portalDashboardDemo } from "./demoPortal";

// CP-16 — the demo store's BEHAVIOURAL fidelity, not its data.
//
// Fixtures are usually not worth testing. These are, for one reason: DEMO_MODE is what the `next build`
// gate and the Playwright suite run against, so if the fixture is more permissive than the real BFF, every
// downstream check passes against a backend that does not exist. The two properties that must not drift
// are the identity refusal and the payment claim/confirm split — both are security-shaped, and both are
// invisible in a browser until someone specifically looks.
const T = (p: string) => `/api/co-agency/portal/${p}`;
const CLIENT = "demo-client";

describe("demoPortal fixture fidelity", () => {
  it("refuses a staff caller exactly as the real scope resolver does", () => {
    // Without this the demo would show a staff member a client dashboard, and the staff teach-state on
    // /portal would be unreachable dead code.
    const r = portalDashboardDemo("GET", T("overview"), "demo-hansel");
    expect(r?.status).toBe(403);
    expect((r?.json as { error: string }).error).toMatch(/not a portal client/);
  });

  it("returns null for routes it does not own, so runs/gates still reach demoPipeline", () => {
    // The dispatch order in demoFixtures depends on this: portalDashboardDemo runs FIRST and must fall
    // through for `/portal/runs`, or the WS11 approval flow silently stops working in demo mode.
    expect(portalDashboardDemo("GET", T("runs"), CLIENT)).toBeNull();
    expect(portalDashboardDemo("GET", T("runs/run-demo-1"), CLIENT)).toBeNull();
  });

  it("returns null for a non-portal path", () => {
    expect(portalDashboardDemo("GET", "/api/co-agency/clients", CLIENT)).toBeNull();
  });

  it("serves an overview with a needs-you list and finance totals", () => {
    const r = portalDashboardDemo("GET", T("overview"), CLIENT);
    expect(r?.status).toBe(200);
    const b = r?.json as {
      needsYou: unknown[];
      finance: { primary: { outstanding: number; invoiced: number; paid: number } };
      progress: { percent: number };
    };
    expect(b.needsYou.length).toBeGreaterThan(0);
    // Derived from the invoice + payment fixtures, not hard-coded, so the overview can never contradict
    // the invoices page.
    expect(b.finance.primary.outstanding).toBe(b.finance.primary.invoiced - b.finance.primary.paid);
    expect(b.progress.percent).toBeGreaterThan(0);
  });

  it("404s an unknown project rather than inventing one", () => {
    expect(portalDashboardDemo("GET", T("projects/nope"), CLIENT)?.status).toBe(404);
  });

  it("timeline carries both tenses", () => {
    const events = portalDashboardDemo("GET", T("timeline"), CLIENT)?.json as Array<{ tense: string }>;
    expect(new Set(events.map((e) => e.tense))).toEqual(new Set(["due", "happened"]));
  });

  it("ships an overdue open milestone so the overdue styling is drivable", () => {
    // A fixture with no overdue item leaves the "Was due" branch and the danger colour unreachable in a
    // browser, which is how such a branch ships broken.
    const ms = portalDashboardDemo("GET", T("milestones"), CLIENT)?.json as Array<{ status: string; dueDate: string }>;
    const today = new Date().toISOString().slice(0, 10);
    expect(ms.some((m) => m.status !== "done" && m.dueDate < today)).toBe(true);
  });

  it("ships a contract awaiting the client's signature", () => {
    const list = portalDashboardDemo("GET", T("contracts"), CLIENT)?.json as Array<{ status: string; clientSigned: boolean; providerSigned: boolean }>;
    expect(list.some((k) => k.status === "sent" && !k.clientSigned && k.providerSigned)).toBe(true);
  });

  it("never exposes a draft contract", () => {
    const list = portalDashboardDemo("GET", T("contracts"), CLIENT)?.json as Array<{ status: string }>;
    expect(list.every((k) => k.status !== "draft")).toBe(true);
  });

  // ── the claim/confirm split ───────────────────────────────────────────────────────────────────────
  it("records a payment as PENDING and leaves the balance untouched", () => {
    const before = portalDashboardDemo("GET", T("invoices/inv-2026-021"), CLIENT)?.json as { balance: number; total: number };
    const paidOn = new Date().toISOString().slice(0, 10);
    const r = portalDashboardDemo("POST", T("invoices/inv-2026-021/payments"), CLIENT,
      JSON.stringify({ amount: 1_000_000, paidOn }));
    expect(r?.status).toBe(201);
    expect((r?.json as { status: string }).status).toBe("pending");

    const after = portalDashboardDemo("GET", T("invoices/inv-2026-021"), CLIENT)?.json as {
      balance: number; status: string; payments: Array<{ status: string }>;
    };
    // The property: a client's claim moves NOTHING. Crediting it here would make the behaviour most
    // likely to be misread by a reviewer ("the client marked it paid?") look like the intended design.
    expect(after.balance).toBe(before.balance);
    expect(after.status).toBe("sent");
    expect(after.payments.some((p) => p.status === "pending")).toBe(true);
  });

  it("refuses an overpayment with the same message shape as the BFF", () => {
    const paidOn = new Date().toISOString().slice(0, 10);
    const r = portalDashboardDemo("POST", T("invoices/inv-2026-014/payments"), CLIENT,
      JSON.stringify({ amount: 999_999_999, paidOn }));
    expect(r?.status).toBe(400);
    expect((r?.json as { error: string }).error).toMatch(/outstanding balance/);
  });

  it("refuses a future-dated payment", () => {
    const future = new Date(Date.now() + 86_400_000 * 5).toISOString().slice(0, 10);
    const r = portalDashboardDemo("POST", T("invoices/inv-2026-014/payments"), CLIENT,
      JSON.stringify({ amount: 1, paidOn: future }));
    expect(r?.status).toBe(400);
  });

  // ── signing ───────────────────────────────────────────────────────────────────────────────────────
  it("refuses a signature without the attestation", () => {
    const r = portalDashboardDemo("POST", T("contracts/ctr-sow-brand/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield" }));
    expect(r?.status).toBe(400);
    expect((r?.json as { field?: string }).field).toBe("agree");
  });

  it("completes only when both parties are in, and is idempotent on re-sign", () => {
    // ctr-sow-site already carries the PROVIDER signature, so the client's makes it complete.
    const first = portalDashboardDemo("POST", T("contracts/ctr-sow-site/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true }));
    expect(first?.json).toMatchObject({ complete: true, alreadySigned: false });
    const detail = portalDashboardDemo("GET", T("contracts/ctr-sow-site"), CLIENT)?.json as { status: string; canSign: boolean };
    expect(detail.status).toBe("signed");
    expect(detail.canSign).toBe(false);

    // A double-tapped button on a phone must not read as a failure on something this consequential.
    const again = portalDashboardDemo("POST", T("contracts/ctr-sow-site/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true }));
    expect(again?.status).toBe(200);
    expect((again?.json as { alreadySigned: boolean }).alreadySigned).toBe(true);
  });

  it("a client signature alone does NOT complete an unsigned-by-us agreement", () => {
    // ctr-sow-brand has no provider signature. The status must stay `sent`.
    const r = portalDashboardDemo("POST", T("contracts/ctr-sow-brand/sign"), CLIENT,
      JSON.stringify({ signerName: "Dana Whitfield", agree: true }));
    expect(r?.json).toMatchObject({ complete: false });
    const detail = portalDashboardDemo("GET", T("contracts/ctr-sow-brand"), CLIENT)?.json as { status: string };
    expect(detail.status).toBe("sent");
  });

  // ── profile ───────────────────────────────────────────────────────────────────────────────────────
  it("updates the caller's own name and nothing else", () => {
    const r = portalDashboardDemo("PATCH", T("profile"), CLIENT,
      JSON.stringify({ name: "Dana W. Whitfield", email: "hijack@evil.test" }));
    expect(r?.status).toBe(200);
    const after = portalDashboardDemo("GET", T("profile"), CLIENT)?.json as { me: { name: string; email: string } };
    expect(after.me.name).toBe("Dana W. Whitfield");
    expect(after.me.email).toBe("dana@northwind.example");
  });

  it("accepts a change request with 202 and does not mutate the client", () => {
    const before = portalDashboardDemo("GET", T("profile"), CLIENT)?.json as { clients: Array<{ name: string }> };
    const r = portalDashboardDemo("POST", T("profile/change-request"), CLIENT,
      JSON.stringify({ message: "New billing address please" }));
    expect(r?.status).toBe(202);
    const after = portalDashboardDemo("GET", T("profile"), CLIENT)?.json as { clients: Array<{ name: string }> };
    expect(after.clients[0].name).toBe(before.clients[0].name);
  });

  it("reports poll mode for the stream, exercising the fallback path", () => {
    // SSE is not representable in a JSON fixture. Reporting `poll` means demo mode and the e2e suite
    // exercise the POLLING path — the one most likely to be broken and least likely to be noticed.
    expect(portalDashboardDemo("GET", T("stream"), CLIENT)?.json).toMatchObject({ mode: "poll" });
  });
});
