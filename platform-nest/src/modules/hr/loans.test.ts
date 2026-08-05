// Employee loans (wave E) end-to-end against live Postgres + Cerbos + Redis (skips without
// DATABASE_URL_TEST/CERBOS_URL/REDIS_URL_TEST). Same harness as hr.test.ts.
//
// WHY THIS FILE EXISTS. loan-schedule.test.ts covers the arithmetic with 19 pure tests, and
// hr.test.ts covers the leave decide->event->apply pipeline — but nothing executed the LOAN approval
// path. `loan-decision.ts` is where the amortization schedule is BORN, and it only ever runs inside
// the `automation_approval.decided` consumer, so neither a unit test nor a controller test reaches
// it. That left the single most consequential step in the feature — approval materializing the rows
// that define what an employee OWES — never once run anywhere: not on the dev box (no local DB), not
// in CI, and not on the server (AUTH_MODE=oidc closes the dev header, so no token to drive it with).
// This closes that, in the place that runs on every push.
//
// The beats, in the order a real loan lives:
//   (1) a plain member may request for HIMSELF (the resource_hr_case.yaml member rule), and one
//       transaction produces both the request and an origin='hr' approval at impact `high`,
//   (2) one live loan per employee,
//   (3) list narrowing: a member gets scope "self"; another member gets 404, never 403,
//   (4) THE ASYMMETRY: the borrower cannot write his own ledger (hr_case:update, which `member`
//       does not hold) — the whole design rests on this,
//   (5) approve via the EXISTING unified endpoint -> real outbox->redis->consumer -> the schedule is
//       frozen, the header fields are set in the same transaction, and the subject is notified,
//   (6) FIFO allocation across the ledger, and auto-settle DERIVED from it rather than latched,
//   (7) interest-bearing: interest declines on the falling balance and the schedule still sums to
//       the principal exactly,
//   (8) denial leaves NO schedule; withdrawal cancels the paired approval,
//   (9) the module wall: with hr dark, every loan route 404s.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { hrModule } from "./index";
import { relayBatch } from "../../events/relay";
import { consumeOnce } from "../../events/consumer.service";
import { setRedis, closeRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function drainConsumer(entityTypes: string[]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const relayed = await relayBatch(500);
    let consumed = 0;
    for (const t of entityTypes) consumed += await consumeOnce(t);
    if (relayed === 0 && consumed === 0) return;
  }
}

