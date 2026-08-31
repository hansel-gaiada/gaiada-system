// WSK-D6, the runtime half: this file proves `runGuarded`/`runGuardedSync` refuse everything except
// `git`, including the exact things §06 calls out by name (`npm install`) and an arbitrary attempt to
// run generated code directly through `node`.
import { describe, it, expect, beforeEach } from "vitest";
import { runGuarded, runGuardedSync, ExecGuardViolation, resetExecLog, getExecLog } from "./no-execute-guard";

describe("no-execute-guard", () => {
  beforeEach(() => resetExecLog());

  it("refuses npm install", async () => {
    await expect(runGuarded("npm", ["install"])).rejects.toBeInstanceOf(ExecGuardViolation);
  });

  it("refuses npm ci, npx, yarn, pnpm — every install-adjacent binary", async () => {
    for (const bin of ["npm", "npx", "yarn", "pnpm"]) {
      await expect(runGuarded(bin, ["install"])).rejects.toBeInstanceOf(ExecGuardViolation);
    }
  });

  it("refuses executing generated code directly via node", async () => {
    await expect(runGuarded("node", ["src/lib/webdesk-sdk.ts"])).rejects.toBeInstanceOf(ExecGuardViolation);
  });

  it("refuses an absolute or .exe-suffixed disguise of a forbidden binary", async () => {
    await expect(runGuarded("/usr/bin/npm", ["install"])).rejects.toBeInstanceOf(ExecGuardViolation);
    await expect(runGuarded("npm.exe", ["install"])).rejects.toBeInstanceOf(ExecGuardViolation);
  });

  it("a refused call is never logged as having run", async () => {
    await expect(runGuarded("npm", ["install"])).rejects.toBeInstanceOf(ExecGuardViolation);
    expect(getExecLog()).toEqual([]);
  });

  it("allows git and logs it (sync + async)", () => {
    expect(() => runGuardedSync("git", ["--version"])).not.toThrow();
    expect(getExecLog()).toEqual(["git --version"]);
  });

  it("the violation message names WSK-D6 and the offending command", async () => {
    try {
      await runGuarded("npm", ["install"]);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/WSK-D6/);
      expect((err as Error).message).toContain("npm");
    }
  });
});
