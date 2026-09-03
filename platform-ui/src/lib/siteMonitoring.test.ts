import { describe, it, expect } from "vitest";
import {
  hostOf, monitorDomain, indexMonitorsByDomain, siteMonitoring, monitorClientFor,
  createMonitorHref, coverageStats,
  type PropertyRef, type MonitoringFeed, type SiteMonitoring,
} from "./siteMonitoring";
import type { Monitor } from "./monitoringShared";
import type { FlatSite, PortfolioSite } from "./webdeskPortfolio";

function site(over: Partial<FlatSite>): FlatSite {
  const base: PortfolioSite = {
    id: over.id ?? "s1", domain: over.domain ?? "example.com", environment: "production",
    hostKind: "our-box", hostRef: null, access: "none", kind: null, adoption: "tracked",
    repoUrl: null, repoBranch: null, contractVersion: null, origin: "probe",
    propertyId: over.propertyId ?? null,
    hostingProvider: null, controlPanel: null, stack: null, topologyCheckedAt: null,
    crawlConsent: over.crawlConsent ?? false, notes: null,
  };
  return {
    ...base,
    clientName: over.clientName ?? null, projectName: over.projectName ?? null,
    projectId: over.projectId ?? null, clientId: over.clientId ?? null,
  };
}

function monitor(over: Partial<Monitor>): Monitor {
  return {
    id: over.id ?? "m1", name: over.name ?? "a monitor", kind: over.kind ?? "http",
    status: over.status ?? "up", clientId: over.clientId ?? "cl-1",
    propertyId: over.propertyId, target: over.target ?? null,
    severity: "ticket", enabled: over.enabled ?? true, intervalSec: 60,
    lastCheckedAt: over.lastCheckedAt ?? null, uptime24h: over.uptime24h,
  };
}

const AVAILABLE = (monitors: Monitor[], properties: PropertyRef[] = []): MonitoringFeed =>
  ({ available: true, monitors, properties });

function resolve(s: FlatSite, feed: MonitoringFeed): SiteMonitoring {
  const index = feed.available ? indexMonitorsByDomain(feed.monitors, feed.properties) : new Map();
  return siteMonitoring(s, feed, index);
}

describe("hostOf — the same host written five ways is one host", () => {
  it("strips scheme, port, path, query and a leading www.", () => {
    expect(hostOf("https://www.example.com:443/health?x=1")).toBe("example.com");
    expect(hostOf("example.com")).toBe("example.com");
    expect(hostOf("blossomsteakhouse.com:443")).toBe("blossomsteakhouse.com");
    expect(hostOf("HTTP://Example.COM/")).toBe("example.com");
    // A trailing root dot is legal DNS and must not create a second host.
    expect(hostOf("example.com.")).toBe("example.com");
  });

  it("strips credentials rather than treating them as part of the host", () => {
    expect(hostOf("https://user:pw@example.com/path")).toBe("example.com");
  });

  it("is null for nothing, not an empty string", () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf("   ")).toBeNull();
  });
});

describe("monitorDomain", () => {
  const props: PropertyRef[] = [{ id: "p1", domain: "www.acme.com", clientId: "cl-9" }];
  const byProperty = new Map(props.map((p) => [p.id, p]));

  it("prefers the propertyId — an identity, not a parsed display string", () => {
    // The target says something else on purpose: the property is the authority.
    const m = monitor({ propertyId: "p1", target: "https://staging.acme.com/health" });
    expect(monitorDomain(m, byProperty)).toBe("acme.com");
  });

  it("falls back to the target when the propertyId cannot be resolved", () => {
    // Happens when the properties read was unavailable or narrower than the monitors read.
    // Dropping the monitor entirely would under-report coverage, which is the worse error.
    const m = monitor({ propertyId: "p-unknown", target: "https://acme.com" });
    expect(monitorDomain(m, byProperty)).toBe("acme.com");
  });

  it("is null for a monitor that watches no domain at all", () => {
    // A heartbeat monitor has neither a property nor a target. It must join to nothing rather than
    // being attached to some arbitrary site.
    expect(monitorDomain(monitor({ kind: "heartbeat", target: null }), byProperty)).toBeNull();
  });
});