interface LoanBody {
  id: string;
  status: string;
  currency: string;
  firstDueOn: string | null;
  totalPayable: number | null;
  schedule: { seq: number; dueOn: string; principalDue: number; interestDue: number; totalDue: number; state: string; paid: number }[];
  summary: {
    totalPayable: number; totalPrincipal: number; totalInterest: number; totalPaid: number;
    outstanding: number; credit: number; paidInstallments: number; installmentCount: number;
    overdueCount: number; settled: boolean;
  };
  repayments?: { id: string; amount: number; method: string }[];
}

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("Employee loans (wave E)", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let T: string;    // hr-enabled company
  let DARK: string; // a company where hr is NOT enabled
  let admin: string;
  let member: string;
  let other: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    registerModule(hrModule);

    T = await createCompany("Loans Co (hr enabled)", ["hr"]);
    DARK = await createCompany("No-HR Co", []);

    admin = await createUser("loans-admin@t.test");
    member = await createUser("borrower@t.test");
    other = await createUser("colleague@t.test");
    await addMembership(T, admin);
    await addMembership(T, member);
    await addMembership(T, other);
    await addMembership(DARK, member);

    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, companyAdminRole, "company", T);
    await grantRole(member, memberRole, "company", T);
    await grantRole(other, memberRole, "company", T);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  const post = (userId: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: asUser(userId), ...(payload ? { payload } : {}) });
  const get = (userId: string, url: string) => app.inject({ method: "GET", url, headers: asUser(userId) });

  let loanId: string;
  let approvalId: string;

  // ─────────────────────────────────────────────────────────────────── (1) request ──
  it("a plain member may request a loan for HIMSELF, and it files an origin=hr approval at impact high", async () => {
    const r = await post(member, `/api/${T}/modules/hr/loans`, {
      subjectUserId: member, principalAmount: 24_000_000, termMonths: 12, purpose: "Motorbike",
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; approvalId: string; status: string };
    loanId = body.id;
    approvalId = body.approvalId;
    expect(body.status).toBe("pending");
    expect(loanId).toBeTruthy();
    expect(approvalId).toBeTruthy();

    // The approval and the request are written in ONE transaction, and the approval must carry the
    // loan id in tool_args — that field is the ONLY thing routing the decision back to this loan.
    const appr = await withTenants(
      [T],
      (c) => c.query<{ workflow_id: string; origin: string; impact: string; tool_args: { loanRequestId?: string } }>(
        `SELECT workflow_id, origin, impact, tool_args FROM automation_approvals WHERE id = $1`,
        [approvalId],
      ),
      { modules: ["hr"] },
    );
    const row = appr.rows[0];
    expect(row.workflow_id).toBe("hr:loan");
    expect(row.origin).toBe("hr");
    // `high`, not leave's `medium`: approving this one moves money.
    expect(row.impact).toBe("high");
    expect(row.tool_args.loanRequestId).toBe(loanId);

    // Nothing is owed until approval: a pending loan has NO schedule at all.
    const g = (await get(member, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(g.schedule).toEqual([]);
    expect(g.totalPayable).toBeNull();   // null, NOT 0 — 0 would read as an interest-free total
    expect(g.summary.settled).toBe(false); // an empty schedule must never read as settled
  });

  // ───────────────────────────────────────────────────────────── (2) one at a time ──
  it("refuses a SECOND live request from the same employee", async () => {
    const r = await post(member, `/api/${T}/modules/hr/loans`, {
      subjectUserId: member, principalAmount: 1_000_000, termMonths: 3,
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/pending or active loan/i);
  });

  it("validates the terms rather than storing nonsense", async () => {
    for (const payload of [
      { subjectUserId: other, principalAmount: 0, termMonths: 6 },
      { subjectUserId: other, principalAmount: 1000, termMonths: 0 },
      { subjectUserId: other, principalAmount: 1000, termMonths: 121 },
      { subjectUserId: other, principalAmount: 1000, termMonths: 6, annualInterestRate: 101 },
      { subjectUserId: other, principalAmount: 1000, termMonths: 6, currency: "rupiah" },
    ]) {
      const r = await post(other, `/api/${T}/modules/hr/loans`, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  // ───────────────────────────────────────────────────────────── (3) list narrowing ──
  it("narrows a member's list to himself and reports scope=self", async () => {
    const r = await get(member, `/api/${T}/modules/hr/loans`);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { loans: LoanBody[]; scope: string };
    expect(body.scope).toBe("self");
    expect(body.loans.map((l) => l.id)).toContain(loanId);
  });

  it("gives staff the whole tenant and reports scope=tenant", async () => {
    const body = (await get(admin, `/api/${T}/modules/hr/loans`)).json() as { loans: LoanBody[]; scope: string };
    expect(body.scope).toBe("tenant");
    expect(body.loans.map((l) => l.id)).toContain(loanId);
  });

  it("hides one employee's loan from another with 404, not 403 (the id must not leak)", async () => {
    const r = await get(other, `/api/${T}/modules/hr/loans/${loanId}`);
    expect(r.statusCode).toBe(404);
  });

  it("refuses a member requesting on someone ELSE's behalf", async () => {
    const r = await post(other, `/api/${T}/modules/hr/loans`, {
      subjectUserId: member, principalAmount: 500_000, termMonths: 2,
    });
    expect(r.statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────── (4) THE ASYMMETRY ──
  it("DENIES the borrower recording a repayment against his own loan", async () => {
    // The single most important authorization fact in this feature: recording a repayment
    // authorizes as hr_case:update, an action the `member` derived role does not hold. An employee
    // may ask for money and may watch the balance, but may never declare it repaid.
    const r = await post(member, `/api/${T}/modules/hr/loans/${loanId}/repayments`, { amount: 1_000_000 });
    expect(r.statusCode).toBe(403);
  });

  it("refuses a repayment against a loan that has no schedule yet", async () => {
    const r = await post(admin, `/api/${T}/modules/hr/loans/${loanId}/repayments`, { amount: 1_000_000 });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/pending/i);
  });

  // ──────────────────────────────────────────────── (5) approval BIRTHS the schedule ──
  it("approving via the unified endpoint freezes the schedule through the real event pipeline", async () => {
    const decided = await post(admin, `/api/${T}/automation-approvals/${approvalId}/decide`, { decision: "approved" });
    expect(decided.statusCode).toBe(200);

    await drainConsumer(["automation_approval", "hr_loan_request"]);

    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(loan.status).toBe("approved");
    expect(loan.summary.installmentCount).toBe(12);
    expect(loan.schedule).toHaveLength(12);
    // Interest-free, so the total owed is exactly the principal.
    expect(loan.summary.totalPayable).toBe(24_000_000);
    expect(loan.summary.totalInterest).toBe(0);
    expect(loan.schedule[0].totalDue).toBe(2_000_000);
    // THE invariant, on real rows this time: twelve rounded instalments must still sum to the
    // principal exactly.
    const sumPrincipal = loan.schedule.reduce((s, i) => s + Number(i.principalDue), 0);
    expect(Math.round(sumPrincipal * 100)).toBe(24_000_000 * 100);
    // Header fields are written in the SAME transaction as the rows, so a half-scheduled loan
    // cannot exist.
    expect(loan.totalPayable).toBe(24_000_000);
    expect(loan.firstDueOn).toBe(loan.schedule[0].dueOn);
    expect(loan.firstDueOn?.endsWith("-01")).toBe(true); // anchored on the 1st of a month
    // Consecutive months, no gaps and no doubled months (the addMonths clamping rule).
    const months = new Set(loan.schedule.map((i) => i.dueOn.slice(0, 7)));
    expect(months.size).toBe(12);
  });

  it("notifies the subject with a deep link into HIS section, not the HR console", async () => {
    // withTenants, NOT withGlobal: `notifications` is in 0001's FORCE-RLS sweep, so a read with no
    // tenant GUC set returns ZERO rows and reports success — which reads exactly like "notify()
    // never fired". (It cost a wrong conclusion here before the tenant scope was added.)
    const n = await withTenants([T], (c) =>
      c.query<{ type: string; payload: { href?: string; decision?: string; monthlyPayment?: number } }>(
        `SELECT type, payload FROM notifications WHERE user_id = $1 AND type = 'hr.loan.decided' ORDER BY created_at DESC LIMIT 1`,
        [member],
      ),
    );
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].payload.href).toBe(`/me/loans/${loanId}`);
    expect(n.rows[0].payload.decision).toBe("approved");
    // The terms travel with the notification — the numbers are the point of it.
    expect(n.rows[0].payload.monthlyPayment).toBe(2_000_000);
  });

  it("is idempotent: a redelivered decided event must not schedule the loan twice", async () => {
    // Only a still-pending row transitions, which is also what stops the installment INSERT running
    // a second time. Re-draining is the cheapest way to simulate redelivery.
    await drainConsumer(["automation_approval", "hr_loan_request"]);
    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(loan.schedule).toHaveLength(12);
    expect(loan.summary.totalPayable).toBe(24_000_000);
  });

  // ──────────────────────────────────────────────────── (6) the ledger, FIFO + settle ──
  it("allocates a partial repayment FIFO and leaves the loan open", async () => {
    const r = await post(admin, `/api/${T}/modules/hr/loans/${loanId}/repayments`, {
      amount: 2_000_000, method: "payroll_deduction", note: "first instalment",
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { status: string; summary: LoanBody["summary"] };
    expect(body.status).toBe("approved"); // still open
    expect(body.summary.totalPaid).toBe(2_000_000);
    expect(body.summary.outstanding).toBe(22_000_000);
    expect(body.summary.paidInstallments).toBe(1);
    expect(body.summary.settled).toBe(false);

    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(loan.schedule[0].state).toBe("paid");
    expect(loan.schedule[1].state).toBe("unpaid");
  });

  it("marks the boundary instalment PARTIAL when a payment straddles it", async () => {
    const r = await post(admin, `/api/${T}/modules/hr/loans/${loanId}/repayments`, { amount: 1_000_000, method: "cash" });
    expect(r.statusCode).toBe(201);
    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(loan.schedule[1].state).toBe("partial");
    expect(loan.schedule[1].paid).toBe(1_000_000);
    expect(loan.summary.outstanding).toBe(21_000_000);
    // The partial instalment is what is NEXT owed — not the next untouched one.
    expect(loan.summary.paidInstallments).toBe(1);
  });

  it("auto-settles from the LEDGER when it covers the schedule, and the borrower can still read it", async () => {
    const r = await post(admin, `/api/${T}/modules/hr/loans/${loanId}/repayments`, { amount: 21_000_000, method: "transfer" });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { status: string }).status).toBe("settled");

    // Read back as the BORROWER: he may always see his own loan and its whole ledger.
    const loan = (await get(member, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(loan.status).toBe("settled");
    expect(loan.summary.outstanding).toBe(0);
    expect(loan.summary.totalPaid).toBe(24_000_000);
    expect(loan.summary.credit).toBe(0); // no phantom overpayment
    expect(loan.summary.settled).toBe(true);
    expect(loan.repayments).toHaveLength(3);
    expect(loan.schedule.every((i) => i.state === "paid")).toBe(true);
  });

  it("shows an overpayment as CREDIT rather than a negative balance", async () => {
    const r = await post(admin, `/api/${T}/modules/hr/loans/${loanId}/repayments`, { amount: 500_000, method: "other" });
    expect(r.statusCode).toBe(201);
    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${loanId}`)).json() as LoanBody;
    expect(loan.summary.outstanding).toBe(0);
    expect(loan.summary.credit).toBe(500_000);
    expect(loan.status).toBe("settled");
  });

  // ─────────────────────────────────────────────────────────── (7) interest-bearing ──
  it("charges interest on the DECLINING balance and still sums to the principal", async () => {
    const req = await post(other, `/api/${T}/modules/hr/loans`, {
      subjectUserId: other, principalAmount: 12_000_000, termMonths: 12, annualInterestRate: 12,
    });
    expect(req.statusCode).toBe(201);
    const { id, approvalId: ap } = req.json() as { id: string; approvalId: string };
    expect((await post(admin, `/api/${T}/automation-approvals/${ap}/decide`, { decision: "approved" })).statusCode).toBe(200);
    await drainConsumer(["automation_approval", "hr_loan_request"]);

    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${id}`)).json() as LoanBody;
    expect(loan.status).toBe("approved");
    expect(loan.summary.totalInterest).toBeGreaterThan(0);
    expect(loan.summary.totalPayable).toBeGreaterThan(12_000_000);
    expect(loan.summary.totalPrincipal).toBe(12_000_000);
    // 1%/month on the opening balance, then falling as principal is repaid.
    expect(loan.schedule[0].interestDue).toBe(120_000);
    expect(loan.schedule[11].interestDue).toBeLessThan(loan.schedule[0].interestDue);
    expect(loan.schedule[11].principalDue).toBeGreaterThan(loan.schedule[0].principalDue);
    const sumPrincipal = loan.schedule.reduce((s, i) => s + Number(i.principalDue), 0);
    expect(Math.round(sumPrincipal * 100)).toBe(12_000_000 * 100);
  });

  // ────────────────────────────────────────────────────── (8) denial and withdrawal ──
  it("a DENIED request gets no schedule at all", async () => {
    const subject = await createUser("denied@t.test");
    await addMembership(T, subject);
    const memberRole = await createRole("member");
    await grantRole(subject, memberRole, "company", T);

    const req = await post(subject, `/api/${T}/modules/hr/loans`, {
      subjectUserId: subject, principalAmount: 9_000_000, termMonths: 6,
    });
    const { id, approvalId: ap } = req.json() as { id: string; approvalId: string };
    await post(admin, `/api/${T}/automation-approvals/${ap}/decide`, { decision: "rejected" });
    await drainConsumer(["automation_approval", "hr_loan_request"]);

    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${id}`)).json() as LoanBody;
    expect(loan.status).toBe("denied");
    expect(loan.schedule).toEqual([]);
    expect(loan.totalPayable).toBeNull();
    // A denial frees the employee to ask again.
    const again = await post(subject, `/api/${T}/modules/hr/loans`, {
      subjectUserId: subject, principalAmount: 1_000_000, termMonths: 2,
    });
    expect(again.statusCode).toBe(201);
  });

  it("withdrawing a pending request also cancels the approval waiting in the inbox", async () => {
    const subject = await createUser("withdrawer@t.test");
    await addMembership(T, subject);
    const memberRole = await createRole("member");
    await grantRole(subject, memberRole, "company", T);

    const req = await post(subject, `/api/${T}/modules/hr/loans`, {
      subjectUserId: subject, principalAmount: 3_000_000, termMonths: 3,
    });
    const { id, approvalId: ap } = req.json() as { id: string; approvalId: string };

    const cancelled = await post(subject, `/api/${T}/modules/hr/loans/${id}/cancel`);
    expect(cancelled.statusCode).toBe(200);

    const loan = (await get(admin, `/api/${T}/modules/hr/loans/${id}`)).json() as LoanBody;
    expect(loan.status).toBe("cancelled");

    const appr = await withTenants(
      [T],
      (c) => c.query<{ status: string }>(`SELECT status FROM automation_approvals WHERE id = $1`, [ap]),
      { modules: ["hr"] },
    );
    expect(appr.rows[0].status).toBe("cancelled");

    // Cancelling twice is refused rather than silently accepted.
    expect((await post(subject, `/api/${T}/modules/hr/loans/${id}/cancel`)).statusCode).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────── (9) module wall ──
  it("404s every loan route while hr is dark for the company", async () => {
    expect((await get(member, `/api/${DARK}/modules/hr/loans`)).statusCode).toBe(404);
    expect((await post(member, `/api/${DARK}/modules/hr/loans`, {
      subjectUserId: member, principalAmount: 1_000_000, termMonths: 6,
    })).statusCode).toBe(404);
  });
});
