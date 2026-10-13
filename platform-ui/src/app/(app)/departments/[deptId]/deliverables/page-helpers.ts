import type { Client, Deliverable, Project } from "@/lib/entities";
import type { ReadResult } from "@/lib/readResult";

// DW-6g — pure parts of the department Deliverables page (contract §33.4), split out of `page.tsx` so they are
// unit-testable without rendering a server component.

export interface DepartmentDeliverableRow {
  id: string;
  name: string;
  projectId: string;
  /** The project's name, or null when the project list could not name it. */
  projectName: string | null;
  /** The PROJECT's client (the list's own rule: the project decides whose a deliverable is), else the deliverable's own. */
  clientId: string | null;
  clientName: string | null;
  status: string;
  dueDate: string | null;
}

export type DepartmentDeliverablesView =
  | { kind: "forbidden" }
  | { kind: "unavailable"; reason: string }
  /** The read succeeded and no deliverable sits on a live project of the department: a real answer. */
  | { kind: "empty" }
  | { kind: "rows"; rows: DepartmentDeliverableRow[] };

/** What the page shows, in the list's own order (the BFF orders by due date, then newest). A failed or refused
 *  DELIVERABLES read is never an empty list. The names come from two more department-scoped reads; when one of
 *  them failed the row still shows, with the name left as unknown (null) rather than guessed. */
export function departmentDeliverablesView(
  deliverables: ReadResult<Deliverable[]>,
  projects: ReadResult<Pick<Project, "id" | "name" | "client_id">[]>,
  clients: ReadResult<Pick<Client, "id" | "name">[]>,
): DepartmentDeliverablesView {
  if (deliverables.kind === "forbidden") return { kind: "forbidden" };
  if (deliverables.kind === "unavailable") return { kind: "unavailable", reason: deliverables.reason };
  if (deliverables.data.length === 0) return { kind: "empty" };
  const project = new Map((projects.kind === "ok" ? projects.data : []).map((p) => [p.id, p] as const));
  const clientName = new Map((clients.kind === "ok" ? clients.data : []).map((c) => [c.id, c.name] as const));
  return {
    kind: "rows",
    rows: deliverables.data.map((d) => {
      const p = project.get(d.project_id);
      const clientId = p?.client_id ?? d.client_id ?? null;
      return {
        id: d.id,
        name: d.name,
        projectId: d.project_id,
        projectName: p?.name ?? null,
        clientId,
        clientName: clientId ? clientName.get(clientId) ?? null : null,
        status: d.status,
        dueDate: d.due_date,
      };
    }),
  };
}
