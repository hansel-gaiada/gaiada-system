// DW-2h — where the assistant was opened FROM, as the page and the department the person was in.
//
// Pure and client-safe, like `areas.ts` (which it reads) and `assistantContext.ts` (which carries the
// origin path in the drawer link as `?from=`). The server routes (`app/(app)/assistant/page.tsx` and
// the `@drawer` mount) resolve it once and hand the client plain data: a label for the chip, the
// department's starter prompts and, since AIP-10, the department's id.
//
// What reaches the model (AIP-10): the chip text and the prompts are still for the person alone, but the department's id and
// the page's name go with each message as `context: { departmentId, page }` (`originContext`). They are a hint, not an
// authority: the server reads the department's name from its own org rows, drops a page label that is not a plain label, and
// adds the context to the prompt only for a company whose `ASSISTANT_DEPT_CONTEXT` flag is on (platform-nest
// `assistant/department-context.ts`). The browser sends no preamble and no rule.
import { areaFor } from "@/lib/areas";
import { workspaceBySlug, type Workspace } from "@/lib/workspaces";
import { safeFromPath } from "@/lib/assistantContext";

/** What the client needs to draw the department chip and the department's prompts. */
export interface AssistantOrigin {
  /** The validated origin path: where "Close" on the full page goes back to. */
  path: string;
  /** The workspace label ("Web Dev"), or `null` when the origin page belongs to no department. */
  department: string | null;
  /** AIP-10: the department's org node id (the one the page's `/departments/{id}` area, or the matching workspace ref, carries),
   *  or `null` when the origin has no department (a record page, a department the company does not have) or the
   *  workspace has no org node to take an id from. Sent to the server with each message; never shown. */
  departmentId: string | null;
  /** AIP-14: the resolved workspace's `key` ("web-dev"), the one the roster's `departments` are written in, or `null`
   *  when there is no department. Used to list that department's agents first; never sent to the server. */
  workspaceKey: string | null;
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
  // `root` marks the Overview by position, not by label: the Project Management board used to be called
  // "Overview" (until DW-D21), and the root flag keeps the Overview from claiming the records below it.
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
  if (!ws) return { path, department: null, departmentId: null, workspaceKey: null, page: null, prompts: null };
  return {
    path,
    department: ws.label,
    departmentId: deptId,
    workspaceKey: ws.key,
    page: pageNameOf(ws, deptId, path),
    prompts: ws.assistantPrompts,
  };
}

/** The chip's text: "Web Dev · Board", or just "Web Dev". */
export function originLabel(origin: Pick<AssistantOrigin, "department" | "page">): string | null {
  if (!origin.department) return null;
  return origin.page ? `${origin.department} · ${origin.page}` : origin.department;
}

/** AIP-10: the `context` a message sent from this origin carries, or `null` when the origin has no department (the body is then
 *  exactly what it was before). `page` is the registry's name for the page, which the server accepts only as a plain label. */
export function originContext(origin: Pick<AssistantOrigin, "departmentId" | "page"> | null | undefined): { departmentId: string; page?: string } | null {
  if (!origin?.departmentId) return null;
  return origin.page ? { departmentId: origin.departmentId, page: origin.page } : { departmentId: origin.departmentId };
}