describe("indexMonitorsByDomain", () => {
  it("puts the worst monitor first when several watch one domain", () => {
    const index = indexMonitorsByDomain([
      monitor({ id: "up", status: "up", target: "acme.com" }),
      monitor({ id: "down", status: "down", target: "https://www.acme.com/" }),
      monitor({ id: "maint", status: "maintenance", target: "acme.com:443" }),
    ], []);
    expect(index.get("acme.com")?.map((m) => m.id)).toEqual(["down", "maint", "up"]);
  });

  it("ranks maintenance BELOW unknown — suppressed on purpose is not a worse signal than unproven", () => {
    const index = indexMonitorsByDomain([
      monitor({ id: "maint", status: "maintenance", target: "acme.com" }),
      monitor({ id: "unknown", status: "unknown", target: "acme.com" }),
    ], []);
    expect(index.get("acme.com")?.[0].id).toBe("unknown");
  });

  it("prefers an enabled monitor over a suspended one on a tie", () => {
    const index = indexMonitorsByDomain([
      monitor({ id: "off", status: "up", enabled: false, target: "acme.com" }),
      monitor({ id: "on", status: "up", enabled: true, target: "acme.com" }),
    ], []);
    expect(index.get("acme.com")?.[0].id).toBe("on");
  });

  it("does not index a monitor that watches no domain", () => {
    const index = indexMonitorsByDomain([monitor({ kind: "heartbeat", target: null })], []);
    expect(index.size).toBe(0);
  });
});

describe("siteMonitoring — the five answers", () => {
  it("says UNAVAILABLE, never 'no monitor', when the feed could not be read", () => {
    // The whole reason this module does not reuse `listMonitors`: that reader collapses 404/403
    // into [], which would print "No monitor" on every row whether nothing is watched or nobody
    // was allowed to ask. Those are opposite claims.
    for (const reason of ["not_enabled", "refused"] as const) {
      const st = resolve(site({ crawlConsent: true }), { available: false, reason });
      expect(st).toEqual({ kind: "unavailable", reason });
    }
  });

  it("matches a monitor across scheme, www and port differences", () => {
    const st = resolve(
      site({ domain: "acme.com", crawlConsent: true }),
      AVAILABLE([monitor({ id: "m", status: "degraded", target: "https://www.acme.com:8443/health" })]),
    );
    expect(st.kind).toBe("watched");
    expect(st.kind === "watched" && st.monitor.id).toBe("m");
  });

  it("reports WATCHED WITHOUT CONSENT as an anomaly instead of hiding it under 'not probed'", () => {
    // The ordering in siteMonitoring() is load-bearing: asking "is it consented" first would file
    // a domain that is actually being probed with no consent on record under "not probed" — the one
    // state nobody wants to be in, made invisible.
    const st = resolve(
      site({ domain: "acme.com", crawlConsent: false }),
      AVAILABLE([monitor({ target: "acme.com" })]),
    );
    expect(st).toMatchObject({ kind: "watched", consented: false });
  });

  it("says NOT PROBED for an unconsented site nothing is watching", () => {
    const st = resolve(site({ domain: "acme.com", crawlConsent: false }), AVAILABLE([]));
    expect(st.kind).toBe("no-consent");
  });

  it("says NONE — a real coverage gap — for a consented site nothing is watching", () => {
    const st = resolve(site({ domain: "acme.com", crawlConsent: true }), AVAILABLE([]));
    expect(st.kind).toBe("none");
  });

  it("does not attach a monitor for a DIFFERENT domain to this site", () => {
    const st = resolve(
      site({ domain: "acme.com", crawlConsent: true }),
      AVAILABLE([monitor({ target: "https://other.com" })]),
    );
    expect(st.kind).toBe("none");
  });

  it("treats a subdomain as its own host, not as the parent", () => {
    // staging.acme.com and acme.com are different sites in the portfolio and must not share a
    // monitor — a staging monitor reading as production coverage would be a false all-clear.
    const st = resolve(
      site({ domain: "acme.com", crawlConsent: true }),
      AVAILABLE([monitor({ target: "https://staging.acme.com" })]),
    );
    expect(st.kind).toBe("none");
  });
});

