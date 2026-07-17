import "server-only";
// Holding-level aggregation for the Organization overview. There is NO separate
// holding persistence contract — the holding view is COMPUTED from the companies
// list (grouped by parent_company_id / holding type, the same defensive logic
// as companies/page.tsx) plus each company's own org structure. Everything
// degrades gracefully: missing parent links → a flat list under a synthetic
// holding root; an unreachable org structure → zero counts for that company.
import { listCompanies, type Company } from "./entities";
import { getOrgStructure, type OrgNode, type OrgKind } from "./org";

export type CompanyWithParent = Company & { parent_company_id?: string | null };

export interface OrgCounts {
  departments: number;
  divisions: number;
  roles: number;
  people: number;
}
export interface CompanyOrg {
  company: CompanyWithParent;
  counts: OrgCounts;
  updatedAt: string | null;
}
export interface Holding {
  root: { id: string; name: string };
  companies: CompanyOrg[];
  totals: OrgCounts & { companies: number };
}

function looksLikeHolding(c: Company): boolean {
  const t = (c.type ?? "").toLowerCase();
  return t.includes("holding") || t.includes("head");
}

// Count nodes by kind across the whole tree (the root company itself excluded).
function countTree(root: OrgNode): OrgCounts {
  const c: OrgCounts = { departments: 0, divisions: 0, roles: 0, people: 0 };
  const bump = (kind: OrgKind) => {
    if (kind === "department") c.departments += 1;
    else if (kind === "division") c.divisions += 1;
    else if (kind === "role") c.roles += 1;
    else if (kind === "person") c.people += 1;
  };
  const walk = (n: OrgNode) => {
    for (const child of n.children) {
      bump(child.kind);
      walk(child);
    }
  };
  walk(root);
  return c;
}

const zero = (): OrgCounts => ({ departments: 0, divisions: 0, roles: 0, people: 0 });

export async function getHolding(userId: string): Promise<Holding> {
  const companies = (await listCompanies(userId)) as CompanyWithParent[];

  // Determine the holding root: an explicit holding-typed company, else the
  // parent referenced by children, else a synthetic anchor.
  const byId = new Map(companies.map((c) => [c.id, c]));
  const holdingCompany =
    companies.find((c) => looksLikeHolding(c)) ??
    companies.find((c) => c.parent_company_id && byId.has(c.parent_company_id) && byId.get(c.parent_company_id!)) ??
    null;
  const root = holdingCompany
    ? { id: holdingCompany.id, name: holdingCompany.name }
    : { id: "holding", name: "Holding" };

  // Member companies = everything that isn't the holding root.
  const members = companies.filter((c) => c.id !== root.id);

  const withCounts = await Promise.all(
    members.map(async (company): Promise<CompanyOrg> => {
      try {
        const { structure } = await getOrgStructure(userId, company.id, company);
        return { company, counts: countTree(structure.root), updatedAt: structure.updatedAt ?? null };
      } catch {
        return { company, counts: zero(), updatedAt: null };
      }
    }),
  );

  withCounts.sort((a, b) => a.company.name.localeCompare(b.company.name));

  const totals = withCounts.reduce(
    (acc, c) => ({
      companies: acc.companies + 1,
      departments: acc.departments + c.counts.departments,
      divisions: acc.divisions + c.counts.divisions,
      roles: acc.roles + c.counts.roles,
      people: acc.people + c.counts.people,
    }),
    { companies: 0, ...zero() },
  );

  return { root, companies: withCounts, totals };
}
