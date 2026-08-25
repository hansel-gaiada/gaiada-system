import { FinanceTabs } from "@/components/finance/FinanceTabs";

// The finance workspace shell.
//
// Holds the tab strip and nothing else — no data fetching. Every tab route fetches its own, so
// opening the overview costs the overview's queries and not the whole department's. The previous
// single-console page paid for KPIs, two agings, three integrity verdicts and the close gate on
// every visit, whether or not the reader wanted any of them.
export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fin-shell">
      <FinanceTabs />
      {children}
    </div>
  );
}
