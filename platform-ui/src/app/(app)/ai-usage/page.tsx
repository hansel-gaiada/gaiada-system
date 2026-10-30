import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getCompanyAiUsage } from "@/lib/aiUsage-data";
import { AI_USAGE_COMPANY_FORBIDDEN, COMPANY_AI_USAGE_PATH, parseMonth } from "@/lib/aiUsage";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AiUsageView } from "@/components/aiUsage/AiUsageView";
import { MonthPicker } from "@/components/aiUsage/MonthPicker";

// The company's AI usage (AIP-16, owner ruling AIP-D18; BFF §66.5; Company area): one month of AI use by surface, department, model and day. For the
// owner, the GM, company admins and the superadmin; the department head reads their own unit, and everyone else their own use. Totals only, never a
// person: each department line opens that department's month, where the owner and the head see the people. "No department recorded" and "Company, no
// person" are shown as their own lines, never folded into a department.
//
// WHO SEES IT is decided by the server (`read_company`, which the GM holds through a seat the UI cannot see). The registry offers the link to the
// company read capability and to the GM seat (`leadGm`); a person who opens the address without either gets the server's 403, said in words.
const TITLE = "AI usage";

export default async function CompanyAiUsagePage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Company" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const month = parseMonth(sp.month);
  const read = await getCompanyAiUsage(userId, tenant, month);

  return (
    <>
      <PageHeader eyebrow="Company" title={TITLE} />
      <MonthPicker month={month} basePath={COMPANY_AI_USAGE_PATH} />
      {read.kind === "ok" ? (
        <AiUsageView
          month={read.data.month}
          totals={read.data.totals}
          bySurface={read.data.bySurface}
          byModel={read.data.byModel}
          byDay={read.data.byDay}
          departments={read.data.byDepartment}
          noPerson={read.data.noPerson}
        />
      ) : read.kind === "forbidden" ? (
        <ReadRefusal subject="the company's AI usage" kind="forbidden" detail={AI_USAGE_COMPANY_FORBIDDEN} />
      ) : (
        <ReadRefusal subject="The company's AI usage" kind="unavailable" reason={read.kind === "unavailable" ? read.reason : undefined} />
      )}
    </>
  );
}
