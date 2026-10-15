import { describe, it, expect } from "vitest";
import { DEFAULT_SHELL_LAYOUT, parseShellLayout, SHELL_LAYOUTS } from "./shellLayout";

describe("parseShellLayout", () => {
  it("defaults to the workspace shell for everyone (DW-9d-1)", () => {
    expect(DEFAULT_SHELL_LAYOUT).toBe("workspaces");
    expect(parseShellLayout(undefined)).toBe("workspaces");
  });

  it("keeps a known layout", () => {
    for (const layout of SHELL_LAYOUTS) expect(parseShellLayout(layout)).toBe(layout);
  });

  it("reads anything else as the default", () => {
    for (const raw of ["", "Workspaces", "new", 1, null, {}, ["workspaces"]]) expect(parseShellLayout(raw)).toBe("workspaces");
  });
});
