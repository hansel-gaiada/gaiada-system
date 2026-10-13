import { PageHeader } from "@/components/PageHeader";
import { Button, Card, Eyebrow } from "@/components/ui";
import { MODULE_OFF_TEXT, verticalLabel } from "@/lib/groupReport";
import { loadGroup } from "../loadGroup";
import { GroupNotice } from "../GroupNotice";
import { openCompanyReport } from "./actions";

const MUTED = { margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

// PV1-06b — every company of the root, each with a way into its own Company Report. That report
// reads the ACTIVE company, so the button switches to the company first and then opens the report.
// The group report is fetched (for one day, the cheapest range) rather than reading `me.companies`:
// the BFF is what refuses a non-owner here, and it also says which companies have `reports` on.
export default async function GroupCompanyReportsPage() {
  const load = await loadGroup("day", "/group/reports");
  if (load.kind !== "ok") return <GroupNotice title="Company reports" load={load} />;

  const { report, active } = load;
  return (
    <>
      <PageHeader eyebrow="Group" title="Company reports" />
      <p style={{ ...MUTED, marginBottom: 16, maxWidth: 640 }}>
        Each company&rsquo;s Company Report shows that company only. Opening one switches the active
        company to it; use the company switcher in the top bar to come back to the group.
      </p>
      <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
        {report.companies.map((c) => (
          <Card key={c.companyId} title={c.name} headerRight={<Eyebrow>{verticalLabel(c.vertical)}</Eyebrow>}>
            {c.figures === null ? (
              <p style={MUTED}>{MODULE_OFF_TEXT}</p>
            ) : (
              <form action={openCompanyReport}>
                <input type="hidden" name="tenantId" value={c.companyId} />
                <Button type="submit" variant="ghost">
                  {c.companyId === active.id ? "Open Company Report" : `Switch to ${c.name} and open its report`}
                </Button>
              </form>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
