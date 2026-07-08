import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { listCompanies, type Company } from "@/lib/entities";
import { PlatformError } from "@/lib/platform";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";

// Gaiada is a holding structure: one head/holding company with child companies
// (agency, resort, marine, printing, ...) linked via `parent_company_id`.
// GET /api/companies does NOT return `parent_company_id` today, so we read it
// defensively and DEGRADE to a flat alphabetical list when it's absent (the
// case today). Once the backend adds `parent_company_id` to the list payload,
// the grouping below activates automatically — no further UI change needed.
type CompanyWithParent = Company & { parent_company_id?: string | null };

function looksLikeHolding(c: Company): boolean {
  const t = (c.type ?? "").toLowerCase();
  return t.includes("holding") || t.includes("head");
}

function buildGroups(companies: CompanyWithParent[]): { root: CompanyWithParent; children: CompanyWithParent[] }[] | null {
  const hasParentField = companies.some((c) => typeof c.parent_company_id === "string" && c.parent_company_id);
  if (!hasParentField) return null;

  const byId = new Map(companies.map((c) => [c.id, c]));
  const childrenByParent = new Map<string, CompanyWithParent[]>();
  const roots: CompanyWithParent[] = [];

  for (const c of companies) {
    const parentId = c.parent_company_id;
    if (parentId && byId.has(parentId)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(c);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(c);
    }
  }

  roots.sort((a, b) => (looksLikeHolding(b) ? 1 : 0) - (looksLikeHolding(a) ? 1 : 0) || a.name.localeCompare(b.name));

  return roots.map((root) => ({
    root,
    children: (childrenByParent.get(root.id) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function companyRow(c: CompanyWithParent, indent = false) {
  return [
    <Link key={c.id} href={`/companies/${c.id}`} style={indent ? { paddingLeft: 18 } : undefined}>
      {c.name}
    </Link>,
    c.type ?? "—",
    (c.enabled_modules ?? []).join(", ") || "—",
    <StatusBadge key={`${c.id}-status`} label={c.status} />,
  ];
}

const COLUMNS = [{ label: "Name" }, { label: "Type" }, { label: "Modules" }, { label: "Status", align: "right" as const }];
const TCOLS = "2fr 1fr 1.4fr 1fr";

export default async function CompaniesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  let companies: CompanyWithParent[];
  try {
    companies = (await listCompanies(userId)) as CompanyWithParent[];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Companies" subtitle="Gaiada Holding and its companies." />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              You don&apos;t have access to this in the current company.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }
  const groups = buildGroups(companies);

  return (
    <>
      <PageHeader eyebrow="Business" title="Companies" subtitle="Gaiada Holding and its companies." />
      <Card>
        {companies.length === 0 ? (
          <div className="dash-empty">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>No companies yet</div>
            <p>Companies will appear here once they are provisioned on the platform.</p>
          </div>
        ) : groups ? (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={groups.flatMap((g) => [companyRow(g.root), ...g.children.map((child) => companyRow(child, true))])}
          />
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={companies
              .slice()
              .sort((a, b) => (looksLikeHolding(b) ? 1 : 0) - (looksLikeHolding(a) ? 1 : 0) || a.name.localeCompare(b.name))
              .map((c) => companyRow(c))}
          />
        )}
      </Card>
    </>
  );
}
