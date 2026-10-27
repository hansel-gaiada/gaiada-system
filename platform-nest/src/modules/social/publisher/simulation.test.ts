// SCP-Sa — the social simulator's flag and containment, proved WITHOUT a database, Cerbos or a network (runs anywhere).
// The DB-backed half (the real dispatch path through the simulator, the boot DB counts, the account writers' refusals
// against real rows) is `simulated-dispatch.db.test.ts`; the migration's own suite is
// `src/db/social-simulation-migration.db.test.ts`.
//
// What this file pins, fence by fence (simulation.ts's header numbers them):
//   1. the switch: default off, read at call time;
//   2. the one road in: `resolveSimulatedPublisher` is the only way to the simulator; `getPublisher`, `resolvePublisher`
//      and every capability override refuse it by name;
//   3/4. the boot errors (each one), the registry's per-registration provenance check, and the runtime refusals of every
//      account create/connect path, plus a static inventory so a NEW writer of `social_accounts` (or of a `simulated`
//      mark) fails here until it is fenced;
//   5. the driver's own refusal order and its honest answers (approval first, then the switch, then the handle, then our
//      rows, then the failure keyword), and the port's contract suite with the switch on and off;
//   6. the labels: URLs under https://simulated.invalid/, the marker, the filter's statuses.
// And the standing rule this ticket must NOT weaken: the test double (`mock-driver.ts`) is never registered by boot,
// under any value of the switch.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "../../../config";
import { OrgHandle, SocialPublisherError, type SocialPublisher, type VariantDispatch } from "./types";
import {
  SIMULATED_PUBLISHER_KEY, SIMULATE_FAIL_KEYWORD, SOCIAL_SIMULATION_REFUSAL, SimulatedOrgHandle,
  assertRealAccountWriteAllowed, assertSimulatedWriteAllowed, isSimulatedPublisher, isSocialSimulationEnabled,
  publisherProvenanceViolation, realAccountWriteRefusal,
} from "./simulation";
import { createSimulatedPublisher, SIMULATED_CAPABILITIES, type SimulatedDispatchGuard } from "./simulated-driver";
import { createMockPublisher, newMockPublisherState } from "./mock-driver";
import { createDirectDriver } from "./direct";
import {
  getPublisher, listPublishers, registerPublisher, resetPublishers, resolvePublisher, resolvePublisherForCapability,
  resolveSimulatedPublisher,
} from "./registry";
import { assertSocialSimulationBootSafe, SocialSimulationBootError, wireSocialPublisher, type SocialSimulationBootFacts } from "./boot";
import { runPublisherContractSuite } from "./publisher-contract";
import { checkConnectReadiness, initiateAccountConnect, syncConnectorRegistry } from "./provisioning";
import { checkLinkedInConnectReadiness, completeLinkedInConnect, startLinkedInConnect } from "./linkedin-oauth";
import { checkYouTubeConnectReadiness, completeYouTubeConnect, startYouTubeConnect } from "./youtube-oauth";
import { SocialPublisherErrorFilter } from "../publisher-error.filter";

const T = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000b2";
const ORG = "00000000-0000-4000-8000-0000000000c3";
const simHandle = (accountId: string | null = ACCOUNT) => new SimulatedOrgHandle(T, accountId, ORG);
const dispatchReq = (over: Partial<VariantDispatch> = {}): VariantDispatch => ({
  integrationId: "simulated:facebook", network: "facebook", body: "A mock caption", approvalId: "appr-1",
  variantId: "var-1", ...over,
});
const passGuard: SimulatedDispatchGuard = async () => null;

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    if (typeof p === "function") p(); else await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SocialPublisherError);
    return (e as SocialPublisherError).code;
  }
  throw new Error("expected a typed refusal, but the call resolved");
}

const before = {
  flag: config.socialSimulationEnabled,
  baseUrl: config.social.publisher.baseUrl,
  overrides: config.social.publisher.capabilityDrivers,
};
function setFlag(on: boolean): void {
  config.socialSimulationEnabled = on;
}
afterEach(() => {
  config.socialSimulationEnabled = before.flag;
  config.social.publisher.baseUrl = before.baseUrl;
  config.social.publisher.capabilityDrivers = before.overrides;
  resetPublishers();
  vi.restoreAllMocks();
});

