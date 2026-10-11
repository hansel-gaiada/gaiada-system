import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DONE_PROJECT_STATUSES, FINISHED_PROJECT_STATUSES, PROJECT_STATUSES, isProjectStatus, unknownProjectStatusError,
} from "./project-status";

// PV2-09 parity: ONE set of project statuses in three places that cannot import each other. A status
// added to the form but not the CHECK fails every save with a 400; one added to the CHECK but not the
// constant would count as active in every "finished" reader. This reads the other two as text.
const MIGRATION = path.resolve(__dirname, "../../migrations/202610110151_projects_status_check.sql");
const FORM = path.resolve(__dirname, "../../../platform-ui/src/components/forms/ProjectForm.tsx");

const quoted = (s: string) => [...s.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);

describe("project status parity (PV2-09)", () => {
  it("the migration's CHECK is exactly PROJECT_STATUSES", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const check = sql.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i);
    expect(check, "CHECK (status IN (...)) not found in the migration").not.toBeNull();
    expect(quoted(check![1])).toEqual([...PROJECT_STATUSES]);
  });

  it("the staff form offers exactly PROJECT_STATUSES, in the same order", () => {
    const form = readFileSync(FORM, "utf8");
    const line = form.match(/const STATUS_OPTIONS\s*=\s*\[([^\]]*)\]/);
    expect(line, "STATUS_OPTIONS not found in ProjectForm.tsx").not.toBeNull();
    expect(quoted(line![1])).toEqual([...PROJECT_STATUSES]);
  });

  it("finished and done are subsets: done ⊆ finished ⊆ all", () => {
    for (const s of FINISHED_PROJECT_STATUSES) expect(PROJECT_STATUSES).toContain(s);
    for (const s of DONE_PROJECT_STATUSES) expect(FINISHED_PROJECT_STATUSES).toContain(s);
    // Active means not finished: these two must never be finished.
    expect(FINISHED_PROJECT_STATUSES).not.toContain("active");
    expect(FINISHED_PROJECT_STATUSES).not.toContain("on_hold");
  });

  it("isProjectStatus accepts the set and nothing else; the 400 names the set", () => {
    for (const s of PROJECT_STATUSES) expect(isProjectStatus(s)).toBe(true);
    for (const bad of ["done", "complete", "finished", "Active", "", null, undefined, 3]) expect(isProjectStatus(bad)).toBe(false);
    expect(unknownProjectStatusError()).toEqual({
      message: "unknown project status; use one of: planned, active, on_hold, completed, cancelled, archived",
      field: "status",
    });
  });
});
