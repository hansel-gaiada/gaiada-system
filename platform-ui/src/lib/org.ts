import "server-only";
// Org-structure data layer + BFF contract. Each company has a hierarchical org
// structure (company → departments → teams/roles/people). No backend endpoint
// exists yet, so this degrades: it reads the real API when present, else a
// per-company cookie (local saved copy), else a seeded default. Writes PUT the
// real API when present, else persist to the cookie. When the backend lands it
// becomes the source of truth automatically.
//
// BACKEND CONTRACT (implement in platform-nest to match — see memory
// [[org-structure-contract]]):
//   GET  /api/:t/org-structure        -> OrgStructure (200) | 404 if never set
//   PUT  /api/:t/org-structure  body OrgStructure -> { ok: true }
//   Reads: any member of :t. Writes: elevated only (platform_admin/group_executive)
//   — the UI also gates writes, but the backend is the real boundary.
import { cookies } from "next/headers";
import { platformFetch, PlatformError } from "./platform";

export type OrgKind = "company" | "department" | "team" | "role" | "person";
export const ORG_KINDS: OrgKind[] = ["company", "department", "team", "role", "person"];

export interface OrgNode {
  id: string;
  name: string;
  kind: OrgKind;
  assigneeId?: string | null;
  assigneeName?: string | null;
  children: OrgNode[];
}
export interface OrgStructure {
  root: OrgNode;
  updatedAt?: string | null;
}

const MAX_NODES = 300;
const MAX_DEPTH = 8;

// The agency's initial departments (the ask). Seeded for the agency-type
// company; other companies start with just the company root, fully editable.
const AGENCY_DEPARTMENTS = ["Web Dev", "SEO", "SMM", "Video Editor", "Design Graphic"];

export function defaultStructure(company: { id: string; name: string; type: string | null }): OrgStructure {
  const isAgency = company.type === "agency" || company.id === "co-agency";
  const children: OrgNode[] = isAgency
    ? AGENCY_DEPARTMENTS.map((name, i) => ({ id: `dept-${i + 1}`, name, kind: "department" as const, children: [] }))
    : [];
  return { root: { id: "root", name: company.name, kind: "company", children }, updatedAt: null };
}

const cookieName = (t: string) => `gaiada_org_${t}`;

// Coerce arbitrary JSON into a safe OrgStructure: valid kinds, string names,
// array children, bounded node-count and depth (defends against cycles/abuse
// from a tampered cookie or a future loose backend).
export function sanitizeStructure(input: unknown, fallbackName = "Company"): OrgStructure {
  let count = 0;
  function node(raw: unknown, depth: number): OrgNode {
    const r = (raw ?? {}) as Record<string, unknown>;
    count += 1;
    const kind = ORG_KINDS.includes(r.kind as OrgKind) ? (r.kind as OrgKind) : "role";
    const rawChildren = Array.isArray(r.children) ? r.children : [];
    const children: OrgNode[] = [];
    if (depth < MAX_DEPTH) {
      for (const c of rawChildren) {
        if (count >= MAX_NODES) break;
        children.push(node(c, depth + 1));
      }
    }
    return {
      id: typeof r.id === "string" && r.id ? r.id : `n-${count}`,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : "Untitled",
      kind,
      assigneeId: typeof r.assigneeId === "string" ? r.assigneeId : null,
      assigneeName: typeof r.assigneeName === "string" ? r.assigneeName : null,
      children,
    };
  }
  const obj = (input ?? {}) as Record<string, unknown>;
  const rootRaw = (obj.root ?? obj) as Record<string, unknown>;
  const root = node(rootRaw, 0);
  root.kind = "company";
  if (root.name === "Untitled") root.name = fallbackName;
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : null;
  return { root, updatedAt };
}

export type OrgSource = "backend" | "local" | "default";

export async function getOrgStructure(
  u: string,
  t: string,
  company: { id: string; name: string; type: string | null },
): Promise<{ structure: OrgStructure; source: OrgSource }> {
  // 1) Backend is the source of truth when it exists.
  try {
    const res = await platformFetch<OrgStructure>(`/api/${t}/org-structure`, u);
    if (res && (res as OrgStructure).root) return { structure: sanitizeStructure(res, company.name), source: "backend" };
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 405))) throw e;
  }
  // 2) Local per-company cookie (pre-backend saved copy).
  const raw = (await cookies()).get(cookieName(t))?.value;
  if (raw) {
    try {
      return { structure: sanitizeStructure(JSON.parse(raw), company.name), source: "local" };
    } catch {
      /* fall through to default */
    }
  }
  // 3) Seeded default.
  return { structure: defaultStructure(company), source: "default" };
}

// Writes the real API when present, else the cookie. MUST be called from a
// server action / route handler (it sets a cookie). Returns where it landed.
export async function persistOrgStructure(u: string, t: string, structure: OrgStructure): Promise<"backend" | "local"> {
  const body = JSON.stringify(structure);
  try {
    await platformFetch(`/api/${t}/org-structure`, u, { method: "PUT", body });
    return "backend";
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 405))) throw e;
  }
  // Cookie ceiling is ~4KB — guard so an oversized org fails loudly, not silently.
  if (body.length > 3900) throw new PlatformError(413, "Org structure too large to save locally (backend pending).");
  (await cookies()).set(cookieName(t), body, {
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });
  return "local";
}
