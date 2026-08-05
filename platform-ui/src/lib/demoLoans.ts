import "server-only";
// DEMO_MODE fixtures for employee loans (wave E) — see lib/demoFixtures.ts for the dispatcher.
//
// STATELESS, unlike demoPm/demoAppraisals: a loan's schedule is frozen at approval and its ledger is
// append-only, so there is no interesting in-session mutation to model. Writes return a generic
// success and the derived reads stay put. That keeps every loan surface visually drivable for the
// `DEMO_MODE=1 npm run build` gate and the Playwright smoke project without a second money model
// that could disagree with the real one.
//
// The two loans below are deliberately in DIFFERENT states, because the interesting rendering is in
// the states, not the happy path:
//   - one active, PART-paid, with the boundary instalment partially settled and one overdue
//   - one settled in full
//   - one still pending (no schedule at all — proves the "schedule appears on approval" copy)

interface DemoResultish {
  status: number;
  json: unknown;
}

const DAY = 86_400_000;

/** Mirrors platform-nest's loan-schedule.ts closely enough for fixtures (integer minor units). */
function schedule(principal: number, ratePct: number, months: number, firstDue: Date) {
  const principalCents = Math.round(principal * 100);
  const i = ratePct / 100 / 12;
  const payment = i > 0
    ? Math.round((principalCents * i) / (1 - Math.pow(1 + i, -months)))
    : Math.round(principalCents / months);
  let balance = principalCents;
  const rows: {
    seq: number; dueOn: string; principalDue: number; interestDue: number; totalDue: number;
  }[] = [];
  for (let seq = 1; seq <= months && balance > 0; seq += 1) {
    const interest = i > 0 ? Math.round(balance * i) : 0;
    const principalPart = seq === months ? balance : Math.min(balance, payment - interest);
    balance -= principalPart;
    const due = new Date(firstDue);
    due.setUTCMonth(due.getUTCMonth() + (seq - 1));
    rows.push({
      seq,
      dueOn: due.toISOString().slice(0, 10),
      principalDue: principalPart / 100,
      interestDue: interest / 100,
      totalDue: (principalPart + interest) / 100,
    });
  }
  return rows;
}

/** FIFO allocation + summary, matching summarizeLoan()'s output shape. */
function summarize(
  rows: ReturnType<typeof schedule>,
  repayments: { amount: number; paidOn: string }[],
  asOf: string,
) {
  let pool = repayments.reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const totalPaidCents = pool;
  const installments = rows.map((r) => {
    const dueCents = Math.round(r.totalDue * 100);
    const applied = Math.min(pool, dueCents);
    pool -= applied;
    const outstandingCents = dueCents - applied;
    return {
      ...r,
      paid: applied / 100,
      outstanding: outstandingCents / 100,
      state: outstandingCents === 0 ? "paid" : applied > 0 ? "partial" : "unpaid",
      overdue: outstandingCents > 0 && r.dueOn < asOf,
    };
  });
  const payableCents = rows.reduce((s, r) => s + Math.round(r.totalDue * 100), 0);
  const outstandingCents = Math.max(0, payableCents - totalPaidCents);
  const overdue = installments.filter((x) => x.overdue);
  return {
    installments,
    summary: {
      totalPayable: payableCents / 100,
      totalPrincipal: rows.reduce((s, r) => s + Math.round(r.principalDue * 100), 0) / 100,
      totalInterest: rows.reduce((s, r) => s + Math.round(r.interestDue * 100), 0) / 100,
      totalPaid: totalPaidCents / 100,
      outstanding: outstandingCents / 100,
      credit: pool / 100,
      paidInstallments: installments.filter((x) => x.state === "paid").length,
      installmentCount: installments.length,
      overdueCount: overdue.length,
      overdueAmount: overdue.reduce((s, x) => s + Math.round(x.outstanding * 100), 0) / 100,
      nextDue: installments.find((x) => x.state !== "paid") ?? null,
      settled: installments.length > 0 && outstandingCents === 0,
    },
  };
}

