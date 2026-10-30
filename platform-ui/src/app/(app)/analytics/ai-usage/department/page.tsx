import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, leadUnits, leadsAnyUnitWith } from "@/lib/rbac";
import { readOrgRoot } from "@/lib/campaigns-data";
import { unitOptions } from "@/lib/activityTeam";
import { getUnitAiUsage } from "@/lib/aiUsage-data";
import { AI_USAGE_FORBIDDEN, AI_USAGE_NOT_FOUND, DEPARTMENT_AI_USAGE_PATH, departmentAiUsageHref, parseMonth } from "@/lib/aiUsage";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AiUsageView } from "@/components/aiUsage/AiUsageView";
import { MonthPicker } from "@/components/aiUsage/MonthPicker";
import "@/components/aiUsage/aiUsage.css";

// Analytics > AI usage (AIP-16, owner rulings AIP-D6 and AIP-D18; BFF §66.4): one department's month of AI use, by surface, model and day, and PER
// PERSON when the server sends the people (the department's head and the owner; the key is absent for company admins and the GM, and then no person is
// drawn, never an empty list). Counts and money only: no thread title, no prompt, no text. A unit counts its whole subtree.
//
// WHO SEES IT: the server decides every read (`read_people`, else `read_unit`, else `read_company`, else 403). The registry offers the tab to the unit's
// head (`unitCap` `ai_usage.read_unit`) and to the company read; this page asks the server whenever it is given a unit, so the GM, who holds the read
// through a seat the UI cannot see, is not turned away. A refusal is said in words, a department that does not exist is said as such (404
// `unit_not_found`), and neither is drawn as an empty month. With no `?unit=` the page offers the departments the person may open.
const TITLE = "AI usage";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function DepartmentAiUsagePage({ searchParams }: { searchParams: Promise<{ unit?: string | string[]; month?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const unit = first(sp.unit) || null;
  const month = parseMonth(sp.month);

  // No unit: pick one. A head is offered the units they lead (and what sits beneath them); the company read, every department.
  if (unit === null) {
    const wide = can(me, "ai_usage.read_company", tenant);
    if (!wide && !leadsAnyUnitWith(me, "ai_usage.read_unit", tenant)) {
      return (
        <>
          <PageHeader eyebrow="Analytics" title={TITLE} />
          <EmptyNote>{AI_USAGE_FORBIDDEN}</EmptyNote>
        </>
      );
    }
    const root = await readOrgRoot(me, tenant);
    const options = root ? unitOptions(root, wide ? null : leadUnits(me, tenant)) : [];
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        {root === null ? (
          <EmptyNote>Unavailable: the organisation could not be read.</EmptyNote>
        ) : options.length === 0 ? (
          <EmptyNote>There is no department you lead in this company.</EmptyNote>
        ) : (
          <Card title="Choose a department">
            <ul className="aiu-units">
              {options.map((o) => (
                <li key={o.value}><Link href={departmentAiUsageHref(o.value, month)}>{o.label}</Link></li>
              ))}
            </ul>
          </Card>
        )}
      </>
    );
  }

  const read = await getUnitAiUsage(userId, tenant, unit, month);
  const heading = read.kind === "ok" && read.data.unit.name ? `${TITLE}: ${read.data.unit.name}` : TITLE;
  const change = <Link href={departmentAiUsageHref(undefined, month)} className="lux-btn lux-btn--ghost lux-btn--sm">Change department</Link>;

  return (
    <>
      <PageHeader eyebrow="Analytics" title={heading} actions={change} />
      <MonthPicker month={month} basePath={DEPARTMENT_AI_USAGE_PATH} params={{ unit }} />
      {read.kind === "ok" ? (
        <AiUsageView
          month={read.data.month}
          totals={read.data.totals}
          bySurface={read.data.bySurface}
          byModel={read.data.byModel}
          byDay={read.data.byDay}
          people={read.data.people}
        />
      ) : read.kind === "forbidden" ? (
        <ReadRefusal subject="this department's AI usage" kind="forbidden" detail={AI_USAGE_FORBIDDEN} />
      ) : read.kind === "not_found" ? (
        <Card title={TITLE}><p className="aiu-state" data-state="not-found">{AI_USAGE_NOT_FOUND}</p></Card>
      ) : (
        <ReadRefusal subject="This department's AI usage" kind="unavailable" reason={read.reason} />
      )}
    </>
  );
}
