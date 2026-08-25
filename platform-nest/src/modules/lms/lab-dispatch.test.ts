// LMS L5b — the platform side of the lab seam.
//
// The assembly rules are the security-relevant part and they are PURE, so they are tested without a
// database: a learner supplies files and nothing else, and a learner file may never displace a
// challenge fixture. Both of those, if wrong, are silent full-marks exploits.
import { describe, it, expect } from "vitest";
import { buildLabRequest, droppedLearnerFiles, clampOutput } from "./lab-dispatch";

const SPEC = {
  image: "node22",
  files: [
    { path: "test.js", content: "// the graded assertions" },
    { path: "run.sh", content: "node test.js" },
  ],
  gradingSpec: { checks: [{ kind: "exitCode", equals: 0 }], passThreshold: 100 },
};

describe("buildLabRequest — what the learner may and may not decide", () => {
  it("takes the image and the grading spec from the CHALLENGE, never from the learner", () => {
    const req = buildLabRequest(SPEC, [{ path: "solution.js", content: "module.exports = 1;" }], "act-1");
    expect(req.image).toBe("node22");
    expect(req.gradingSpec).toEqual(SPEC.gradingSpec);
    expect(req.challengeId).toBe("act-1");
    // A learner who could supply a gradingSpec would pass every lab; one who could supply an image
    // would be naming a container to run on a host carrying other people's production.
  });

  it("a learner file may NOT displace a challenge fixture", () => {
    // THE exploit this prevents: overwrite test.js with `process.exit(0)` and every check passes.
    const req = buildLabRequest(SPEC, [
      { path: "test.js", content: "process.exit(0)" },
      { path: "solution.js", content: "module.exports = 1;" },
    ], "act-1");
    const testFile = req.files.find((f) => f.path === "test.js")!;
    expect(testFile.content).toBe("// the graded assertions");
    // Exactly one test.js — filtered, not merged. Last-write-wins here would be the exploit.
    expect(req.files.filter((f) => f.path === "test.js")).toHaveLength(1);
    expect(req.files.find((f) => f.path === "solution.js")).toBeTruthy();
  });

  it("reports which files it dropped, so a puzzled learner can be told why", () => {
    const dropped = droppedLearnerFiles(SPEC, [
      { path: "test.js", content: "x" },
      { path: "run.sh", content: "y" },
      { path: "mine.js", content: "z" },
    ]);
    // Silently ignoring a file the learner edited is how somebody spends an hour wondering why
    // their change had no effect.
    expect(dropped.sort()).toEqual(["run.sh", "test.js"]);
  });

  it("defaults the image when a challenge omits it, rather than sending an empty key", () => {
    const req = buildLabRequest({ gradingSpec: { checks: [] } }, [{ path: "a.js", content: "" }], "act-2");
    expect(req.image).toBe("node22");
  });

  it("passes an empty fixture list through without inventing files", () => {
    const req = buildLabRequest({ gradingSpec: { checks: [] } }, [{ path: "a.js", content: "1" }], "act-3");
    expect(req.files).toEqual([{ path: "a.js", content: "1" }]);
  });

  it("forwards a Cyber lab's companion target to the runner verbatim", () => {
    // Without this, a lab spec authored with `target` (L6c) would silently never reach the runner —
    // the exact "uncompletable path" this module's whole design exists to avoid, just one hop later.
    const cyberSpec = { ...SPEC, target: { image: "nettools", alias: "target", readySec: 4 } };
    const req = buildLabRequest(cyberSpec, [{ path: "exploit.js", content: "// mine" }], "act-4");
    expect(req.target).toEqual({ image: "nettools", alias: "target", readySec: 4 });
  });

  it("omits target entirely when the challenge does not carry one", () => {
    // Every non-Cyber lab. `target` must not appear as `undefined` in the body sent to the runner —
    // the runner's own parser treats `target !== undefined` as "validate target.image", so a stray
    // key would turn every ordinary lab into a rejected request.
    const req = buildLabRequest(SPEC, [{ path: "solution.js", content: "1" }], "act-5");
    expect("target" in req).toBe(false);
  });
});

describe("clampOutput", () => {
  it("bounds what reaches Postgres, and says that it did", () => {
    // A runaway `yes` in a submission would otherwise put megabytes per attempt into the database
    // that backs the whole ERP.
    const huge = "x".repeat(100_000);
    const out = clampOutput(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("truncated");
  });

  it("leaves ordinary output untouched and turns undefined into an empty string", () => {
    expect(clampOutput("2 passing")).toBe("2 passing");
    expect(clampOutput(undefined)).toBe("");
  });
});
