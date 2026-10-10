import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Structural guards for the Website workspace — the failure classes this estate has paid for:
//   • a green tsc + vitest while `next build` breaks because a `server-only` module reached a client
//     component (vitest aliases `server-only` to an empty module, so it CANNOT see this — read the source);
//   • a stub or fixture reachable from a shipped path;
//   • a refusal turned into `[]` through the shared absent-as-empty helpers.
// Source-level on purpose: these hold even where a unit test cannot run the real bundler.

const SRC = resolve(__dirname, "..");
const read = (p: string) => readFileSync(p, "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const isTest = (p: string) => /\.test\.(ts|tsx)$/.test(p);

const CONTENT_DIR = join(SRC, "components/webdesk/content");
const PAGES_DIR = join(SRC, "app/(app)/departments/[deptId]/website");
const OWNED = [...walk(CONTENT_DIR), ...walk(PAGES_DIR), join(SRC, "lib/webdeskContent.ts"), join(SRC, "lib/webdeskContentActions.ts"), join(SRC, "lib/webdeskContentModel.ts")].filter((p) => !isTest(p));
const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");
const importsOf = (src: string) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const isClient = (src: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src);

describe("server/client boundary (what `next build` enforces and vitest cannot see)", () => {
  it("lib/webdeskContent.ts is server-only; the Model is client-safe; the Actions file is 'use server'", () => {
    expect(read(join(SRC, "lib/webdeskContent.ts"))).toMatch(/^import "server-only";/);
    const model = read(join(SRC, "lib/webdeskContentModel.ts"));
    expect(model).not.toMatch(/^\s*["']use server["']/);
    for (const spec of importsOf(model)) expect(spec, "the Model must stay client-safe").not.toMatch(/server-only|platform|session-server/);
    expect(read(join(SRC, "lib/webdeskContentActions.ts"))).toMatch(/^"use server";/);
  });

  it("'use server' exports only async functions (and erased types)", () => {
    const src = read(join(SRC, "lib/webdeskContentActions.ts"));
    for (const m of src.matchAll(/^export\s+(?!async function|interface|type)(\w+)/gm)) {
      throw new Error(`non-async export in a "use server" file: ${m[0]}`);
    }
    expect(src).toMatch(/^export async function /m);
  });

  it("no client component imports a server-only module, a value from lib/webdeskContent, or the platform egress", () => {
    const FORBIDDEN = [/^server-only$/, /^@\/lib\/webdeskContent$/, /^@\/lib\/platform$/, /^@\/lib\/departments$/, /^@\/lib\/entities$/, /^@\/lib\/session-server$/, /^\.\.?\/serverCtx$/];
    const clients = OWNED.filter((p) => isClient(read(p)));
    expect(clients.length).toBeGreaterThan(5); // the guard must actually be looking at something
    for (const p of clients) {
      for (const spec of importsOf(read(p))) {
        expect(FORBIDDEN.some((re) => re.test(spec)), `${rel(p)} imports ${spec} but is a client component`).toBe(false);
      }
    }
  });

  it("client components that import the Actions file import only from the 'use server' module", () => {
    for (const p of OWNED.filter((f) => isClient(read(f)))) {
      for (const spec of importsOf(read(p))) {
        if (spec.includes("webdeskContent") && !/webdeskContent(Actions|Model)$/.test(spec)) throw new Error(`${rel(p)} → ${spec}`);
      }
    }
  });
});

describe("the stub never reaches a shipped path", () => {
  it("nothing under src/ except tests imports from e2e/ or webdesk-stub", () => {
    for (const p of walk(SRC).filter((f) => !isTest(f))) {
      const src = read(p);
      expect(src.includes("webdesk-stub"), rel(p)).toBe(false);
      expect(/from\s+["'][^"']*\/e2e\//.test(src), rel(p)).toBe(false);
    }
  });
});

describe("no path turns a refusal into []", () => {
  it("the Website workspace never uses the absent-as-empty helpers or a catch that returns an empty list", () => {
    for (const p of OWNED) {
      const src = read(p);
      expect(src, rel(p)).not.toMatch(/absentAsEmpty\s*:/);
      expect(src, rel(p)).not.toMatch(/\breadResult\s*\(/);
      expect(src, rel(p)).not.toMatch(/from ["']@?[./]*\/?(?:lib\/)?readResult["']/);
      expect(src, rel(p)).not.toMatch(/catch\s*(?:\([^)]*\))?\s*\{\s*return\s*\[\]\s*;?\s*\}/);
      expect(src, rel(p)).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\[\]\s*\)/);
    }
  });

  it("every page under /website returns the refusal renderer BEFORE it can draw data", () => {
    for (const p of walk(PAGES_DIR).filter((f) => /[\\/]page\.tsx$/.test(f))) {
      const src = read(p);
      if (!/from "@\/lib\/webdeskContent"/.test(src)) continue; // redirect-only pages
      expect(src, rel(p)).toMatch(/kind !== "ok"\) return <WdRefusal/);
    }
  });
});
