// DW-7d (owner ruling DW-D6): HR, Finance and IT are real departments in EACH company's org tree.
//
// The UI finds a department's workspace by the node's NAME slug ("HR" -> "hr"), so a department node
// with one of these names is what makes the HR / Finance / IT workspace real for that company. This
// file is the pure rule (no DB): which nodes to add, and what a conflict is. Every write still goes
// through `applyOrgStructure` (org-structure.service.ts) from the callers.
//
// ⚠ NODE IDS ARE UNIQUE PER COMPANY. An `org_unit_lead` grant is (role, 'org_unit', node id) with no
// tenant, and the Cerbos derived role matches the node id against `unitAncestors` without a tenant
// check. A shared `d-hr` in every company would let the head of one company's HR lead another's.
// The org builder mints random ids, so only seed-made ids can collide: ours embed the tenant id.
// The full uuid, not its first 8 hex chars: tenant ids are UUIDv7, whose leading chars are a
// timestamp and collide for companies created together (same reason as `upsertPersonNode`'s `p-<id>`).
//
// Additive only: nothing is renamed, moved or removed, and no person is placed.
import type { OrgNode, OrgStructure } from "./org-structure.service";
import { deptSlug } from "../modules/reports/dept-kpis";

export const FUNCTIONAL_DEPARTMENTS: readonly { readonly slug: string; readonly name: string }[] = [
  { slug: "hr", name: "HR" },
  { slug: "finance", name: "Finance" },
  { slug: "it", name: "IT" },
];

/** This company's node id for a functional department. */
export function functionalNodeId(slug: string, tenantId: string): string {
  return `d-${slug}-${tenantId}`;
}

/** The plain id older seeds and tests used (`d-hr`, `d-it`); shared across companies, never minted now. */
export function legacyFunctionalNodeId(slug: string): string {
  return `d-${slug}`;
}

/** The least a node needs for this rule. Seeds wrote trees without `assigneeId`/`assigneeName`, so the
 *  rule has to work on a raw stored blob as well as on a sanitized one. */
interface LooseNode { id: string; name: string; kind: string; children?: LooseNode[] }
interface LooseStructure { root: LooseNode }

export interface EnsureResult<T> {
  structure: T;
  /** Node ids appended by this call. */
  added: string[];
  /** Every `kind: "department"` node that was in the tree before this call (the additions are not listed). */
  existing: { id: string; name: string }[];
  conflicts: { id: string; reason: string }[];
}

function walk(node: LooseNode, fn: (n: LooseNode) => void): void {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

const isDepartmentFor = (n: LooseNode, slug: string): boolean =>
  n.kind === "department" && deptSlug(n.name) === slug;

/** Appends the functional departments this company's tree is missing, at the end of the root's
 *  children. Never mutates its input. A slug is present when the company's own id is in the tree, when
 *  a legacy plain-id department with that name is, or when ANY department's name slugs the same. A node
 *  holding one of those ids without being that department is a conflict: nothing is added for the
 *  slug and nothing is overwritten. */
export function ensureFunctionalDepartments<T extends LooseStructure = OrgStructure>(
  structure: T,
  tenantId: string,
): EnsureResult<T> {
  const next = JSON.parse(JSON.stringify(structure)) as T;
  const byId = new Map<string, LooseNode>();
  const departments: { id: string; name: string }[] = [];
  walk(next.root, (n) => {
    if (!byId.has(n.id)) byId.set(n.id, n);
    if (n.kind === "department") departments.push({ id: n.id, name: n.name });
  });
  const existing = departments.map((d) => ({ ...d }));

  const added: string[] = [];
  const conflicts: { id: string; reason: string }[] = [];
  for (const f of FUNCTIONAL_DEPARTMENTS) {
    const id = functionalNodeId(f.slug, tenantId);
    let held = false;
    for (const candidate of [id, legacyFunctionalNodeId(f.slug)]) {
      const holder = byId.get(candidate);
      if (!holder) continue;
      held = true;
      if (!isDepartmentFor(holder, f.slug)) {
        conflicts.push({
          id: candidate,
          reason: `node "${candidate}" is ${holder.kind} "${holder.name}", not the ${f.name} department`,
        });
      }
    }
    if (held) continue;
    if (departments.some((d) => deptSlug(d.name) === f.slug)) continue; // already there under another id
    (next.root.children ??= []).push({ id, name: f.name, kind: "department", children: [] });
    added.push(id);
  }
  return { structure: next, added, existing, conflicts };
}

/** The id of the node that IS this company's `slug` department: its own id, else a matching legacy
 *  plain-id department, else the first department whose name slugs the same; null when there is none. */
export function resolveFunctionalNodeId(structure: LooseStructure, slug: string, tenantId: string): string | null {
  const byId = new Map<string, LooseNode>();
  const departments: LooseNode[] = [];
  walk(structure.root, (n) => {
    if (!byId.has(n.id)) byId.set(n.id, n);
    if (n.kind === "department") departments.push(n);
  });
  for (const candidate of [functionalNodeId(slug, tenantId), legacyFunctionalNodeId(slug)]) {
    const holder = byId.get(candidate);
    if (holder && isDepartmentFor(holder, slug)) return holder.id;
  }
  return departments.find((d) => deptSlug(d.name) === slug)?.id ?? null;
}

/** What a brand-new company starts with: its root plus the three functional departments, in the shape
 *  `sanitizeStructure` returns. */
export function startingOrgStructure(companyName: string, tenantId: string): OrgStructure {
  const node = (id: string, name: string, kind: string, children: OrgNode[]): OrgNode => ({
    id, name, kind, assigneeId: null, assigneeName: null, children,
  });
  return {
    root: node(
      "root",
      companyName.trim().slice(0, 80) || "Company",
      "company",
      FUNCTIONAL_DEPARTMENTS.map((f) => node(functionalNodeId(f.slug, tenantId), f.name, "department", [])),
    ),
  };
}
