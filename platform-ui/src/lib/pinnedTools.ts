// DW-6c: the tools a person pins to the Overview's Today card (plan §4.1, §4.2). Pure and client-safe.
//
// Pins live in the `gaiada_prefs` cookie (`lib/prefs.ts`), so they belong to the browser, not the
// account. They are keyed by workspace key, then a list of tool keys. A workspace with NO entry shows
// the first six of its tools (the default); an entry, even an empty one, is the person's own choice.
// The cookie is writable by the browser, so `parsePinnedTools` treats it as untrusted.
import type { Workspace } from "./workspaces";
import type { DeptLauncher } from "./deptToolkits";

export const MAX_PINNED_TOOLS = 6;
const MAX_KEY_LENGTH = 64;
const MAX_WORKSPACES = 20;

const isKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_KEY_LENGTH;
// `JSON.parse` makes "__proto__" an OWN key, and assigning it onto `out` would hit the prototype setter.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Anything malformed reads as `{}`. Lists are deduplicated and capped at six; a key or tool key longer
 *  than 64 characters (or not a string) is dropped; at most 20 workspaces are kept. */
export function parsePinnedTools(raw: unknown): Record<string, string[]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  let n = 0;
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_WORKSPACES) break;
    if (!isKey(key) || UNSAFE_KEYS.has(key) || !Array.isArray(list)) continue;
    const tools: string[] = [];
    for (const t of list) {
      if (tools.length >= MAX_PINNED_TOOLS) break;
      if (isKey(t) && !tools.includes(t)) tools.push(t);
    }
    out[key] = tools;
    n++;
  }
  return out;
}

/** The workspace's pinned tools, in REGISTRY order. No entry for the workspace: its first six tools.
 *  An entry (even `[]`): the tools it names. Unknown keys are ignored. */
export function pinnedToolsFor(pins: Record<string, string[]>, ws: Pick<Workspace, "key" | "tools">): DeptLauncher[] {
  const own = Object.prototype.hasOwnProperty.call(pins, ws.key) ? pins[ws.key] : undefined;
  if (own === undefined) return ws.tools.slice(0, MAX_PINNED_TOOLS);
  const wanted = new Set(own);
  return ws.tools.filter((t) => wanted.has(t.key)).slice(0, MAX_PINNED_TOOLS);
}
