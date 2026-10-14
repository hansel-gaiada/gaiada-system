// DW-6c2: "Open in" (docs/plans/2026-10-13-department-workspaces.md §4.2 6c2, §14.1 "Launch and return").
//
// One pure function turns a workspace's tools into the links an "Open in" menu shows. A tool gets a CONTEXT link
// only where an exact identifier exists (a linked repository, a task key, a Search Console property). Every
// other tool opens its home `url`, marked `contextual: false` so the reader can tell. No vendor query parameter
// is ever invented: a tool is listed in CONTEXT_BUILDERS only when its deep link is a documented, exact form.
//
// THE SEAM for later tickets is `CONTEXT_BUILDERS`: one function per tool key. DW-6k added `figma`, DW-6i adds
// `drive`; nothing else in this file or in the menu changes.
//
// Pure and client-safe: no I/O, no server-only imports.
import type { DeptLauncher } from "@/lib/deptToolkits";
import { safeFigmaHref } from "@/lib/figma";

/** A linked repository. `fullName` is GitHub's `owner/name`. */
export interface RepoRef {
  fullName: string;
}

/**
 * A client's search property, as far as the row carries it. `kind` says what `domain` / `siteUrl` mean:
 * a "domain" property is Search Console's `sc-domain:<domain>`, a "url-prefix" property is its `siteUrl`.
 * The search module's row has NO such field today (`SearchProperty` carries `domain` and a nullable `siteUrl`
 * only), so callers that read that row leave `kind` unset and Search Console opens its home. Never guess it.
 */
export interface SearchPropertyRef {
  domain: string;
  siteUrl?: string | null;
  kind?: "domain" | "url-prefix";
}

export interface ToolContext {
  repos?: readonly RepoRef[];
  /** The task's key (`ABC-12`), on a task page only. */
  taskKey?: string | null;
  searchProperties?: readonly SearchPropertyRef[];
  /** The task's Figma links (DW-6k), on a task page only. Absent or empty: Figma opens its home. */
  figmaLinks?: readonly FigmaLinkRef[];
}

/** A Figma link as far as the menu needs it: the stored `url` and the cached `title` (null until Figma was read). */
export interface FigmaLinkRef {
  url: string;
  title: string | null;
}

export interface ToolLink {
  /** The tool's registry key. Several entries can share one (one per repository). */
  key: string;
  label: string;
  href: string;
  /** True when `href` goes to the thing this page is about. False: the tool's home. */
  contextual: boolean;
  /** What a contextual link opens ("gaiada/web-site pull requests for WEB-12"). Absent on a home link. */
  detail?: string;
}

type Builder = (tool: DeptLauncher, ctx: ToolContext) => ToolLink[];

const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The repositories whose name is a real `owner/name`, once each, in the order given. */
function validRepos(ctx: ToolContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of ctx.repos ?? []) {
    const name = r?.fullName;
    if (typeof name !== "string" || !REPO_FULL_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const home = (tool: DeptLauncher): ToolLink => ({ key: tool.key, label: tool.label, href: tool.url, contextual: false });

const github: Builder = (tool, ctx) => {
  const repos = validRepos(ctx);
  if (repos.length === 0) return [home(tool)];
  const key = ctx.taskKey?.trim();
  return repos.map((fullName) =>
    key
      ? {
          key: tool.key,
          label: tool.label,
          href: `https://github.com/${fullName}/pulls?q=${encodeURIComponent(key)}`,
          contextual: true,
          detail: `${fullName} pull requests for ${key}`,
        }
      : { key: tool.key, label: tool.label, href: `https://github.com/${fullName}`, contextual: true, detail: fullName },
  );
};

const vscode: Builder = (tool, ctx) => {
  const repos = validRepos(ctx);
  if (repos.length === 0) return [home(tool)];
  return repos.map((fullName) => ({
    key: tool.key,
    label: tool.label,
    href: `vscode://vscode.git/clone?url=${encodeURIComponent(`https://github.com/${fullName}.git`)}`,
    contextual: true,
    detail: `clone ${fullName}`,
  }));
};

const SEARCH_CONSOLE = "https://search.google.com/search-console";

/** The property's own identifier, or null when the row does not say which kind it is (or lacks the value). */
function searchResource(p: SearchPropertyRef): string | null {
  if (p.kind === "domain") {
    const d = p.domain?.trim();
    return d ? `sc-domain:${d}` : null;
  }
  if (p.kind === "url-prefix") {
    const u = p.siteUrl?.trim();
    return u ? u : null;
  }
  return null;
}

const searchConsole: Builder = (tool, ctx) => {
  const seen = new Set<string>();
  const out: ToolLink[] = [];
  for (const p of ctx.searchProperties ?? []) {
    const resource = searchResource(p);
    if (!resource || seen.has(resource)) continue;
    seen.add(resource);
    out.push({
      key: tool.key,
      label: tool.label,
      href: `${SEARCH_CONSOLE}?resource_id=${encodeURIComponent(resource)}`,
      contextual: true,
      detail: p.kind === "domain" ? p.domain.trim() : resource,
    });
  }
  return out.length > 0 ? out : [home(tool)];
};

/** Figma opens each file or frame linked to the task, by the link's own stored `url` (BFF §36.2: normalised to
 *  `https://www.figma.com/<kind>/<key>` plus `?node-id=` for a frame, so the link opens at the frame). Only a real https
 *  figma.com address is used; a task with no usable link opens Figma's home. The detail is the link's title. */
const figma: Builder = (tool, ctx) => {
  const seen = new Set<string>();
  const out: ToolLink[] = [];
  for (const l of ctx.figmaLinks ?? []) {
    const href = typeof l?.url === "string" ? safeFigmaHref(l.url) : null;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ key: tool.key, label: tool.label, href, contextual: true, detail: l.title?.trim() || "linked Figma file" });
  }
  return out.length > 0 ? out : [home(tool)];
};

/** Tool key -> its context builder. A tool not listed here opens its home `url`. DW-6i: `drive`. */
const CONTEXT_BUILDERS: Readonly<Record<string, Builder>> = {
  github,
  vscode,
  gsc: searchConsole,
  figma,
};

/** The menu's entries, in the registry's order. A tool with several contexts (several repositories) expands in place. */
export function toolContextLinks(tools: readonly DeptLauncher[], ctx: ToolContext = {}): ToolLink[] {
  return tools.flatMap((tool) => {
    const build = CONTEXT_BUILDERS[tool.key];
    return build ? build(tool, ctx) : [home(tool)];
  });
}

/** The accessible name of an entry: what it opens, and that a home link is only the tool's home page. */
export function toolLinkName(link: ToolLink): string {
  return link.contextual && link.detail ? `${link.label}, ${link.detail}` : `${link.label}, home page`;
}
