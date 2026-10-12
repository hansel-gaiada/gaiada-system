// PV3-05 — pure helpers for the client hub's Projects area (`/clients/[id]/work`). No I/O and no
// `server-only`, so the page stays a straight render and the grouping rules are unit-testable.
import type { PipelineGate } from "./pipeline";
import type { ClientBallItem } from "./clientHub";

/** The heading for work that names no project. Single source so the page and the tests agree. */
export const NO_PROJECT_LABEL = "Not tied to a project";

export interface ProjectGroup<T> {
  /** `null` for the "Not tied to a project" group. */
  projectId: string | null;
  projectName: string;
  rows: T[];
}

/**
 * Group rows under their project: named projects first (alphabetical, stable within a project), the
 * "Not tied to a project" group last. A row with no project is a FINDING (a request nobody filed
 * against anything), so it is grouped and shown, never dropped. Returns `[]` only for no rows.
 */
export function groupByProject<T>(
  rows: T[],
  pick: (row: T) => { id: string | null | undefined; name: string | null | undefined },
): ProjectGroup<T>[] {
  const byId = new Map<string, ProjectGroup<T>>();
  const loose: T[] = [];
  for (const row of rows) {
    const { id, name } = pick(row);
    if (!id) {
      loose.push(row);
      continue;
    }
    const g = byId.get(id);
    if (g) g.rows.push(row);
    else byId.set(id, { projectId: id, projectName: name || "Unnamed project", rows: [row] });
  }
  const groups = [...byId.values()].sort((a, b) => a.projectName.localeCompare(b.projectName, "en"));
  if (loose.length > 0) groups.push({ projectId: null, projectName: NO_PROJECT_LABEL, rows: loose });
  return groups;
}

/**
 * The client-side gates of one run, or `null` when the platform answered without gates (a platform
 * older than 0.46.0: `PipelineRunWithGates.gates === null`). `null` must render as "open the run to
 * see its approvals", never as "no approvals" — an absent array is not an empty one.
 */
export function clientGatesOf(gates: PipelineGate[] | null): PipelineGate[] | null {
  if (gates === null) return null;
  return gates.filter((g) => g.actor_side === "client");
}

export interface PostReviewItem extends ClientBallItem {
  /** Whose court it is in: our own follow-up, or still waiting on the client. */
  side: "us" | "client";
}

/**
 * Post reviews for this client, from the hub aggregate the layout already fetches
 * (`GET /clients/:id/overview`: `needsUs` carries reviews the client sent back for changes,
 * `needsClient` carries reviews still awaiting their approval).
 *
 * ⚠ These are OUTSTANDING reviews only. There is no staff endpoint that lists every post review of
 * a client (approved ones included), so the page says so rather than letting a short list read as a
 * complete one. A client-filtered list is a backend follow-up (BFF §22b).
 */
export function postReviewItems(overview: { needsUs: ClientBallItem[]; needsClient: ClientBallItem[] }): PostReviewItem[] {
  return [
    ...overview.needsUs.filter((i) => i.kind === "review").map((i) => ({ ...i, side: "us" as const })),
    ...overview.needsClient.filter((i) => i.kind === "review").map((i) => ({ ...i, side: "client" as const })),
  ];
}
