// DW-2h — where the assistant was opened FROM, as the page and the department the person was in.
//
// Pure and client-safe, like `areas.ts` (which it reads) and `assistantContext.ts` (which carries the
// origin path in the drawer link as `?from=`). The server routes (`app/(app)/assistant/page.tsx` and
// the `@drawer` mount) resolve it once and hand the client plain data: a label for the chip and the
// department's starter prompts. Nothing here reaches the model: the chip and the prompts are for the person.
import { areaFor } from "@/lib/areas";
import { workspaceBySlug, type Workspace } from "@/lib/workspaces";
import { safeFromPath } from "@/lib/assistantContext";

/** What the client needs to draw the department chip and the department's prompts. */
export interface AssistantOrigin {
  /** The validated origin path: where "Close" on the full page goes back to. */
  path: string;
  /** The workspace label ("Web Dev"), or `null` when the origin page belongs to no department. */
  department: string | null;
  /** The page's own name within that workspace ("Board"), when the registry has one for the path. */
  page: string | null;
  /** The department's starter prompts; `null` leaves today's generic suggestions. */
  prompts: readonly { label: string; prompt: string }[] | null;
}

/** A department of the active company with the workspace it resolves to (`MyWorkspaces.all`'s shape). */
export interface OriginWorkspaceRef { workspace: Workspace; deptId: string | null }

function clean(path: string): string {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/** The registry tab (or the Overview) the path is on: the longest href that is the path or a parent of
 *  it, so a record page under /board still reads "Board". */
function pageNameOf(ws: Workspace, deptId: string | null, path: string): string | null {
  const here = clean(path);
  // `root` marks the Overview by position, not by label: the Project Management board is also called
  // "Overview" (PM_TERMS.board), and it must still claim the records below it.
  const candidates: { href: string; label: string; root?: boolean }[] = [{ href: ws.overviewHref, label: "Overview", root: true }];
  for (const row of ws.work) for (const t of row.tabs) candidates.push({ href: t.href, label: t.label });
  for (const t of [...ws.reports, ...ws.analytics]) candidates.push({ href: t.href, label: t.label });
  let best: { len: number; label: string } | null = null;
  for (const c of candidates) {
    if (c.href.includes("{company}")) continue;
    let href = c.href;
    if (href.includes("{dept}")) {
      if (!deptId) continue;
      href = href.replaceAll("{dept}", deptId);
    }
    href = clean(href);
    // The Overview is the department root: only an exact match, or every department page would read "Overview".
    const hit = c.root ? here === href : here === href || here.startsWith(`${href}/`);
    if (hit && (!best || href.length > best.len)) best = { len: href.length, label: c.label };
  }
  return best?.label ?? null;
}

/** The origin for a `?from=` path. `refs` are the active company's departments (`myWorkspaces(...).all`),
 *  which is where a `deptId` area gets its name: the same label the sidebar shows. Returns `null` when
 *  there is no usable path, and an origin with no department when the page belongs to none (a record,
 *  the Company area, the person's own pages). */
export function resolveAssistantOrigin(from: string | null | undefined, refs: readonly OriginWorkspaceRef[]): AssistantOrigin | null {
  const path = safeFromPath(from);
  if (!path) return null;
  const area = areaFor(path);
  let ws: Workspace | undefined;
  let deptId: string | null = null;
  if (area.kind === "workspace") {
    if (area.deptId) {
      const ref = refs.find((r) => r.deptId === area.deptId);
      ws = ref?.workspace;
      deptId = area.deptId;
    } else if (area.slug) {
      ws = refs.find((r) => r.workspace.key === area.slug)?.workspace ?? workspaceBySlug(area.slug);
      deptId = refs.find((r) => r.workspace.key === area.slug)?.deptId ?? null;
    }
  }
  if (!ws) return { path, department: null, page: null, prompts: null };
  return {
    path,
    department: ws.label,
    page: pageNameOf(ws, deptId, path),
    prompts: ws.assistantPrompts,
  };
}

/** The chip's text: "Web Dev · Board", or just "Web Dev". */
export function originLabel(origin: Pick<AssistantOrigin, "department" | "page">): string | null {
  if (!origin.department) return null;
  return origin.page ? `${origin.department} · ${origin.page}` : origin.department;
}
