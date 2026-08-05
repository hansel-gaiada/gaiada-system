import "server-only";
// Employee loans — READ side (employee-portal wave E). The server-only half of the module trio;
// types + pure helpers are in `loans.ts`, which stays client-safe for the forms.
//
// BFF CONTRACT (built in platform-nest LoansController, under the hr module prefix):
//   GET  /api/:t/modules/hr/loans[?subjectUserId&status]  -> { loans: Loan[], scope: "self"|"tenant" }
//   GET  /api/:t/modules/hr/loans/:id                     -> Loan & { repayments: Repayment[] }
//
// The hr module can be DARK for a company (only the agency has 'hr' enabled today; Sanur Resort and
// the holding company do not). ModuleEnabledGuard then answers 403/404, so both reads below
// absence-degrade rather than throwing — the page renders a "module disabled" note, not an error
// boundary. `scope` tells the caller which Cerbos path won: "self" means a plain member whose list
// is ALREADY narrowed server-side, so no subject filter should be offered.
import { platformFetch, PlatformError } from "./platform";
import type { Loan, LoanDetail, LoanList, LoanStatus } from "./loans";

/** Absence-degrading list read. A 403/404 means "hr is dark here", not "something broke". */
export async function listLoans(
  userId: string,
  tenantId: string,
  q: { subjectUserId?: string; status?: LoanStatus } = {},
): Promise<LoanList> {
  const params = new URLSearchParams();
  if (q.subjectUserId) params.set("subjectUserId", q.subjectUserId);
  if (q.status) params.set("status", q.status);
  const query = params.toString() ? `?${params.toString()}` : "";
  try {
    const r = await platformFetch<{ loans: Loan[]; scope: "self" | "tenant" }>(
      `/api/${tenantId}/modules/hr/loans${query}`,
      userId,
    );
    return { loans: r.loans ?? [], scope: r.scope ?? "self", unavailable: false };
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) {
      return { loans: [], scope: "self", unavailable: true };
    }
    throw e;
  }
}

export async function getLoan(userId: string, tenantId: string, loanId: string): Promise<LoanDetail | null> {
  try {
    return await platformFetch<LoanDetail>(`/api/${tenantId}/modules/hr/loans/${loanId}`, userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}
