import { describe, it, expect } from "vitest";
import {
  isUnknownVersion,
  mismatchedServices,
  parseAppVersion,
  tagForVersion,
  type AboutInfo,
} from "./about";

const info = (version: string, services: AboutInfo["services"]): AboutInfo => ({
  app: { version, originSite: "main", node: "v22.0.0", modules: ["pm"] },
  services,
});

describe("parseAppVersion", () => {
  it("splits the documented format into its five parts", () => {
    expect(parseAppVersion("Alpha 01.004.0005a")).toEqual({
      stage: "Alpha",
      milestone: "01",
      release: "004",
      moduleRef: "0005",
      revision: "a",
    });
  });

  it("returns null for 'unknown' rather than coercing it into a shape", () => {
    expect(parseAppVersion("unknown")).toBeNull();
  });

  it("rejects near-misses instead of half-parsing them", () => {
    // Missing revision letter, and a semver-shaped string — both must fail closed, since a
    // half-parsed version would render confident nonsense in the header.
    expect(parseAppVersion("Alpha 01.004.0005")).toBeNull();
    expect(parseAppVersion("0.6.3")).toBeNull();
  });
});

describe("tagForVersion", () => {
  it("derives the git tag exactly as VERSIONING.md rule 4 specifies", () => {
    expect(tagForVersion("Alpha 01.004.0005a")).toBe("alpha-01.004.0005a");
  });

  it("gives no tag for an unparseable version instead of fabricating one", () => {
    expect(tagForVersion("unknown")).toBeNull();
  });
});

describe("isUnknownVersion", () => {
  it("treats empty and 'unknown' as unstated", () => {
    expect(isUnknownVersion("")).toBe(true);
    expect(isUnknownVersion("  Unknown ")).toBe(true);
    expect(isUnknownVersion("Alpha 01.004.0005a")).toBe(false);
  });
});

describe("mismatchedServices", () => {
  it("flags a service running a different version", () => {
    const out = mismatchedServices(
      info("Alpha 01.004.0005a", [
        { key: "hub", reachable: true, version: "Alpha 01.004.0005a", note: null },
        { key: "gateway", reachable: true, version: "Alpha 01.003.0002a", note: null },
      ]),
    );
    expect(out.map((s) => s.key)).toEqual(["gateway"]);
  });

  it("does not flag a service that reports no version at all", () => {
    // "Reachable but silent" is a gap in that service's /health, not a deploy skew — flagging it
    // would cry wolf on every service that hasn't adopted the field yet.
    expect(
      mismatchedServices(
        info("Alpha 01.004.0005a", [{ key: "bot", reachable: true, version: null, note: "no version" }]),
      ),
    ).toEqual([]);
  });

  it("flags nothing when the platform itself cannot state a version", () => {
    // With no baseline there is nothing to compare against; every row would otherwise look wrong.
    expect(
      mismatchedServices(
        info("unknown", [{ key: "hub", reachable: true, version: "Alpha 01.004.0005a", note: null }]),
      ),
    ).toEqual([]);
  });
});
