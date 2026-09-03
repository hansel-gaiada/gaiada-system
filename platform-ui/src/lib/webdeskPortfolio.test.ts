import { describe, it, expect } from "vitest";
import {
  serverOf, flattenSites, groupByServer, sortSites, portfolioStats, targetHint, searchText,
  environmentLabel, isWordPress,
  type PortfolioResult, type PortfolioSite,
} from "./webdeskPortfolio";

function site(over: Partial<PortfolioSite>): PortfolioSite {
  return {
    id: over.id ?? "x", domain: over.domain ?? "example.com", environment: over.environment ?? "production",
    hostKind: over.hostKind ?? "our-box", hostRef: over.hostRef ?? null, access: "none", kind: over.kind ?? null,
    adoption: "tracked", repoUrl: over.repoUrl ?? null, repoBranch: null, contractVersion: null,
    origin: "probe", propertyId: over.propertyId ?? null, hostingProvider: null, controlPanel: null,
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

  it("carries the project/client IDs too, not just their names", () => {
    // A name is not an identity: two clients can both own a project called "Website", and the
    // per-site page groups SIBLING environments on projectId for exactly that reason.
    const data: PortfolioResult = {
      projects: [
        { projectId: "p1", projectName: "Website", clientId: "c1", clientName: "Acme",
          production: null, environments: [site({ domain: "acme.com" })] },
        { projectId: "p2", projectName: "Website", clientId: "c2", clientName: "Globex",
          production: null, environments: [site({ domain: "globex.com" })] },
      ],
      counts: { sites: 2, projects: 2, byAdoption: {}, byEnvironment: {}, withoutConsent: 2 },
    };
    const ids = flattenSites(data).map((s) => s.projectId);
    expect(ids).toEqual(["p1", "p2"]);
  });
});

// ── The helpers each panel used to hold its own copy of (2026-09-03) ───────────────────────────
// `groupByServer`, `environmentLabel` and the search-text builder existed VERBATIM in both
// PortfolioPanel and the deleted OperationsConsole. They live here now, and the cases below are
// what the duplication was hiding: neither copy had a single test.

/** A flat row, shaped as `flattenSites` would produce it. */
function row(over: Partial<PortfolioSite> & { clientName?: string | null; projectName?: string | null }) {
  const { clientName = null, projectName = null, ...rest } = over;
  return { ...site(rest), clientName, projectName, projectId: null, clientId: null };
}