describe("monitorClientFor — what unblocks creating a monitor", () => {
  const props: PropertyRef[] = [{ id: "p1", domain: "www.acme.com", clientId: "cl-prop" }];

  it("uses the site's own client when it has one", () => {
    expect(monitorClientFor(site({ domain: "acme.com", clientId: "cl-site" }), props)).toBe("cl-site");
  });

  it("falls back to the CONSENTED domain's property client — the case that actually matters", () => {
    // Almost every surveyed portfolio row has clientId null (attributing them would have been
    // invention), and /monitoring/new requires a client. But consent IS `verified_at` on a
    // search_properties row, and that row carries a client_id — so for exactly the sites a monitor
    // is permitted on, the client is knowable rather than guessed.
    expect(monitorClientFor(site({ domain: "acme.com", clientId: null }), props)).toBe("cl-prop");
  });

  it("matches the property across a www difference", () => {
    expect(monitorClientFor(site({ domain: "www.acme.com" }), props)).toBe("cl-prop");
  });

  it("is null when nothing knows the client — never a borrowed one", () => {
    expect(monitorClientFor(site({ domain: "nobody.com" }), props)).toBeNull();
  });
});

describe("createMonitorHref", () => {
  it("always carries the domain, and the client only when it is known", () => {
    expect(createMonitorHref(site({ domain: "acme.com" }), "cl-1"))
      .toBe("/monitoring/new?domain=acme.com&clientId=cl-1");
    // A blank clientId param would land the operator on a form silently missing its required field.
    expect(createMonitorHref(site({ domain: "acme.com" }), null))
      .toBe("/monitoring/new?domain=acme.com");
  });

  it("encodes a domain that needs it", () => {
    expect(createMonitorHref(site({ domain: "a b.com" }), null)).toContain("domain=a+b.com");
  });
});

describe("coverageStats", () => {
  const watched = (status: Monitor["status"], consented = true): SiteMonitoring =>
    ({ kind: "watched", monitor: monitor({ status }), consented });

  it("counts a degraded or unknown monitor as a problem, and maintenance as not one", () => {
    // "not up" rather than "is down": degraded and unknown are both "not evidence of health", and a
    // figure that counts only `down` under-reports exactly the states monitoring exists to expose.
    // `maintenance` is suppressed on purpose and is not a problem to chase.
    const s = coverageStats([watched("down"), watched("degraded"), watched("unknown"), watched("maintenance"), watched("up")]);
    expect(s.watched).toBe(5);
    expect(s.problems).toBe(3);
  });

  it("counts probed-without-consent separately, because it is a different kind of wrong", () => {
    const s = coverageStats([watched("up", false), watched("up", true)]);
    expect(s.anomalies).toBe(1);
    expect(s.problems).toBe(0);
  });

  it("separates a consented coverage gap from a site nobody may probe", () => {
    const s = coverageStats([{ kind: "none", clientId: null }, { kind: "no-consent" }]);
    expect(s.unwatched).toBe(1);
    expect(s.noConsent).toBe(1);
  });

  it("goes UNAVAILABLE as soon as any state could not be read", () => {
    // The tile must then refuse to show a figure at all: "0 unmonitored" and "we could not ask"
    // look identical as a number and mean opposite things.
    const s = coverageStats([watched("up"), { kind: "unavailable", reason: "not_enabled" }]);
    expect(s.available).toBe(false);
  });
});
