import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFinanceSettings, formatNpwp } from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { SettingsEditor } from "@/components/finance/SettingsEditor";

// UI-02b — accounting settings.
//
// ── WHAT IS SHOWN BUT NOT EDITABLE, AND WHY THAT IS STATED ─────────────────────────────────────
// The fiscal year start and the chart-of-accounts template appear here as FACTS, not fields. Both
// are refused by the database once a calendar has been cut — every period boundary, every balance
// sheet's `fyStart` and the year-end close derive from the year start, so moving it re-dates
// history that has already been reported.
//
// A form that offered them and then failed would be worse than one that does not: the field implies
// permission, and the refusal arrives after the user has decided what they want. So they are
// rendered read-only WITH the reason, rather than omitted (which reads as "we forgot") or offered
// (which reads as "go ahead").
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default async function FinanceSettingsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const s = await getFinanceSettings(userId, tenant);

  if (!s) {
    // Deliberately not a form full of defaults. Rendering "IDR / January / not PKP" for a company
    // whose settings could not be loaded would invite someone to save those invented values over
    // whatever is actually there.
    return (
      <EmptyNote>
        This company has no accounting settings yet, or they could not be loaded. Seed the department
        with <code>npm run seed:finance-config</code> in platform-nest first.
      </EmptyNote>
    );
  }

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Accounting settings</h1>
        <p className="fin-page__asof">
          The company&rsquo;s tax identity and reporting currency.
        </p>
      </header>

      <Card title="Tax identity">
        <HairlineTable
          columns={[{ label: "Setting" }, { label: "Value" }]}
          rows={[
            [
              "PKP status",
              <StatusBadge key="pkp" label={s.isPkp ? "active" : "archived"} />,
            ],
            ["NPWP", formatNpwp(s.npwp)],
          ]}
        />
        <p className="fin-muted">
          PKP means this company charges and reports PPN. It cannot be switched off once output VAT
          has been posted — the tax is owed to the tax office whether or not the flag says so.
        </p>
      </Card>

      <SettingsEditor isPkp={s.isPkp} npwp={s.npwp ?? ""} />

      <Card
        title="Fixed for this company"
        hint="Shown because they matter, not editable because the books already depend on them."
      >
        <HairlineTable
          columns={[{ label: "Setting" }, { label: "Value" }, { label: "Why it is fixed" }]}
          rows={[
            [
              "Fiscal year starts",
              MONTHS[(s.fiscalYearStartMonth ?? 1) - 1] ?? String(s.fiscalYearStartMonth),
              "Every period boundary and every balance sheet is dated from it. Moving it would re-date statements already issued.",
            ],
            [
              "Chart of accounts",
              s.coaTemplateKey ?? "—",
              "The template a chart was instantiated from. The accountant edits accounts individually; the template is history.",
            ],
            [
              "Functional currency",
              s.functionalCurrency,
              "Changing it after posting would restate every figure in the ledger.",
            ],
          ]}
        />
      </Card>
    </div>
  );
}
