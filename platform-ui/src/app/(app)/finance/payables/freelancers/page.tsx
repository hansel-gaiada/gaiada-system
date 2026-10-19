import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAccounts, listApVendors } from "@/lib/finance";
import { listMembers } from "@/lib/entities";
import { getFreelancerPreviewResult, listFreelancerBillsResult, listFreelancersResult } from "@/lib/freelancers-data";
import { lastMonthRange, periodProblem } from "@/lib/freelancers";
import { todayIsoInDisplayZone } from "@/lib/format";
import { Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { FreelancerRates } from "@/components/finance/FreelancerRates";
import { FreelancerBills } from "@/components/finance/FreelancerBills";

// Freelancers (DW-10f-4b, BFF §61.7 to §61.9, as built §61.18) — people who bill the company by the hour: their rates, and the bills drafted
// from the hours they logged.
//
// ── UNGATED LIKE PAYABLES (DW-7b) ───────────────────────────────────────────────────────────────────────────
// `finance_ap` has no UI capability, so the tab is offered to everyone Payables is. Each read arrives as a `ReadResult`, so a refusal (403)
// or a failure is said in words and never reads as "no freelancers" or "nothing to bill": both are claims about money. The controls are cosmetic;
// Cerbos decides, and every refusal comes back as a sentence.
//
// ── THE PERIOD IS IN THE URL ────────────────────────────────────────────────────────────────────────────────
// `?from=&to=` (default: the whole of last month) so a period is linkable and the page is one GET, with no client state to lose. A period the server
// would refuse is said here and never sent.
export default async function FinanceFreelancersPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
  const dflt = lastMonthRange(todayIsoInDisplayZone());
  const from = one(sp.from) ?? dflt.periodStart;
  const to = one(sp.to) ?? dflt.periodEnd;
  const problem = periodProblem(from, to);

  // The pickers degrade to empty on a failed read: an empty picker offers nothing to submit, which is honest, and the forms say what they need.
  const members = listMembers(userId, tenant).catch((e) => {
    if (e instanceof PlatformError) return [];
    throw e;
  });
  const [freelancers, bills, preview, people, accounts, vendors] = await Promise.all([
    listFreelancersResult(userId, tenant),
    listFreelancerBillsResult(userId, tenant),
    problem ? Promise.resolve(null) : getFreelancerPreviewResult(userId, tenant, from, to),
    members,
    listAccounts(userId, tenant),
    listApVendors(userId, tenant),
  ]);

  const expenseAccounts = accounts
    .filter((a) => a.accountType === "expense" && a.isPostable && !a.isControl && a.allowManualPosting && a.status === "active")
    .map((a) => ({ code: a.code, name: a.name }));

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Freelancers</h1>
        <p className="fin-page__asof">
          Hourly freelancers: their rates, and the bills drafted from their logged hours. <Link href="/finance/payables">Back to Payables</Link>
        </p>
      </header>

      <section aria-labelledby="fl-rates">
        <h2 id="fl-rates" className="type-eyebrow" style={{ marginBottom: 12 }}>Rates</h2>
        <FreelancerRates
          freelancers={freelancers}
          people={people.map((m) => ({ id: m.user_id, name: m.name, email: m.email }))}
          accounts={expenseAccounts}
          vendors={vendors.map((v) => ({ id: v.id, code: v.code, name: v.name, userId: v.userId ?? null }))}
        />
      </section>

      <section aria-labelledby="fl-bills">
        <h2 id="fl-bills" className="type-eyebrow" style={{ marginBottom: 12 }}>Bills</h2>
        <FreelancerBills preview={preview} previewError={problem} period={{ from, to }} bills={bills} />
      </section>
    </div>
  );
}
