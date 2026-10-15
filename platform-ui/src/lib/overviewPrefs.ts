// DW-10d: what a person has hidden from, and switched on in, their own Overview (owner ruling DW-D34, 2026-10-15; plan §3, §11.4).
// Pure and client-safe: no server import, so the frame, the Customise control and the tests share one set of rules.
//
// The choice lives in the `gaiada_prefs` cookie (`lib/prefs.ts`), per workspace, like pinned tools (`lib/pinnedTools.ts`), so it
// belongs to the browser and does not follow the person to another one. The cookie is writable by the browser, so
// `parseOverviewPrefs` treats it as untrusted and every rule below holds whatever it says.
//
// The rules, in one place:
//  - A `fixed` widget (Needs you, a head's condition banner, the company's decisions) is always kept, whatever the prefs say.
//  - A `default` widget is kept unless it is in `hide`.
//  - An `optional` widget is kept only when it is in `show`.
//  - The ORDER is always the registry's. The prefs are sets, never lists to follow: reversing them changes nothing.
//  - A key the registry does not know is ignored at use time (a widget that was renamed or removed).
// None of this is a security boundary and none of it widens a gate: it runs BEFORE the gates and the placement rules, so a
// switched-on block still needs its gate, and a hidden one is never drawn, so its reads never run.
import { COMPANY_OVERVIEW, GENERIC_WORKSPACE, workspaceBySlug, type OverviewWidget } from "./workspaces";

export interface WorkspaceOverviewPrefs {
  /** Default widgets the person hid. */
  hide: string[];
  /** Optional widgets the person switched on. */
  show: string[];
}

/** Per workspace key (`overviewPrefsKey`). No entry = no choice made = today's Overview. */
export type OverviewPrefs = Record<string, WorkspaceOverviewPrefs>;

export const MAX_OVERVIEW_WORKSPACES = 20;
export const MAX_OVERVIEW_KEYS = 24;
const MAX_KEY_LENGTH = 64;
/** Workspace and widget keys are registry slugs. A key with anything else in it was not written by the app. */
const SLUG = /^[a-z0-9-]+$/;
// `JSON.parse` makes "__proto__" an OWN key, and assigning it onto `out` would hit the prototype setter. (These contain
// underscores, so the slug test already refuses `__proto__`; `constructor` and `prototype` are listed for the reader.)
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_KEY_LENGTH && SLUG.test(v) && !UNSAFE_KEYS.has(v);

function parseKeyList(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const k of raw) {
    if (out.length >= MAX_OVERVIEW_KEYS) break;
    if (isKey(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Anything malformed reads as `{}`. At most 20 workspaces; per workspace each list is de-duplicated, capped at 24 keys, and
 *  keeps only keys of 1 to 64 characters in `[a-z0-9-]`. A workspace left with nothing to say is dropped. */
export function parseOverviewPrefs(raw: unknown): OverviewPrefs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: OverviewPrefs = {};
  let n = 0;
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_OVERVIEW_WORKSPACES) break;
    if (!isKey(key) || entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const hide = parseKeyList((entry as Record<string, unknown>).hide);
    const show = parseKeyList((entry as Record<string, unknown>).show);
    if (hide.length === 0 && show.length === 0) continue;
    out[key] = { hide, show };
    n++;
  }
  return out;
}

/** The workspace's entry; an own-property read, so a key such as `constructor` can never reach Object.prototype. */
export function overviewPrefsFor(prefs: OverviewPrefs, workspaceKey: string): WorkspaceOverviewPrefs {
  return Object.prototype.hasOwnProperty.call(prefs, workspaceKey) ? prefs[workspaceKey] : { hide: [], show: [] };
}

/** The widgets to place for this person, in the registry's order. `fixed` always stays; `default` stays unless hidden;
 *  `optional` stays only when switched on. Gates and placement rules come after this, never instead of it. */
export function effectiveWidgets(widgets: readonly OverviewWidget[], prefs: Partial<WorkspaceOverviewPrefs> | undefined): OverviewWidget[] {
  const hide = new Set(prefs?.hide ?? []);
  const show = new Set(prefs?.show ?? []);
  return widgets.filter((w) => {
    switch (w.placement ?? "default") {
      case "fixed": return true;
      case "optional": return show.has(w.key);
      default: return !hide.has(w.key);
    }
  });
}

/** True when the person's prefs would show this widget (the control's "Shown" / "Switched on"). */
export function widgetIsOn(w: OverviewWidget, prefs: Partial<WorkspaceOverviewPrefs> | undefined): boolean {
  return effectiveWidgets([w], prefs).length === 1;
}

// ── Which workspace a choice belongs to ──────────────────────────────────────────────────────────────

/** The company Overview's key. The Company frame at `/` and the Office of the GM workspace draw the same widget list
 *  (`COMPANY_OVERVIEW`), so one choice covers both. No department workspace has this slug. */
export const COMPANY_PREFS_KEY = "company";

/** The key a subject's choices are stored under: its workspace key, or "company" for the company list. */
export function overviewPrefsKey(subject: { workspaceKey: string | null; widgets: readonly OverviewWidget[] }): string {
  return subject.workspaceKey === null || subject.widgets === COMPANY_OVERVIEW ? COMPANY_PREFS_KEY : subject.workspaceKey;
}

/** The overview list a stored key stands for, or null for a key that is no workspace's. The server action uses this, so the
 *  browser can never name a widget of another workspace. The Office of the GM shares the company list and is stored under
 *  "company", so its own slug is not accepted here. */
export function overviewWidgetsForKey(workspaceKey: string): readonly OverviewWidget[] | null {
  if (typeof workspaceKey !== "string") return null;
  if (workspaceKey === COMPANY_PREFS_KEY) return COMPANY_OVERVIEW;
  const ws = workspaceKey === GENERIC_WORKSPACE.key ? GENERIC_WORKSPACE : workspaceBySlug(workspaceKey);
  if (!ws || ws.overview === COMPANY_OVERVIEW) return null;
  return ws.overview;
}
