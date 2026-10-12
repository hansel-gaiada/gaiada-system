// M6-P3d — PARITY: the TypeScript renderer and the infra generator must not drift.
// The generator (infra/observability/scripts/gen-client-property-targets.mjs) is the specification;
// this runs the same fixtures through both and compares the output byte for byte.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROBEABLE_SQL, isProbeableUrl, renderTargetsFile, toFileSd, type PropertyRow } from "./client-targets";

const GEN = path.resolve(__dirname, "../../../../infra/observability/scripts/gen-client-property-targets.mjs");

const FIXTURES: PropertyRow[] = [
  { domain: "a.example.com", site_url: "https://a.example.com", tenant_id: "t1", client_id: "c1" },
  { domain: "b.example.com", site_url: "https://b.example.com/", tenant_id: "t1", client_id: "c2", is_internal: true, hosting_provider: "hp", control_panel: "cp", stack: "wp" },
  { domain: "c.example.com", site_url: "http://c.example.com:8080/x", tenant_id: "t2", client_id: "c3", is_internal: false },
  { domain: "n.example.com", site_url: "https://n.example.com", tenant_id: "t2", client_id: "c3", is_internal: null, hosting_provider: null, stack: "" },
  { domain: "meta", site_url: "http://169.254.169.254/latest/meta-data", tenant_id: "t", client_id: "c" },
  { domain: "rfc", site_url: "http://10.0.0.5", tenant_id: "t", client_id: "c" },
  { domain: "rfc2", site_url: "http://172.20.1.1", tenant_id: "t", client_id: "c" },
  { domain: "rfc3", site_url: "http://192.168.0.9", tenant_id: "t", client_id: "c" },
  { domain: "lh", site_url: "http://localhost:8080", tenant_id: "t", client_id: "c" },
  { domain: "lb", site_url: "http://127.0.0.1", tenant_id: "t", client_id: "c" },
  { domain: "v6", site_url: "http://[::1]/", tenant_id: "t", client_id: "c" },
  { domain: "v6u", site_url: "http://[fd00::1]/", tenant_id: "t", client_id: "c" },
  { domain: "int", site_url: "https://svc.internal", tenant_id: "t", client_id: "c" },
  { domain: "loc", site_url: "https://nas.local", tenant_id: "t", client_id: "c" },
  { domain: "file", site_url: "file:///etc/passwd", tenant_id: "t", client_id: "c" },
  { domain: "ftp", site_url: "ftp://x.example.com", tenant_id: "t", client_id: "c" },
  { domain: "bad", site_url: "not a url", tenant_id: "t", client_id: "c" },
];

describe.skipIf(!existsSync(GEN))("MON-01 parity: platform-nest renderer vs infra generator", () => {
  it("same targets, same skipped reasons, same bytes", async () => {
    const gen = (await import(pathToFileURL(GEN).href)) as {
      isProbeableUrl: (u: string) => { ok: boolean; reason?: string };
      toFileSd: (rows: unknown[]) => { targets: unknown[]; skipped: unknown[] };
      PROBEABLE_WITH_INTERNAL_SQL: string;
    };
    const mine = toFileSd(FIXTURES);
    const theirs = gen.toFileSd(FIXTURES);
    expect(mine.targets).toEqual(theirs.targets);
    expect(mine.skipped).toEqual(theirs.skipped);
    expect(renderTargetsFile(mine.targets)).toBe(JSON.stringify(theirs.targets, null, 2) + "\n");
    // At least some fixtures must be accepted AND refused, or the comparison proves nothing.
    expect(mine.targets.length).toBeGreaterThan(2);
    expect(mine.skipped.length).toBeGreaterThan(8);
  });

  it("every fixture URL gets the same verdict", async () => {
    const gen = await import(pathToFileURL(GEN).href);
    for (const f of FIXTURES) expect(isProbeableUrl(f.site_url)).toEqual(gen.isProbeableUrl(f.site_url));
  });

  it("the selection predicate is the same (whitespace-normalised, ORDER BY aside)", async () => {
    const gen = await import(pathToFileURL(GEN).href);
    const norm = (s: string) => s.replace(/\s+/g, " ").replace(/ ORDER BY p\.domain/, "").trim();
    expect(norm(PROBEABLE_SQL)).toBe(norm(gen.PROBEABLE_WITH_INTERNAL_SQL));
  });
});