// ── 1. The switch ────────────────────────────────────────────────────────────────────────────────────────────────

describe("SCP-Sa · the switch", () => {
  it("is OFF by default (the env var is unset in every test run) and read at call time", () => {
    expect(process.env.SOCIAL_SIMULATION_ENABLED ?? "").not.toMatch(/^(1|true)$/);
    expect(before.flag).toBe(false);
    expect(isSocialSimulationEnabled()).toBe(false);
    setFlag(true);
    expect(isSocialSimulationEnabled()).toBe(true);
    setFlag(false);
    expect(isSocialSimulationEnabled()).toBe(false);
  });

  it("the config.ts reader accepts exactly '1' and 'true' (the neighbouring simulation flags' convention)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "config.ts"), "utf8");
    expect(src).toMatch(
      /socialSimulationEnabled:\s*\n\s*process\.env\.SOCIAL_SIMULATION_ENABLED === "1" \|\| process\.env\.SOCIAL_SIMULATION_ENABLED === "true",/,
    );
    expect(src).toMatch(/Must be OFF, and the simulated rows purged, before the ERP holds real client data/);
  });
});

// ── 2. The one road in ───────────────────────────────────────────────────────────────────────────────────────────

describe("SCP-Sa · the registry: the simulator is reachable ONLY through resolveSimulatedPublisher", () => {
  beforeEach(() => {
    setFlag(true);
    resetPublishers();
    registerPublisher(createDirectDriver());
    registerPublisher(createSimulatedPublisher({ guard: passGuard }));
  });

  it("getPublisher never returns it by name", () => {
    expect(getPublisher("simulated")).toBeUndefined();
    expect(getPublisher("direct")?.key).toBe("direct");
  });

  it("resolvePublisher never returns it, and its presence keeps the honest publisher_not_configured", async () => {
    expect(await codeOf(() => resolvePublisher("simulated"))).toBe("publisher_not_configured");
    expect(await codeOf(() => resolvePublisher("postiz"))).toBe("publisher_not_configured");
  });

  it("a capability override naming it is refused as unknown_publisher, never resolved", async () => {
    config.social.publisher.capabilityDrivers = { "*:schedule": "simulated" };
    expect(await codeOf(() => resolvePublisherForCapability("postiz", "facebook", "schedule"))).toBe("unknown_publisher");
    config.social.publisher.capabilityDrivers = { "facebook:*": "simulated" };
    expect(await codeOf(() => resolvePublisherForCapability("postiz", "facebook", "schedule"))).toBe("unknown_publisher");
  });

  it("resolveSimulatedPublisher returns it for what it simulates, and refuses what it does not", async () => {
    for (const cap of SIMULATED_CAPABILITIES) expect(resolveSimulatedPublisher(cap).key).toBe(SIMULATED_PUBLISHER_KEY);
    for (const cap of ["inbox_read", "inbox_reply", "connect_url", "integrations", "account_metrics", "post_metrics"] as const) {
      expect(await codeOf(() => resolveSimulatedPublisher(cap))).toBe("capability_unsupported");
    }
  });

  it("resolveSimulatedPublisher refuses simulation_disabled with the switch off, even with the simulator still registered", async () => {
    setFlag(false);
    expect(await codeOf(() => resolveSimulatedPublisher("schedule"))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
  });

  it("resolveSimulatedPublisher refuses simulation_disabled when nothing is registered under the key", async () => {
    resetPublishers();
    expect(await codeOf(() => resolveSimulatedPublisher("schedule"))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
  });
});

// ── 3/4. Provenance: per registration and after boot ─────────────────────────────────────────────────────────────

describe("SCP-Sa · provenance: the marker must match the key and the switch (SM-33's assertProvenance shape)", () => {
  const sim = () => createSimulatedPublisher({ guard: passGuard });
  const realUnderSimKey = (): SocialPublisher => ({ ...createMockPublisher(newMockPublisherState()), key: "simulated" });
  const simUnderPostizKey = (): SocialPublisher => ({ ...sim(), key: "postiz" });

  it("the simulator carries the structural marker; no real driver does", () => {
    expect(isSimulatedPublisher(sim())).toBe(true);
    expect((sim() as { simulated?: unknown }).simulated).toBe(true);
    expect(isSimulatedPublisher(createMockPublisher(newMockPublisherState()))).toBe(false);
    expect(isSimulatedPublisher(createDirectDriver())).toBe(false);
    expect(isSimulatedPublisher(null)).toBe(false);
  });

  it("publisherProvenanceViolation: every forbidden mix is named, every allowed one is null", () => {
    const mock = createMockPublisher(newMockPublisherState());
    expect(publisherProvenanceViolation([mock, createDirectDriver()], false)).toBeNull();
    expect(publisherProvenanceViolation([createDirectDriver(), sim()], true)).toBeNull();
    expect(publisherProvenanceViolation([sim()], false)).toMatch(/is off/);
    expect(publisherProvenanceViolation([sim(), mock], true)).toMatch(/real publishing engine/);
    expect(publisherProvenanceViolation([{ ...mock, key: "mixpost" }], true)).toMatch(/real publishing engine/);
    expect(publisherProvenanceViolation([realUnderSimKey()], true)).toMatch(/only the simulator may take that key/);
    expect(publisherProvenanceViolation([simUnderPostizKey()], true)).toMatch(/registers only under the key/);
  });

  it("registerPublisher refuses the simulator with the switch off", () => {
    setFlag(false);
    expect(() => registerPublisher(sim())).toThrowError(/BOOT ERROR.*is off/);
    expect(listPublishers()).toHaveLength(0);
  });

  it("registerPublisher refuses a real engine beside the simulator, in either order", () => {
    setFlag(true);
    registerPublisher(sim());
    expect(() => registerPublisher(createMockPublisher(newMockPublisherState()))).toThrowError(/real publishing engine/);
    resetPublishers();
    // The other order cannot happen with the switch on either: the engine is refused as it enters a registry the switch
    // says must hold only the simulator.
    expect(() => registerPublisher(createMockPublisher(newMockPublisherState()))).toThrowError(/real publishing engine/);
  });

  it("registerPublisher refuses a marker/key mismatch whatever the switch", () => {
    for (const on of [true, false]) {
      setFlag(on);
      resetPublishers();
      expect(() => registerPublisher(realUnderSimKey())).toThrowError(/only the simulator may take that key/);
      expect(() => registerPublisher(simUnderPostizKey())).toThrowError(/registers only under the key/);
    }
  });
});

// ── Boot errors ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("SCP-Sa · boot errors (each one ABORTS startup: a thrown error, never a warning)", () => {
  const safe: SocialSimulationBootFacts = {
    enabled: true, postizBaseUrl: "", capabilityOverrides: {}, liveOAuthGrants: 0, realAccounts: 0,
  };

  it("a clean simulated database boots", () => {
    expect(() => assertSocialSimulationBootSafe(safe)).not.toThrow();
  });

  it("refuses the switch beside Postiz", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, postizBaseUrl: "http://10.88.0.2:4007" }))
      .toThrowError(SocialSimulationBootError);
    expect(() => assertSocialSimulationBootSafe({ ...safe, postizBaseUrl: "http://10.88.0.2:4007" }))
      .toThrowError(/SOCIAL_POSTIZ_BASE_URL is set/);
  });

  it("refuses the switch beside ANY capability override (the config road to a real `direct`)", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, capabilityOverrides: { "linkedin:*": "direct" } }))
      .toThrowError(/SOCIAL_PUBLISHER_CAPABILITY_DRIVERS routes linkedin:\*/);
  });

  it("refuses the switch beside a live OAuth grant (the token road to a real `direct`)", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, liveOAuthGrants: 1 })).toThrowError(/1 live OAuth grant/);
  });

  it("refuses the switch beside ANY non-simulated account", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, realAccounts: 1 })).toThrowError(/1 non-simulated social_accounts/);
  });

  it("refuses an override naming the simulator EVEN WITH THE SWITCH OFF", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, enabled: false, capabilityOverrides: { "*:schedule": "simulated" } }))
      .toThrowError(/'\*:schedule' to 'simulated'/);
  });

  it("with the switch off, nothing else is checked: a real deployment boots exactly as before", () => {
    expect(() => assertSocialSimulationBootSafe({
      enabled: false, postizBaseUrl: "http://10.88.0.2:4007", capabilityOverrides: { "linkedin:*": "direct" },
      liveOAuthGrants: 9, realAccounts: 9,
    })).not.toThrow();
  });
});

