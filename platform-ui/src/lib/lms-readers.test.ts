import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Guards the ONE failure this file exists for: `platformFetch(path, userId)` had its arguments
// swapped in every reader here when lms.ts was first written. Both parameters are `string`, so tsc
// was blind, the whole suite stayed green, and the LMS pages rendered "nothing published yet"
// against a backend that was never asked. Only driving the rendered page caught it.
//
// These run the readers for real against the DEMO_MODE fixture store, so a wrong path lands on
// demoFixtures' `ok([])` catch-all and the assertions below fail. Asserting CONTENT, never just
// "it resolved" — resolving to an empty list is precisely the bug.
const prev = process.env.DEMO_MODE;
beforeAll(() => { process.env.DEMO_MODE = "1"; });
afterAll(() => { process.env.DEMO_MODE = prev; });

const U = "demo-hansel";
const T = "co-agency";

describe("lib/lms readers reach the right endpoint", () => {
  it("listCourses returns the catalogue and honours the level filter", async () => {
    const { listCourses } = await import("./lms");
    const all = await listCourses(U, T);
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((c) => c.title)).toContain("Using the ERP");

    const lead = await listCourses(U, T, { level: "lead" });
    expect(lead.length).toBeGreaterThan(0);
    expect(lead.every((c) => c.level === "lead")).toBe(true);
    expect(lead.length).toBeLessThan(all.length);
  });

  it("getCourse returns modules and activities, and 404s on an unknown id", async () => {
    const { getCourse } = await import("./lms");
    const course = await getCourse(U, T, "demo-lms-c1");
    expect(course.modules.length).toBeGreaterThan(0);
    expect(course.modules[0].activities.length).toBeGreaterThan(0);
    // Rethrows rather than degrading — an empty course reads exactly like an unreadable one.
    await expect(getCourse(U, T, "no-such-course")).rejects.toThrow();
  });

  it("getPath returns a path's ORDERED courses, and 404s on an unknown id", async () => {
    const { getPath } = await import("./lms");
    const path = await getPath(U, T, "demo-lms-p1");
    expect(path.courses.length).toBeGreaterThan(0);
    expect(path.courses).toEqual(
      [...path.courses].sort((a, b) => a.position - b.position),
    );
    // Rethrows rather than degrading — same reasoning as getCourse (see above).
    await expect(getPath(U, T, "no-such-path")).rejects.toThrow();
  });

  it("listPaths returns paths, including at least one mandatory", async () => {
    const { listPaths } = await import("./lms");
    const paths = await listPaths(U, T);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.isMandatory)).toBe(true);
    const mandatory = await listPaths(U, T, { mandatory: true });
    expect(mandatory.every((p) => p.isMandatory)).toBe(true);
  });

  it("getMyLearning returns enrolments and certifications, not an empty array", async () => {
    const { getMyLearning } = await import("./lms");
    const mine = await getMyLearning(U, T);
    // The swapped-argument bug surfaced HERE first, as `[]` destructured into `undefined` and a
    // TypeError — the only reason it was visible at all is that this reader does not degrade.
    expect(Array.isArray(mine.enrolments)).toBe(true);
    expect(mine.enrolments.length).toBeGreaterThan(0);
    expect(mine.enrolments.some((e) => e.isMandatory && e.overdue)).toBe(true);
    expect(mine.certifications.length).toBeGreaterThan(0);
  });

  it("getCompliance returns per-path rows with waivers counted apart", async () => {
    const { getCompliance } = await import("./lms");
    const rows = await getCompliance(U, T);
    expect(rows.length).toBeGreaterThan(0);
    const required = rows.filter((r) => r.isMandatory);
    expect(required.length).toBeGreaterThan(0);
    // Not fully covered — a demo estate where everything is green cannot exercise the warning path.
    expect(required.some((r) => r.outstanding > 0)).toBe(true);
    expect(rows.some((r) => r.waived > 0)).toBe(true);
  });
});

// DW-4g (BFF §38): the honest unit reader against the demo fixture, which answers in the SERVER's order
// (403 before 404; an unknown unit is 403 for a head, 404 only for a company-wide caller).
describe("getUnitCompliance — the honest unit reader (DW-4g)", () => {
  it("returns the unit's roster size and counts over that roster only, for a company-wide caller", async () => {
    const { getUnitCompliance, getCompliance } = await import("./lms");
    const res = await getUnitCompliance(U, T, "dept-1");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.data.unit).toBe("dept-1");
    expect(res.data.learners).toBe(2);
    const wide = await getCompliance(U, T);
    // The unit counts sit inside the company-wide ones (a roster is a subset), path by path.
    for (const r of res.data.paths) {
      const w = wide.find((x) => x.pathKey === r.pathKey)!;
      expect(r.assigned).toBeLessThanOrEqual(w.assigned);
    }
  });

  it("says 0 learners for a department nobody is placed in, never a missing answer", async () => {
    const { getUnitCompliance } = await import("./lms");
    const res = await getUnitCompliance(U, T, "dept-5");
    expect(res.kind === "ok" && res.data.learners).toBe(0);
  });

  it("a head reads their own unit", async () => {
    const { getUnitCompliance } = await import("./lms");
    const res = await getUnitCompliance("dept-manager", T, "dept-3");
    expect(res.kind).toBe("ok");
  });

  it("forbidden for a head on another unit, for an unknown unit, and for a plain member", async () => {
    const { getUnitCompliance } = await import("./lms");
    expect((await getUnitCompliance("dept-manager", T, "dept-1")).kind).toBe("forbidden");
    expect((await getUnitCompliance("dept-manager", T, "dept-nope")).kind).toBe("forbidden");
    expect((await getUnitCompliance("gede-ic", T, "dept-3")).kind).toBe("forbidden");
  });

  it("not_found only for a company-wide caller asking for a unit that is not in the tree", async () => {
    const { getUnitCompliance } = await import("./lms");
    expect((await getUnitCompliance(U, T, "dept-nope")).kind).toBe("not_found");
  });

  // Against a LIVE-shaped backend (DEMO_MODE off, fetch stubbed): what each status means to the page.
  const live = async (status: number, body: unknown) => {
    const prevMode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const { getUnitCompliance } = await import("./lms");
      return await getUnitCompliance(U, T, "dept-1");
    } finally {
      globalThis.fetch = realFetch;
      process.env.DEMO_MODE = prevMode;
    }
  };

  it("maps the server's typed 404 to not_found and 403 to forbidden", async () => {
    expect((await live(404, { error: "unit_not_found", field: "unit" })).kind).toBe("not_found");
    expect((await live(403, { error: "not authorized" })).kind).toBe("forbidden");
  });

  it("a bare 404 (the lms module is dark) is an error, not 'this department does not exist'", async () => {
    expect((await live(404, { error: "Not Found" })).kind).toBe("error");
  });

  it("a 500 is an error carrying the backend's words, never an empty table", async () => {
    expect(await live(500, { error: "database went away" })).toEqual({ kind: "error", reason: "database went away" });
  });

  it("an old backend that ignores ?unit and answers the company-wide ARRAY is an error, not a table", async () => {
    expect((await live(200, [{ pathKey: "x" }])).kind).toBe("error");
  });
});
