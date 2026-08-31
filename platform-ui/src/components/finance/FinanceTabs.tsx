"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// The finance workspace's tab strip.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// /finance was one scrolling console carrying KPIs, integrity verdicts, two aging tables, the close
// gate, the period calendar and a configuration card. Everything was on screen and nothing was
// findable: the owner's words were "a mash of info put into a page", and the links to the cap table
// sat below three tables nobody scrolls to.
//
// An accountant does not work in a dashboard. They work in a LEDGER, a set of REPORTS and a CLOSE
// CHECKLIST, and they move between them dozens of times a day. Those are places, so they are
// routes — linkable, shareable, reloadable, and each paying only for its own data.
//
// ── TABS ARE ROUTES, NOT STATE ─────────────────────────────────────────────────────────────────
// Same reasoning as ClientHubTabs: a controller can paste "the journals tab" into a chat and it
// opens there. It also means opening the overview does not fetch six tabs' worth of data the reader
// may never look at — which is what the single-console version did on every load.
export interface FinanceTab {
  /** Path segment under `/finance`; `""` is the overview. */
  segment: string;
  label: string;
}

export const FINANCE_TABS: FinanceTab[] = [
  { segment: "", label: "Overview" },
  // Journals FIRST after the overview, deliberately. It is the only surface where a figure can be
  // RECORDED; everything else in this workspace reads what it produced.
  { segment: "journals", label: "Journals" },
  { segment: "ledger", label: "General ledger" },
  { segment: "accounts", label: "Chart of accounts" },
  { segment: "reports", label: "Reports" },
  // F8/F11/F9/F10 — the four engines that were built in SQL and had no door until 2026-08-26.
  // Placed after Reports and before the subledgers because that is the order an accountant meets
  // them: the statements first, then what feeds them.
  { segment: "assets", label: "Fixed assets" },
  { segment: "treasury", label: "Treasury" },
  { segment: "consolidation", label: "Consolidation" },
  { segment: "cutover", label: "Cutover" },
  { segment: "receivables", label: "Receivables" },
  { segment: "payables", label: "Payables" },
  { segment: "tax", label: "Tax" },
  { segment: "close", label: "Period close" },
  { segment: "ownership", label: "Ownership" },
  { segment: "settings", label: "Settings" },
];

export function FinanceTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Finance sections" className="sec-tabs">
      {FINANCE_TABS.map((t) => {
        const href = t.segment ? `/finance/${t.segment}` : "/finance";
        // Exact match for the index, prefix for the rest. Without the special case "Overview" would
        // light on every tab (every path starts with /finance); with only exact matching, a journal
        // DETAIL route would light nothing.
        const active = t.segment ? pathname.startsWith(href) : pathname === "/finance";
        return (
          // BOTH the class and the aria attribute, matching SectionTabs/DeptTabs.
          //
          // `shell.css` styles `.sec-tab--active` (the accent colour and the underline); it has NO
          // `[aria-current]` rule. Setting only the attribute — which this did — is invisible: the
          // strip renders with every tab looking identical and no indication of which page you are
          // on. `aria-current` stays because it is what a screen reader announces; the class is what
          // a sighted reader sees. Neither substitutes for the other.
          <Link
            key={t.segment || "overview"}
            href={href}
            className={`sec-tab${active ? " sec-tab--active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
