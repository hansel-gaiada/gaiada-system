import { describe, it, expect } from "vitest";
import { serverOf, flattenSites, type PortfolioResult, type PortfolioSite } from "./webdeskPortfolio";

function site(over: Partial<PortfolioSite>): PortfolioSite {
  return {
    id: over.id ?? "x", domain: over.domain ?? "example.com", environment: over.environment ?? "production",
    hostKind: over.hostKind ?? "our-box", hostRef: over.hostRef ?? null, access: "none", kind: over.kind ?? null,
    adoption: "tracked", repoUrl: over.repoUrl ?? null, repoBranch: null, contractVersion: null,
    origin: "probe", lastSeenAt: null, lastHttpStatus: null, hostingProvider: null, controlPanel: null,
    stack: over.stack ?? null, topologyCheckedAt: null, crawlConsent: false, notes: over.notes ?? null,
  };
}

describe("serverOf — the server grouping key/label, from host_ref", () => {
  it("maps a known host_ref to its clean label, not the schema slug", () => {
    // The whole point: 'shared-hosting' host_kind covers four different boxes; host_ref is what
    // distinguishes them, so the label must come from the ref.
    expect(serverOf(site({ hostRef: "hstgr-shared-gda-staging", hostKind: "shared-hosting" })))
      .toEqual({ key: "hstgr-shared-gda-staging", label: "Shared WP (GDA-Staging)", kind: "Hostinger shared" });
    expect(serverOf(site({ hostRef: "helios" })).label).toBe("Helios");
  });

  it("gives a site with no host_ref one honest bucket rather than scattering", () => {
    const a = serverOf(site({ hostRef: null }));
    const b = serverOf(site({ hostRef: null, domain: "other.com" }));
    expect(a.key).toBe("~unknown");
    expect(a.key).toBe(b.key); // same bucket, not one per domain
  });

  it("falls back to the raw ref (tidied) for an unknown host, never a schema value", () => {
    const r = serverOf(site({ hostRef: "68.178.238.45", hostKind: "external" }));
    expect(r.key).toBe("68.178.238.45");
    expect(r.label).toBe("68.178.238.45");
  });
});

describe("flattenSites — carries client/project down onto each site", () => {
  it("attaches the group's clientName/projectName to every environment row", () => {
    const data: PortfolioResult = {
      projects: [
        { projectId: "p1", projectName: "Acme web", clientId: "c1", clientName: "Acme",
          production: null, environments: [site({ domain: "acme.com" }), site({ domain: "staging.acme.com", environment: "staging" })] },
        { projectId: null, projectName: null, clientId: null, clientName: null,
          production: null, environments: [site({ domain: "orphan.com" })] },
      ],
      counts: { sites: 3, projects: 2, byAdoption: {}, byEnvironment: {}, withoutConsent: 3 },
    };
    const flat = flattenSites(data);
    expect(flat).toHaveLength(3);
    expect(flat.find((s) => s.domain === "acme.com")?.clientName).toBe("Acme");
    expect(flat.find((s) => s.domain === "staging.acme.com")?.projectName).toBe("Acme web");
    // an unowned site keeps null — not inherited from another group
    expect(flat.find((s) => s.domain === "orphan.com")?.clientName).toBeNull();
  });
});