function buildLoans(userId: string) {
  const now = new Date();
  const asOf = now.toISOString().slice(0, 10);

  // ── Active, part-paid, one instalment overdue. First due date is 4 months back so "overdue" and
  //    "part-paid" are both reachable states today, whenever "today" happens to be.
  const activeFirstDue = new Date(now.getTime() - 120 * DAY);
  activeFirstDue.setUTCDate(1);
  const activeRows = schedule(24_000_000, 0, 12, activeFirstDue);
  const activeRepayments = [
    { amount: 2_000_000, paidOn: activeRows[0].dueOn, method: "payroll_deduction", note: null },
    { amount: 2_000_000, paidOn: activeRows[1].dueOn, method: "payroll_deduction", note: null },
    { amount: 1_000_000, paidOn: activeRows[2].dueOn, method: "transfer", note: "Partial — rest next month" },
  ];
  const active = summarize(activeRows, activeRepayments, asOf);

  // ── Settled, interest-bearing, so the interest columns render somewhere.
  const settledFirstDue = new Date(now.getTime() - 500 * DAY);
  settledFirstDue.setUTCDate(1);
  const settledRows = schedule(6_000_000, 12, 6, settledFirstDue);
  const settledTotal = settledRows.reduce((s, r) => s + r.totalDue, 0);
  const settled = summarize(settledRows, [{ amount: settledTotal, paidOn: settledRows[0].dueOn }], asOf);

  return [
    {
      id: "demo-loan-active",
      subjectUserId: userId,
      subjectName: "You",
      principalAmount: 24_000_000,
      currency: "IDR",
      termMonths: 12,
      annualInterestRate: 0,
      purpose: "Motorbike replacement",
      status: "approved",
      approvalId: "demo-approval-loan-1",
      decidedBy: "demo-hansel",
      decidedAt: new Date(now.getTime() - 130 * DAY).toISOString(),
      firstDueOn: activeRows[0].dueOn,
      totalPayable: active.summary.totalPayable,
      createdAt: new Date(now.getTime() - 140 * DAY).toISOString(),
      schedule: active.installments,
      summary: active.summary,
      repayments: activeRepayments.map((r, i) => ({
        id: `demo-repay-${i + 1}`,
        amount: r.amount,
        paidOn: r.paidOn,
        method: r.method,
        note: r.note,
        recordedBy: "demo-hansel",
        recordedByName: "Hansel",
        createdAt: new Date(`${r.paidOn}T09:00:00Z`).toISOString(),
      })),
    },
    {
      id: "demo-loan-settled",
      subjectUserId: userId,
      subjectName: "You",
      principalAmount: 6_000_000,
      currency: "IDR",
      termMonths: 6,
      annualInterestRate: 12,
      purpose: "Family medical",
      status: "settled",
      approvalId: "demo-approval-loan-2",
      decidedBy: "demo-hansel",
      decidedAt: new Date(now.getTime() - 520 * DAY).toISOString(),
      firstDueOn: settledRows[0].dueOn,
      totalPayable: settled.summary.totalPayable,
      createdAt: new Date(now.getTime() - 530 * DAY).toISOString(),
      schedule: settled.installments,
      summary: settled.summary,
      repayments: [{
        id: "demo-repay-settled",
        amount: settledTotal,
        paidOn: settledRows[0].dueOn,
        method: "transfer",
        note: "Settled early in full",
        recordedBy: "demo-hansel",
        recordedByName: "Hansel",
        createdAt: new Date(`${settledRows[0].dueOn}T09:00:00Z`).toISOString(),
      }],
    },
  ];
}

/**
 * Handles /api/:t/modules/hr/loans*. Returns null when the path is not ours, so the caller keeps
 * walking its dispatch chain.
 */
export function loansDemo(
  method: string,
  path: string,
  _params: URLSearchParams,
  _body: string | undefined,
  userId: string,
): DemoResultish | null {
  const m = method.toUpperCase();
  const match = /^\/api\/([^/]+)\/modules\/hr\/loans(?:\/([^/]+))?(?:\/(cancel|repayments))?$/.exec(path);
  if (!match) return null;
  const [, , loanId, sub] = match;

  if (m === "GET" && !loanId) {
    const loans = buildLoans(userId).map(({ repayments, ...rest }) => {
      void repayments; // the list endpoint omits the ledger
      return rest;
    });
    // "self": a demo member's list is already narrowed server-side, so no subject filter renders.
    return { status: 200, json: { loans, scope: "self" } };
  }
  if (m === "GET" && loanId) {
    const loan = buildLoans(userId).find((l) => l.id === loanId);
    if (!loan) return { status: 404, json: { error: "loan not found" } };
    return { status: 200, json: loan };
  }
  // Writes acknowledge without mutating (see the header) — enough for the forms to complete and
  // router.refresh() to re-render.
  if (m === "POST" && !loanId) {
    return { status: 201, json: { id: "demo-loan-new", approvalId: "demo-approval-loan-new", status: "pending" } };
  }
  if (m === "POST" && sub === "cancel") return { status: 200, json: { id: loanId, status: "cancelled" } };
  if (m === "POST" && sub === "repayments") {
    return { status: 201, json: { id: "demo-repay-new", loanId, status: "approved" } };
  }
  return null;
}
