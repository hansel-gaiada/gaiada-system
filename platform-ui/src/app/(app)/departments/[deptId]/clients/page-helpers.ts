import type { Client, Project } from "@/lib/entities";
import type { ReadResult } from "@/lib/readResult";

// DW-6d — pure parts of the department Clients page (contract §33.4), split out of `page.tsx` so they are
// unit-testable without rendering a server component (a `page.tsx` may export only the default and Next's
// reserved names).

/** How many of the department's projects each client has, from the ONE `listProjects({ departmentId })` read.
 *  A project with no client (an internal one) counts for nobody. */
export function countProjectsByClient(projects: ReadonlyArray<Pick<Project, "client_id">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of projects) {
    if (!p.client_id) continue;
    counts.set(p.client_id, (counts.get(p.client_id) ?? 0) + 1);
  }
  return counts;
}

export interface DepartmentClientRow {
  id: string;
  name: string;
  status: string;
  /** The Client Centre's business type label, or null when it is not known (the profile read failed, or the client has no profile row). */
  businessType: string | null;
  /** The department's projects this client has, or null when the projects read failed (shown as unknown, never as 0). */
  projectCount: number | null;
}

export type DepartmentClientsView =
  | { kind: "forbidden" }
  | { kind: "unavailable"; reason: string }
  /** The read succeeded and no client has a live project in the department: a real answer. */
  | { kind: "empty" }
  | { kind: "rows"; rows: DepartmentClientRow[] };

/** What the page shows. A failed or refused CLIENTS read is never an empty list ("unavailable" says we cannot tell).
 *  A failed projects read only loses the count column: the clients themselves were read, so they are listed, with
 *  an unknown count rather than a zero. `businessTypes` is client id -> label, or null when that read failed. */
export function departmentClientsView(
  clients: ReadResult<Client[]>,
  projects: ReadResult<Pick<Project, "client_id">[]>,
  businessTypes: ReadonlyMap<string, string> | null,
): DepartmentClientsView {
  if (clients.kind === "forbidden") return { kind: "forbidden" };
  if (clients.kind === "unavailable") return { kind: "unavailable", reason: clients.reason };
  if (clients.data.length === 0) return { kind: "empty" };
  const counts = projects.kind === "ok" ? countProjectsByClient(projects.data) : null;
  return {
    kind: "rows",
    rows: clients.data.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      businessType: businessTypes?.get(c.id) ?? null,
      // Zero only when the projects read succeeded; a failed read is "unknown", never 0.
      projectCount: counts ? counts.get(c.id) ?? 0 : null,
    })),
  };
}