describe("SCP-Sa · wireSocialPublisher (the exact function bootstrap() awaits)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config.social.publisher.baseUrl = "";
    config.social.publisher.capabilityDrivers = {};
    resetPublishers();
  });

  it("switch OFF: the simulator is NOT registered, the DB is NOT read, one plain log line says so", async () => {
    setFlag(false);
    const readDbFacts = vi.fn(async () => ({ liveOAuthGrants: 0, realAccounts: 0 }));
    await wireSocialPublisher({ readDbFacts });
    expect(readDbFacts).not.toHaveBeenCalled();
    expect(listPublishers().map((p) => p.key)).toEqual(["direct"]);
    expect(listPublishers().some(isSimulatedPublisher)).toBe(false);
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n"))
      .toMatch(/\[social\] simulation: off/);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("switch ON, clean database: registers the simulator beside an inert `direct`, and warns on the boot log", async () => {
    setFlag(true);
    const readDbFacts = vi.fn(async () => ({ liveOAuthGrants: 0, realAccounts: 0 }));
    await wireSocialPublisher({ readDbFacts });
    expect(readDbFacts).toHaveBeenCalledTimes(1);
    expect(listPublishers().map((p) => p.key).sort()).toEqual(["direct", "simulated"]);
    expect(resolveSimulatedPublisher("schedule").key).toBe("simulated");
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n"))
      .toMatch(/^\[social:simulation-enabled\] SOCIAL_SIMULATION_ENABLED is ON/m);
  });

  it("switch ON beside a real account: refuses BEFORE registering anything", async () => {
    setFlag(true);
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ liveOAuthGrants: 0, realAccounts: 3 }) }))
      .rejects.toThrowError(SocialSimulationBootError);
    expect(listPublishers()).toHaveLength(0);
  });

  it("switch ON beside a live grant, Postiz, or an override: refuses", async () => {
    setFlag(true);
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ liveOAuthGrants: 2, realAccounts: 0 }) }))
      .rejects.toThrowError(/live OAuth grant/);
    config.social.publisher.baseUrl = "http://10.88.0.2:4007";
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ liveOAuthGrants: 0, realAccounts: 0 }) }))
      .rejects.toThrowError(/SOCIAL_POSTIZ_BASE_URL/);
    config.social.publisher.baseUrl = "";
    config.social.publisher.capabilityDrivers = { "linkedin:schedule": "direct" };
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ liveOAuthGrants: 0, realAccounts: 0 }) }))
      .rejects.toThrowError(/CAPABILITY_DRIVERS/);
    expect(listPublishers().some(isSimulatedPublisher)).toBe(false);
  });
});

