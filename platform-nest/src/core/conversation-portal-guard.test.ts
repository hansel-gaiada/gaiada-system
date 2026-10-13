// PV4-03 — static guards for the portal side of client Conversation. No DB, no Cerbos: these run on every
// machine and every CI shard.
//
//   1. DRAFTS NEVER REACH THE PORTAL (design decision 3). Drafts are staff-only BY TABLE; the guarantee is
//      that no portal code path ever names `conversation_drafts`. The scanned set is DISCOVERED: every
//      production file that imports the portal scope resolver (the definition of "portal-facing" used by
//      portal-visibility.test.ts) plus every file the conversation portal controller imports from this
//      directory, so a helper the portal controller grows next month is covered without anyone remembering.
//   2. PV-D24: the conversation portal controller never calls `requireSigner` (viewers post).
//   3. Every portal conversation route authorizes `portal`, and writes authorize `converse`.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const NEST_ROOT = join(__dirname, "..", "..");
const SRC = join(NEST_ROOT, "src");
const CORE = join(SRC, "core");
const PORTAL_CONTROLLER = join(CORE, "portal-conversation.controller.ts");
const rel = (abs: string) => relative(NEST_ROOT, abs).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Comment lines are prose (a file may EXPLAIN that it never reads drafts); code and SQL are scanned. */
function codeOnly(src: string): string {
  return src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
}

const DRAFTS = /conversation_drafts/;

function importsPortalScope(src: string): boolean {
  return /from\s*["'][^"']*\/portal-scope["']/.test(src) && /\b(resolvePortalScope|callerClientIds|requireSigner)\b/.test(src);
}

/** Relative `./x` imports of a file, resolved to core files. */
function localImports(abs: string): string[] {
  const src = readFileSync(abs, "utf8");
  return [...src.matchAll(/from\s*["']\.\/([^"']+)["']/g)].map((m) => join(CORE, `${m[1]}.ts`));
}

describe("PV4-03 guard — no portal code path reads conversation_drafts", () => {
  const portalFacing = walk(SRC).filter((f) => importsPortalScope(readFileSync(f, "utf8")));
  const scanned = [...new Set([...portalFacing, ...localImports(PORTAL_CONTROLLER)])].filter((f) => {
    try { return statSync(f).isFile(); } catch { return false; }
  });

  it("the scan is not vacuous: it covers the conversation portal controller, its shared core, and portal-commerce", () => {
    const names = scanned.map(rel);
    expect(names).toContain("src/core/portal-conversation.controller.ts");
    expect(names).toContain("src/core/conversation-core.ts");
    expect(names).toContain("src/core/portal-commerce.controller.ts");
    expect(names).toContain("src/core/portal-visibility.ts");
  });

  it("the detector is live: the STAFF controller does name the drafts table", () => {
    expect(codeOnly(readFileSync(join(CORE, "conversation.controller.ts"), "utf8"))).toMatch(DRAFTS);
    // ...and the staff controller is not portal-facing (it must never import the portal scope resolver).
    expect(scanned.map(rel)).not.toContain("src/core/conversation.controller.ts");
  });

  it("no portal-facing file, and nothing the conversation portal controller imports, names conversation_drafts", () => {
    const offenders = scanned.filter((f) => DRAFTS.test(codeOnly(readFileSync(f, "utf8")))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("PV4-03 guard — the conversation portal controller (PV-D24, authz shape)", () => {
  const src = codeOnly(readFileSync(PORTAL_CONTROLLER, "utf8"));

  it("never calls requireSigner: viewers post", () => {
    expect(src).not.toMatch(/requireSigner/);
  });

  it("authorizes only the `portal` kind, `read` for GETs and `converse` for every write", () => {
    const kinds = [...src.matchAll(/authorize\(req\.principal,\s*\{\s*kind:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    // list, start, detail, reply (PV-D34 removed the edit and retract routes)
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(kinds)).toEqual(new Set(["portal"]));
    const actions = [...src.matchAll(/kind:\s*"portal",\s*tenantId\s*\},\s*"([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(new Set(actions)).toEqual(new Set(["read", "converse"]));
    expect(actions.filter((a) => a === "converse").length).toBe(2);
  });

  it("every thread / message admission goes through conversationThreadInPortalScope", () => {
    const fromConversationTables = (src.match(/FROM conversation_(threads|messages)/g) ?? []).length;
    const predicateUses = (src.match(/conversationThreadInPortalScope\(/g) ?? []).length;
    // One predicate use per query over the conversation tables (list, detail, owned thread).
    expect(fromConversationTables).toBeGreaterThan(0);
    expect(predicateUses).toBeGreaterThanOrEqual(fromConversationTables);
  });
});
