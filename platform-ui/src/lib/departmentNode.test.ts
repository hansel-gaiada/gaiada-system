import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-9d perf: `getDepartmentNode` is the department console layout's light read: identity only, from the org structure, no task or status reads.
vi.mock("./org", () => ({ getOrgStructure: vi.fn() }));
vi.mock("./pm", async () => ({
  ...(await vi.importActual<typeof import("./pm")>("./pm")),
  listAllPmTasks: vi.fn(), statusesForTasks: vi.fn(),
}));

import { getOrgStructure } from "./org";
import { listAllPmTasks, statusesForTasks } from "./pm";
import { getDepartmentNode } from "./departments";

const node = (id: string, name: string, kind: string) => ({ id, name, kind, children: [] });

beforeEach(() => {
  vi.mocked(getOrgStructure).mockReset().mockResolvedValue({
    structure: { root: { id: "root", name: "Agency", kind: "company", children: [node("d-web", "Web Dev", "department"), node("dv-1", "Frontend", "division")] } },
    source: "backend",
  } as never);
  vi.mocked(listAllPmTasks).mockClear();
  vi.mocked(statusesForTasks).mockClear();
});

describe("getDepartmentNode", () => {
  it("returns a department's id and name without reading any task or status", async () => {
    expect(await getDepartmentNode("u-1", "co-a", "d-web")).toEqual({ id: "d-web", name: "Web Dev" });
    expect(listAllPmTasks).not.toHaveBeenCalled();
    expect(statusesForTasks).not.toHaveBeenCalled();
  });

  it("is null for an id that is not a department of the company (a division, or nothing), which the layout turns into a 404", async () => {
    expect(await getDepartmentNode("u-1", "co-a", "dv-1")).toBeNull();
    expect(await getDepartmentNode("u-1", "co-a", "nope")).toBeNull();
  });

  it("is null when the org tree cannot be read, as getDepartment is", async () => {
    vi.mocked(getOrgStructure).mockRejectedValue(new Error("down"));
    expect(await getDepartmentNode("u-1", "co-a", "d-web")).toBeNull();
  });
});