// ── 5. The driver ────────────────────────────────────────────────────────────────────────────────────────────────

describe("SCP-Sa · the simulated driver: refusal order and honest answers", () => {
  beforeEach(() => setFlag(true));

  it("(1) approval_required first, whatever else is wrong", async () => {
    setFlag(false);
    const d = createSimulatedPublisher({ guard: passGuard });
    expect(await codeOf(d.schedulePost(new OrgHandle("r", "o", "k"), dispatchReq({ approvalId: "" })))).toBe("approval_required");
  });

  it("(2) simulation_disabled with the switch off, before the guard reads anything", async () => {
    setFlag(false);
    const guard = vi.fn(passGuard);
    const d = createSimulatedPublisher({ guard });
    expect(await codeOf(d.schedulePost(simHandle(), dispatchReq()))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    expect(guard).not.toHaveBeenCalled();
  });

  it("(3) simulated_account_required for a REAL org handle, before the guard reads anything", async () => {
    const guard = vi.fn(passGuard);
    const d = createSimulatedPublisher({ guard });
    expect(await codeOf(d.schedulePost(new OrgHandle("r", "o", "k"), dispatchReq()))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(guard).not.toHaveBeenCalled();
  });

  it("(4)(5) the guard's refusal is passed through verbatim (account not simulated / approval not decided)", async () => {
    for (const code of [SOCIAL_SIMULATION_REFUSAL.accountNotSimulated, SOCIAL_SIMULATION_REFUSAL.approvalNotDecided] as const) {
      const d = createSimulatedPublisher({ guard: async () => ({ code, message: "from our rows" }) });
      expect(await codeOf(d.schedulePost(simHandle(), dispatchReq()))).toBe(code);
    }
  });

  it("(6) the failure keyword refuses simulated_publish_failed, only AFTER the guard passed", async () => {
    const guard = vi.fn(passGuard);
    const d = createSimulatedPublisher({ guard });
    expect(await codeOf(d.schedulePost(simHandle(), dispatchReq({ body: `Launch day ${SIMULATE_FAIL_KEYWORD}` }))))
      .toBe(SOCIAL_SIMULATION_REFUSAL.simulatedFailure);
    expect(guard).toHaveBeenCalledTimes(1);
    // Literal and case-sensitive: near misses publish.
    expect((await d.schedulePost(simHandle(), dispatchReq({ body: "[SIMULATE-FAIL] [simulate fail]" }))).providerPostId)
      .toMatch(/^simulated:facebook:/);
  });

  it("(7) mints simulated:<network>:<publishAt>:<uuid>; live at dispatch time, or at the approved time when later", async () => {
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    let now = t0;
    const d = createSimulatedPublisher({ guard: passGuard, now: () => now });
    const { providerPostId: a } = await d.schedulePost(simHandle(), dispatchReq());
    expect(a).toMatch(new RegExp(`^simulated:facebook:${t0}:[0-9a-f-]{36}$`));
    const later = "2026-11-03T12:00:00Z";
    const { providerPostId: b } = await d.schedulePost(simHandle(), dispatchReq({ network: "instagram", scheduledAt: later }));
    expect(b).toMatch(new RegExp(`^simulated:instagram:${Date.parse(later)}:`));
    // A past scheduledAt never back-dates: live at dispatch time.
    const { providerPostId: c } = await d.schedulePost(simHandle(), dispatchReq({ scheduledAt: "2026-11-01T00:00:00Z" }));
    expect(c).toMatch(new RegExp(`^simulated:facebook:${t0}:`));

    const st = await d.getPostStatus(simHandle(null), [a, b, "postiz-real-id-1"]);
    expect(st[0]).toMatchObject({ providerPostId: a, state: "published", publishedAt: new Date(t0).toISOString() });
    expect(st[0].publishedUrl).toMatch(/^https:\/\/simulated\.invalid\/facebook\/[0-9a-f-]{36}$/);
    expect(st[1]).toEqual({ providerPostId: b, state: "queued" });
    expect(st[2]).toEqual({ providerPostId: "postiz-real-id-1", state: "unknown" });

    now = Date.parse(later);
    const st2 = await d.getPostStatus(simHandle(null), [b]);
    expect(st2[0]).toMatchObject({ state: "published", publishedAt: later.replace("Z", ".000Z") });
    expect(st2[0].publishedUrl).toMatch(/^https:\/\/simulated\.invalid\/instagram\//);
  });

  it("getPostStatus, cancelPost and uploadMedia are fenced by the switch and the handle too", async () => {
    const d = createSimulatedPublisher({ guard: passGuard });
    const real = new OrgHandle("r", "o", "k");
    expect(await codeOf(d.getPostStatus(real, []))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(await codeOf(d.cancelPost(real, "x"))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(await codeOf(d.uploadMedia(real, { filename: "a.png", contentType: "image/png", bytes: new Uint8Array() }, "instagram")))
      .toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    // It cancels only what it minted.
    expect(await codeOf(d.cancelPost(simHandle(), "postiz-real-id-1"))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    const { providerPostId } = await d.schedulePost(simHandle(), dispatchReq());
    await expect(d.cancelPost(simHandle(), providerPostId)).resolves.toBeUndefined();
    const media = await d.uploadMedia(simHandle(), { filename: "a.png", contentType: "image/png", bytes: new Uint8Array([1]) }, "instagram");
    expect(media.id).toMatch(/^simulated-media:/);
    expect(media.url).toMatch(/^https:\/\/simulated\.invalid\/media\//);
    setFlag(false);
    expect(await codeOf(d.getPostStatus(simHandle(), []))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    expect(await codeOf(d.cancelPost(simHandle(), providerPostId))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    expect(await codeOf(d.uploadMedia(simHandle(), { filename: "a.png", contentType: "image/png", bytes: new Uint8Array() }, "instagram")))
      .toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
  });

  it("does not connect, sync, verify or report metrics (SCP-Sb seeds accounts; SCP-Sd adds metrics), and costs nothing", async () => {
    const d = createSimulatedPublisher({ guard: passGuard });
    expect([...d.capabilities].sort()).toEqual(["cancel", "media_upload", "post_status", "schedule"]);
    expect(await codeOf(d.connectUrl(simHandle(), "instagram", "https://x.invalid"))).toBe("capability_unsupported");
    expect(await codeOf(d.listIntegrations(simHandle()))).toBe("capability_unsupported");
    expect(await codeOf(d.verifyOrg(simHandle()))).toBe("capability_unsupported");
    expect(await codeOf(d.getAccountMetrics(simHandle(), "i", { from: "2026-11-01", to: "2026-11-02" }))).toBe("capability_unsupported");
    expect(await codeOf(d.getPostMetrics(simHandle(), ["x"]))).toBe("capability_unsupported");
    expect(d.listComments).toBeUndefined();
    expect(d.sendReply).toBeUndefined();
    expect(d.estimateCostUsd({ network: "x", hasLink: true })).toBe(0);
  });

  it("its org handle carries no credential and serializes without one", () => {
    const h = simHandle();
    expect(h.secret()).toBe("");
    expect(JSON.parse(JSON.stringify(h))).toEqual({ publisherOrgId: ORG, orgId: "simulated", apiKey: "[redacted]" });
    expect(h.tenantId).toBe(T);
    expect(h.accountId).toBe(ACCOUNT);
  });
});

// The port's own contract, against the simulator, with the switch on and off: every member does its job or refuses TYPED.
describe("SCP-Sa · port contract (switch on)", () => {
  beforeEach(() => setFlag(true));
  runPublisherContractSuite("simulated (switch on)", { build: () => createSimulatedPublisher({ guard: passGuard }) });
});
describe("SCP-Sa · port contract (switch off)", () => {
  beforeEach(() => setFlag(false));
  runPublisherContractSuite("simulated (switch off)", { build: () => createSimulatedPublisher({ guard: passGuard }) });
});

// ── 3. Runtime refusals: every account create/connect path ───────────────────────────────────────────────────────

describe("SCP-Sa · runtime: with the switch ON, no path creates or connects a REAL account", () => {
  beforeEach(() => setFlag(true));
  const REFUSED = SOCIAL_SIMULATION_REFUSAL.realAccountRefused;

  it("the guards themselves", async () => {
    expect(await codeOf(() => assertRealAccountWriteAllowed("x"))).toBe(REFUSED);
    expect(realAccountWriteRefusal("x")).toMatchObject({ ok: false, reason: REFUSED });
    expect(() => assertSimulatedWriteAllowed("x")).not.toThrow();
  });

  // Each of these refuses as its FIRST step, before any database read or network call, so this file can prove it
  // without Postgres: a call that got further would throw a connection error instead of the typed code.
  it("account connect (readiness answers it; initiate throws it)", async () => {
    expect(await checkConnectReadiness(T, ACCOUNT, "instagram")).toMatchObject({ ok: false, reason: REFUSED });
    expect(await codeOf(initiateAccountConnect(T, { clientId: ACCOUNT, network: "instagram", handle: "@x", actorId: null }))).toBe(REFUSED);
  });

  it("connector-registry sync (Postiz-mirrored accounts are always real)", async () => {
    expect(await codeOf(syncConnectorRegistry(T, ACCOUNT, null))).toBe(REFUSED);
  });

  it("LinkedIn connect: readiness, start AND the OAuth callback (before the single-use code is spent)", async () => {
    const fetchImpl = vi.fn();
    expect(await checkLinkedInConnectReadiness(T, ACCOUNT)).toMatchObject({ ok: false, reason: REFUSED });
    expect(await codeOf(startLinkedInConnect(T, { clientId: ACCOUNT, handle: "@x", actorId: null }))).toBe(REFUSED);
    expect(await codeOf(completeLinkedInConnect(T, ACCOUNT, { code: "c", actorId: null, fetchImpl: fetchImpl as never }))).toBe(REFUSED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("YouTube connect: readiness, start AND the OAuth callback", async () => {
    const fetchImpl = vi.fn();
    expect(await checkYouTubeConnectReadiness(T, ACCOUNT)).toMatchObject({ ok: false, reason: REFUSED });
    expect(await codeOf(startYouTubeConnect(T, { clientId: ACCOUNT, handle: "@x", actorId: null }))).toBe(REFUSED);
    expect(await codeOf(completeYouTubeConnect(T, ACCOUNT, { code: "c", actorId: null, fetchImpl: fetchImpl as never }))).toBe(REFUSED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("SCP-Sa · runtime: with the switch OFF, nothing writes a simulated mark", () => {
  beforeEach(() => setFlag(false));

  it("assertSimulatedWriteAllowed refuses simulation_disabled; real writes are allowed", async () => {
    expect(await codeOf(() => assertSimulatedWriteAllowed("x"))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    expect(() => assertRealAccountWriteAllowed("x")).not.toThrow();
    expect(realAccountWriteRefusal("x")).toBeNull();
  });
});

// ── Static inventory: a NEW writer fails here until it is fenced ─────────────────────────────────────────────────

const SRC = join(__dirname, "..", "..", "..");
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
/** The only file allowed to write a `simulated = true` account (SCP-Sb). */
const SIMULATED_ACCOUNT_WRITER = "modules/social/simulated-accounts.ts";
const sqlLiterals = (src: string) => [...src.matchAll(/`[^`]*`/g)].map((m) => m[0]);

describe("SCP-Sa · static inventory of the writers (src/, tests excluded)", () => {
  const files = sourceFiles();

  it("found the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(rel)).toContain("modules/social/dispatch.ts");
  });

  it("every file that INSERTs or UPDATEs social_accounts is fenced against a real account under the switch", () => {
    const writers = files.filter((f) => /\b(INSERT\s+INTO|UPDATE)\s+social_accounts\b/.test(readFileSync(f, "utf8")));
    expect(writers.map(rel).sort()).toEqual([
      "modules/social/publisher/linkedin-oauth.ts",
      "modules/social/publisher/provisioning.ts",
      "modules/social/publisher/youtube-oauth.ts",
      "modules/social/simulated-accounts.ts",
      "seed/portal-engagement.ts",
    ]);
    for (const f of writers) {
      // SCP-Sb's seed is the one writer of SIMULATED accounts: it owes the opposite fence (switch OFF refuses) instead.
      if (rel(f) === SIMULATED_ACCOUNT_WRITER) continue;
      expect(readFileSync(f, "utf8"), rel(f)).toMatch(/\b(assertRealAccountWriteAllowed|realAccountWriteRefusal)\(/);
    }
  });

  it("the ONLY statement that writes a variant's `simulated` mark is dispatch.ts's stamp; the ONLY account-mark writer is SCP-Sb's seed", () => {
    const variantMarkWriters: string[] = [];
    const accountMarkWriters: string[] = [];
    for (const f of files) {
      for (const lit of sqlLiterals(readFileSync(f, "utf8"))) {
        if (!/\bsimulated\b/.test(lit)) continue;
        if (/\b(INSERT\s+INTO|UPDATE)\s+social_post_variants\b/.test(lit)) variantMarkWriters.push(rel(f));
        if (/\b(INSERT\s+INTO|UPDATE)\s+social_accounts\b/.test(lit)) accountMarkWriters.push(rel(f));
      }
    }
    expect(variantMarkWriters).toEqual(["modules/social/dispatch.ts"]);
    // SCP-Sb's seed is the ONE writer of an account's mark: it calls `assertSimulatedWriteAllowed` before it writes, and its
    // controller calls it again before the body is read. A second writer fails here until it is fenced the same way.
    expect([...new Set(accountMarkWriters)]).toEqual([SIMULATED_ACCOUNT_WRITER]);
    const seed = readFileSync(join(SRC, SIMULATED_ACCOUNT_WRITER), "utf8");
    const fence = seed.indexOf('assertSimulatedWriteAllowed("simulated-account seed")');
    expect(fence).toBeGreaterThan(-1);
    // The fence precedes every statement that writes the SEED path's account rows. (The teardown, which must work with the
    // switch OFF, comes after the seed in the file and only soft-deletes rows already marked simulated.)
    expect(fence).toBeLessThan(seed.indexOf("INSERT INTO social_accounts"));
    expect(fence).toBeLessThan(seed.indexOf("UPDATE social_accounts"));
    const controller = readFileSync(join(SRC, "modules", "social", "simulated-accounts.controller.ts"), "utf8");
    expect(controller.indexOf("authorizePlan(")).toBeGreaterThan(-1);
    expect(controller.indexOf("authorizePlan(")).toBeLessThan(controller.indexOf("assertSimulatedWriteAllowed("));
    expect(controller.indexOf("assertSimulatedWriteAllowed(")).toBeLessThan(controller.indexOf("parseSeedBody("));
    // And the stamp only ever ADDS the mark, from the simulator's provenance, behind the switch.
    const dispatch = readFileSync(join(SRC, "modules", "social", "dispatch.ts"), "utf8");
    expect(dispatch).toMatch(/simulated = \(simulated OR \$7::boolean\)/);
    expect(dispatch).toMatch(/simulated: servedBySimulator && isSocialSimulationEnabled\(\)/);
  });

  it("the one road in has exactly two on-ramps: the dispatch resolver and the status sweep", () => {
    const callers = files
      .filter((f) => !f.endsWith(`${sep}registry.ts`))
      .filter((f) => /\bresolveSimulatedPublisher\(/.test(readFileSync(f, "utf8")));
    expect(callers.map(rel).sort()).toEqual([
      "modules/social/post-status-sync-job.ts",
      "modules/social/publisher/provisioning.ts",
    ]);
  });

  it("the simulator is constructed only by boot.ts (outside tests)", () => {
    const constructors = files.filter((f) => /\bcreateSimulatedPublisher\(/.test(readFileSync(f, "utf8")));
    expect(constructors.map(rel).sort()).toEqual([
      "modules/social/publisher/boot.ts",
      "modules/social/publisher/simulated-driver.ts",
    ]);
  });
});

// ── The rule this ticket must NOT weaken: the test double stays unregistered under every switch value ───────────────

describe("SCP-Sa · the test double (mock-driver.ts) is never registered by boot, switch on or off", () => {
  it("no non-test source imports mock-driver", () => {
    const importers = sourceFiles()
      .filter((f) => !f.endsWith(`${sep}mock-driver.ts`))
      .filter((f) => /from\s+["'][^"']*mock-driver["']/.test(readFileSync(f, "utf8")));
    expect(importers.map(rel)).toEqual([]);
  });

  it("the double carries no simulated marker, so it could never pass for the simulator", () => {
    expect(isSimulatedPublisher(createMockPublisher(newMockPublisherState()))).toBe(false);
  });

  for (const on of [false, true]) {
    it(`wireSocialPublisher with the switch ${on ? "ON" : "OFF"} registers nothing but direct${on ? " and the simulator" : ""}`, async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      config.social.publisher.baseUrl = "";
      config.social.publisher.capabilityDrivers = {};
      setFlag(on);
      resetPublishers();
      await wireSocialPublisher({ readDbFacts: async () => ({ liveOAuthGrants: 0, realAccounts: 0 }) });
      const keys = listPublishers().map((p) => p.key).sort();
      expect(keys).toEqual(on ? ["direct", "simulated"] : ["direct"]);
      // Neither registered driver is the double: the double's connectUrl answers mock.invalid, never these.
      for (const p of listPublishers()) expect(p.capabilities.has("org_verify") && p.key === "postiz").toBe(false);
    });
  }
});

// ── 6. Labels ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("SCP-Sa · the HTTP filter renders every new code with its intended status", () => {
  function render(err: SocialPublisherError): { status: number; body: unknown } {
    let status = 0;
    let body: unknown;
    const reply = {
      status(s: number) { status = s; return reply; },
      send(b: unknown) { body = b; return reply; },
    };
    const host = { switchToHttp: () => ({ getResponse: () => reply }) };
    new SocialPublisherErrorFilter().catch(err, host as never);
    return { status, body };
  }

  it.each([
    ["simulation_real_account_refused", 409],
    ["simulation_disabled", 409],
    ["simulated_account_required", 409],
    ["simulated_approval_not_decided", 409],
    ["simulated_publish_failed", 502],
  ] as const)("%s -> %i, with the code in the body", (code, status) => {
    expect(render(new SocialPublisherError(code, "why"))).toEqual({ status, body: { error: "why", code } });
  });
});
