// WSK-49c — the drift check on the vendored WebDesk vocabulary (`src/modules/webdev/vocabulary/*.ts`).
//
// The ERP's D59/D62 pre-check applies WebDesk's ONE rule (`isClientEditable`) before a client write leaves the
// ERP. platform-nest must not import across the package boundary, so the rule's source files are copied by
// `scripts/vendor-webdesk-vocabulary.mjs` and this test fails the build when copy and source disagree: on the
// real files, on a changed source, on a hand-edited copy and on a missing copy. Pure file work: no DB, no network.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const NEST = resolve(__dirname, "../../..");
const SCRIPT = join(NEST, "scripts", "vendor-webdesk-vocabulary.mjs");
const SOURCE = resolve(NEST, "..", "webdesk", "delivery", "vocabulary");
const VENDORED = join(NEST, "src", "modules", "webdev", "vocabulary");
const FILES = ["version.ts", "primitives.ts", "blocks.ts", "composition.ts", "client-editable.ts"];

const run = (env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SCRIPT, "--check"], { env: { ...process.env, ...env }, encoding: "utf8", cwd: NEST });

const tmpDirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "w49c-vendor-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("WSK-49c · the vendored WebDesk vocabulary cannot drift from its source", () => {
  it("the source tree is present (a missing source would make every check below vacuous)", () => {
    expect(existsSync(SOURCE), `${SOURCE} must exist: the drift check needs the webdesk package beside platform-nest`).toBe(true);
    for (const f of FILES) expect(existsSync(join(SOURCE, f)), `${f} in the source`).toBe(true);
  });

  it("the committed copies match the source (npm run vendor:check passes)", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("every vendored file matches");
  });

  it("every vendored file carries the DO-NOT-EDIT banner and differs from its source only by the banner and the dropped `.ts` import suffix", () => {
    for (const f of FILES) {
      const copy = readFileSync(join(VENDORED, f), "utf8").replace(/\r\n/g, "\n");
      const src = readFileSync(join(SOURCE, f), "utf8").replace(/\r\n/g, "\n");
      expect(copy.startsWith(`// VENDORED from webdesk/delivery/vocabulary/${f} by platform-nest/scripts/vendor-webdesk-vocabulary.mjs`)).toBe(true);
      const body = copy.slice(copy.indexOf("\n\n") + 2);
      // Re-adding the suffix the script drops must reproduce the source byte for byte.
      const restored = body.replace(/(\bfrom\s+)(['"])(\.{1,2}\/[^'"\n]+)\2/g, "$1$2$3.ts$2");
      expect(restored, `${f}`).toBe(src);
    }
  });

  it("FAILS when the source changes (a new line in client-editable.ts, the file that holds the rule)", () => {
    const src = tmp();
    cpSync(SOURCE, src, { recursive: true });
    const f = join(src, "client-editable.ts");
    writeFileSync(f, readFileSync(f, "utf8") + "\n// a change nobody re-vendored\n");
    const r = run({ WEBDESK_VOCAB_SRC: src });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DRIFT");
    expect(r.stderr).toContain("client-editable.ts");
    // the other four still agree: the failure names only the drifted file
    expect(r.stderr).not.toContain("version.ts");
  });

  it("FAILS when the rule itself is changed in the source (isClientEditable's seo guard is flipped)", () => {
    const src = tmp();
    cpSync(SOURCE, src, { recursive: true });
    const f = join(src, "client-editable.ts");
    const text = readFileSync(f, "utf8");
    expect(text).toContain("if (root === 'seo') return false");
    writeFileSync(f, text.replace("if (root === 'seo') return false", "if (root === 'seo') return true"));
    expect(run({ WEBDESK_VOCAB_SRC: src }).status).toBe(1);
  });

  it("FAILS when a vendored copy is hand-edited", () => {
    const dest = tmp();
    cpSync(VENDORED, dest, { recursive: true });
    const f = join(dest, "client-editable.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace("return false", "return true"));
    const r = run({ WEBDESK_VOCAB_DEST: dest });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DRIFT");
  });

  it("FAILS when a vendored copy is missing", () => {
    const dest = tmp();
    cpSync(VENDORED, dest, { recursive: true });
    rmSync(join(dest, "composition.ts"));
    const r = run({ WEBDESK_VOCAB_DEST: dest });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("composition.ts");
  });

  it("FAILS when a source file disappears (the vocabulary was restructured)", () => {
    const src = tmp();
    cpSync(SOURCE, src, { recursive: true });
    rmSync(join(src, "primitives.ts"));
    const r = run({ WEBDESK_VOCAB_SRC: src });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MISSING");
  });

  it("regenerating into an empty directory reproduces the committed copies exactly (the generator is the only writer)", () => {
    const dest = tmp();
    mkdirSync(dest, { recursive: true });
    execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, WEBDESK_VOCAB_DEST: dest }, cwd: NEST });
    expect(readdirSync(dest).sort()).toEqual([...FILES].sort());
    for (const f of FILES) {
      expect(readFileSync(join(dest, f), "utf8").replace(/\r\n/g, "\n")).toBe(readFileSync(join(VENDORED, f), "utf8").replace(/\r\n/g, "\n"));
    }
  });
});