describe("groupByServer — ours first, then by size, then by name", () => {
  it("floats our own boxes above hosting we do not control, whatever their size", () => {
    const groups = groupByServer([
      row({ domain: "a.com", hostRef: "hstgr-shared-gda-staging", hostKind: "shared-hosting" }),
      row({ domain: "b.com", hostRef: "hstgr-shared-gda-staging", hostKind: "shared-hosting" }),
      row({ domain: "c.com", hostRef: "hstgr-shared-gda-staging", hostKind: "shared-hosting" }),
      row({ domain: "d.com", hostRef: "helios" }),
    ]);
    // helios holds ONE site and the shared box holds three — ours still comes first.
    expect(groups.map((g) => g.key)).toEqual(["helios", "hstgr-shared-gda-staging"]);
    expect(groups[1].sites).toHaveLength(3);
  });

  it("orders equal-tier servers by size, so the busy box cannot hide at the bottom", () => {
    const groups = groupByServer([
      row({ domain: "a.com", hostRef: "godaddy", hostKind: "external" }),
      row({ domain: "b.com", hostRef: "hostinger", hostKind: "shared-hosting" }),
      row({ domain: "c.com", hostRef: "hostinger", hostKind: "shared-hosting" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["hostinger", "godaddy"]);
  });
});

describe("environmentLabel", () => {
  it("keeps preview and staging distinct — they mean different things in the schema", () => {
    expect(environmentLabel("staging")).toBe("Staging");
    expect(environmentLabel("preview")).toBe("Preview");
  });
  it("passes an unknown environment through rather than inventing a label", () => {
    expect(environmentLabel("canary")).toBe("canary");
  });
});

describe("targetHint — the only human-readable handle a machine-named host has", () => {
  it("pulls the likely target out of the notes", () => {
    expect(targetHint(site({ notes: "likely target: goldenmonkeybali.com; probed 2026-08-30" })))
      .toBe("goldenmonkeybali.com");
  });
  it("also reads the 'project by repo' form the estate survey wrote", () => {
    expect(targetHint(site({ notes: "project by repo: northwind.example" }))).toBe("northwind.example");
  });
  it("is null when the notes say something else — never a guess from the domain", () => {
    expect(targetHint(site({ notes: "client asked us not to touch this one" }))).toBeNull();
    expect(targetHint(site({ notes: null }))).toBeNull();
  });
});

describe("searchText — what a row can be found by", () => {
  it("includes the server LABEL, not just the host_ref, because people search for 'helios'", () => {
    const t = searchText(row({ domain: "a.com", hostRef: "hstgr-shared-gda-staging", hostKind: "shared-hosting" }));
    expect(t).toContain("shared wp (gda-staging)");
  });
  it("includes the target hint, so a machine-named host is findable by the domain it will become", () => {
    const t = searchText(row({ domain: "gm-com-303701.hostingersite.com", notes: "likely target: goldenmonkeybali.com" }));
    expect(t).toContain("goldenmonkeybali.com");
  });
});

describe("isWordPress — two columns say so, and they disagree in the data", () => {
  it("treats webdev's own 'wp' and the SEO survey's 'wordpress' as the same thing", () => {
    expect(isWordPress(site({ kind: "wp" }))).toBe(true);
    expect(isWordPress(site({ stack: "wordpress" }))).toBe(true);
    expect(isWordPress(site({ kind: "next" }))).toBe(false);
    // BOTH null = not surveyed. That is neither a WordPress site nor a finding that it is not one.
    expect(isWordPress(site({}))).toBe(false);
  });
});

describe("sortSites", () => {
  it("sorts environments by DEPLOYMENT order, not by the label's alphabet", () => {
    const rows = sortSites([
      row({ domain: "d.com", environment: "preview" }),
      row({ domain: "a.com", environment: "development" }),
      row({ domain: "b.com", environment: "production" }),
      row({ domain: "c.com", environment: "staging" }),
    ], "environment", "asc");
    // "Dev" before "Production" is nobody's idea of sorted.
    expect(rows.map((r) => r.environment)).toEqual(["production", "staging", "development", "preview"]);
  });

  it("falls back to the domain on a tie, so a coarse column does not shuffle equal rows", () => {
    const rows = sortSites([
      row({ domain: "zebra.com", environment: "production" }),
      row({ domain: "apple.com", environment: "production" }),
      row({ domain: "mango.com", environment: "production" }),
    ], "environment", "asc");
    expect(rows.map((r) => r.domain)).toEqual(["apple.com", "mango.com", "zebra.com"]);
  });

  it("keeps the tie-break stable when the direction is reversed", () => {
    // Every row here compares equal on the sort axis, so reversing must NOT reverse the tie-break:
    // the list would appear to reorder itself for a reason no column header can explain.
    const input = [
      row({ domain: "zebra.com", environment: "production" }),
      row({ domain: "apple.com", environment: "production" }),
    ];
    expect(sortSites(input, "environment", "desc").map((r) => r.domain)).toEqual(["apple.com", "zebra.com"]);
  });

  it("groups the unsurveyed stacks together instead of scattering them", () => {
    const rows = sortSites([
      row({ domain: "a.com", kind: "next" }),
      row({ domain: "b.com" }),
      row({ domain: "c.com", kind: "wp" }),
      row({ domain: "d.com" }),
    ], "stack", "asc");
    expect(rows.map((r) => r.domain)).toEqual(["b.com", "d.com", "a.com", "c.com"]);
  });

  it("sorts by server with OUR boxes first, not alphabetically by label", () => {
    // The regression this pins: a plain label sort put Delphi above Helios above a client cPanel
    // purely by initial letter, scattering our own infrastructure through hosting we do not
    // control. Sorting on this column replaced the old per-server card grouping, so it has to
    // carry the same ours-first precedence `groupByServer` applies.
    const rows = sortSites([
      row({ domain: "client.com", hostRef: "hostyourservices-syd5", hostKind: "client-cpanel" }),
      row({ domain: "helios-site.com", hostRef: "helios" }),
      row({ domain: "aaa-shared.com", hostRef: "hostinger", hostKind: "shared-hosting" }),
      row({ domain: "delphi-site.com", hostRef: "delphi" }),
    ], "server", "asc");
    expect(rows.map((r) => r.domain)).toEqual([
      "delphi-site.com", "helios-site.com",   // ours, then alphabetical between themselves
      "aaa-shared.com", "client.com",         // everything else, alphabetical by server label
    ]);
  });

  it("does not mutate its input", () => {
    const input = [row({ domain: "b.com" }), row({ domain: "a.com" })];
    sortSites(input, "domain", "asc");
    expect(input.map((r) => r.domain)).toEqual(["b.com", "a.com"]);
  });
});

describe("portfolioStats — the headline figures", () => {
  const data: PortfolioResult = {
    projects: [
      { projectId: "p1", projectName: "Acme web", clientId: "c1", clientName: "Acme", production: null,
        environments: [
          site({ domain: "acme.com", hostRef: "helios", kind: "next" }),
          site({ domain: "staging.acme.com", environment: "staging", hostRef: "delphi", kind: "next" }),
        ] },
      { projectId: null, projectName: null, clientId: null, clientName: null, production: null,
        environments: [
          site({ domain: "wp1.com", hostRef: "hostinger", hostKind: "shared-hosting", stack: "wordpress" }),
          site({ domain: "mystery.com", hostRef: null, hostKind: "unknown" }),
        ] },
    ],
    counts: { sites: 4, projects: 1, byAdoption: {}, byEnvironment: {}, withoutConsent: 4 },
  };

  it("takes sites and withoutConsent from the BACKEND counts, not from a re-count of the rows", () => {
    // The tiles must not be able to disagree with the source they claim to summarise.
    const stats = portfolioStats(data, flattenSites(data));
    expect(stats.sites).toBe(4);
    expect(stats.withoutConsent).toBe(4);
  });

  it("separates what is on OUR boxes from what is hosted elsewhere", () => {
    const stats = portfolioStats(data, flattenSites(data));
    expect(stats.ourServers).toBe(2);   // helios + delphi
    expect(stats.servers).toBe(4);      // helios, delphi, hostinger, ~unknown
  });

  it("counts an unsurveyed stack as unsurveyed, never as 'not WordPress'", () => {
    const stats = portfolioStats(data, flattenSites(data));
    expect(stats.wordpress).toBe(1);
    expect(stats.unsurveyed).toBe(1);   // mystery.com — kind AND stack both null
  });

  it("counts the rows attached to no client and no project", () => {
    const stats = portfolioStats(data, flattenSites(data));
    expect(stats.unattached).toBe(2);
  });
});
