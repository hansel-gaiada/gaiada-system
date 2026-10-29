// SCP-Sa / SCP-Sa2 — the social simulator's flag and containment, proved WITHOUT a database, Cerbos or a network (runs
// anywhere). The DB-backed half (the real dispatch path through the simulator, the boot DB counts, the account writers'
// refusals against real rows) is `simulated-dispatch.db.test.ts` and, for SCP-Sa2's side-by-side mode,
// `side-by-side.db.test.ts`; the migrations' own suites are `src/db/social-simulation-migration.db.test.ts` and
// `src/db/social-account-kind-migration.db.test.ts`.
//
// SCP-Sa2 (owner ruling SCP-D9, 2026-10-28): the simulator now runs BESIDE a real Postiz. The pins that encoded "never
// both" (boot refusing Postiz / a real-driver override / a live grant / a real account; the connect paths refusing a real
// account; the registry refusing a real engine beside the simulator) were REPLACED by pins for "never mixed": each one's
// test name below says what changed. Every pin that still holds is unchanged.
//
// What this file pins, fence by fence (simulation.ts's header numbers them):
//   1. the switch: default off, read at call time;
//   2. the one road in: `resolveSimulatedPublisher` is the only way to the simulator; `getPublisher`, `resolvePublisher`
//      and every capability override refuse it by name;
//   3. one kind per account: the boot errors (each one), the registry's per-registration provenance check, the real
//      account writers' fences, plus a static inventory so a NEW writer of `social_accounts` (or of a `simulated` mark)
//      fails here until it is fenced;
//   4. each driver refuses the other kind: the reverse fence (`realPublisherRefusal`) and a static inventory of the real
//      paths that must ask it;
//   5. the driver's own refusal order and its honest answers (approval first, then the switch, then the handle, then our
//      rows, then the failure keyword), and the port's contract suite with the switch on and off;
//   7. the labels: URLs under https://simulated.invalid/, the marker, the filter's statuses.
// And the standing rule this ticket must NOT weaken: the test double (`mock-driver.ts`) is never registered by boot,
// under any value of the switch.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "../../../config";
import { OrgHandle, SocialPublisherError, type SocialPublisher, type VariantDispatch } from "./types";
import {
  SIMULATED_ID_PREFIX, SIMULATED_PUBLISHER_KEY, SIMULATE_FAIL_KEYWORD, SOCIAL_SIMULATION_REFUSAL, SimulatedOrgHandle,
  assertRealIntegrationId, assertRealPublisherTarget, assertSimulatedWriteAllowed, isSimulatedId, isSimulatedPublisher,
  isSocialSimulationEnabled, publisherProvenanceViolation, realPublisherRefusal, realWriteOnSimulatedRow,
} from "./simulation";
import { createSimulatedPublisher, SIMULATED_CAPABILITIES, type SimulatedDispatchGuard } from "./simulated-driver";
import { createMockPublisher, newMockPublisherState } from "./mock-driver";
import { createDirectDriver } from "./direct";
import {
  getPublisher, listPublishers, realPublisherKey, registerPublisher, resetPublishers, resolvePublisher,
  resolvePublisherForCapability, resolveSimulatedPublisher,
} from "./registry";
import { assertSocialSimulationBootSafe, SocialSimulationBootError, wireSocialPublisher, type SocialSimulationBootFacts } from "./boot";
import { runPublisherContractSuite } from "./publisher-contract";
import { checkConnectReadiness } from "./provisioning";
import { checkLinkedInConnectReadiness } from "./linkedin-oauth";
import { checkYouTubeConnectReadiness } from "./youtube-oauth";
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
    for (const cap of ["inbox_read", "inbox_reply", "connect_url", "integrations"] as const) {
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

  it("publisherProvenanceViolation: every forbidden registry is named, every allowed one is null (SCP-Sa2: a real engine beside the simulator is ALLOWED)", () => {
    const mock = createMockPublisher(newMockPublisherState());
    expect(publisherProvenanceViolation([mock, createDirectDriver()], false)).toBeNull();
    expect(publisherProvenanceViolation([createDirectDriver(), sim()], true)).toBeNull();
    expect(publisherProvenanceViolation([sim()], false)).toMatch(/is off/);
    // SCP-Sa2 (SCP-D9): was "real publishing engine" refused; side by side is now the ruled mode.
    expect(publisherProvenanceViolation([sim(), mock, createDirectDriver()], true)).toBeNull();
    expect(publisherProvenanceViolation([{ ...mock, key: "mixpost" }, sim()], true)).toBeNull();
    expect(publisherProvenanceViolation([realUnderSimKey()], true)).toMatch(/only the simulator may take that key/);
    expect(publisherProvenanceViolation([simUnderPostizKey()], true)).toMatch(/registers only under the key/);
  });

  it("registerPublisher refuses the simulator with the switch off", () => {
    setFlag(false);
    expect(() => registerPublisher(sim())).toThrowError(/BOOT ERROR.*is off/);
    expect(listPublishers()).toHaveLength(0);
  });

  it("SCP-Sa2 (was: refuses a real engine beside the simulator): registerPublisher ADMITS a real engine beside it, in either order, and keeps them apart by key", () => {
    setFlag(true);
    registerPublisher(sim());
    registerPublisher(createMockPublisher(newMockPublisherState())); // the test double, under 'postiz'
    expect(listPublishers().map((p) => p.key).sort()).toEqual(["postiz", "simulated"]);
    expect(realPublisherKey()).toBe("postiz");
    resetPublishers();
    registerPublisher(createMockPublisher(newMockPublisherState()));
    registerPublisher(sim());
    // The real engine never resolves to the simulator, and the simulator never resolves by the real engine's names.
    expect(resolvePublisher("postiz").key).toBe("postiz");
    expect(isSimulatedPublisher(resolvePublisher("postiz"))).toBe(false);
    expect(getPublisher("simulated")).toBeUndefined();
    expect(resolveSimulatedPublisher("schedule").key).toBe("simulated");
  });

  it("SCP-Sa2: a simulator filed under 'postiz' beside a real engine is still refused (the marker/key rule did not move)", () => {
    setFlag(true);
    registerPublisher(createMockPublisher(newMockPublisherState()));
    expect(() => registerPublisher(simUnderPostizKey())).toThrowError(/registers only under the key/);
    expect(resolvePublisher("postiz").key).toBe("postiz");
    expect(isSimulatedPublisher(resolvePublisher("postiz"))).toBe(false);
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

describe("SCP-Sa / SCP-Sa2 · boot errors (each one ABORTS startup: a thrown error, never a warning)", () => {
  const safe: SocialSimulationBootFacts = {
    enabled: true, capabilityOverrides: {}, accountKindViolations: 0, simulatedAccountGrants: 0,
  };

  it("a clean database boots with the switch on", () => {
    expect(() => assertSocialSimulationBootSafe(safe)).not.toThrow();
  });

  it("SCP-Sa2 (was: refuses beside Postiz / a real-driver override / a live grant / a real account): the facts boot no longer reads cannot refuse; an override naming a REAL driver boots", () => {
    // Postiz configured, live grants and real accounts are not boot facts any more (SCP-D9: side by side). An override
    // naming `direct` routes REAL accounts to a real driver, which is allowed beside the simulator.
    expect(() => assertSocialSimulationBootSafe({ ...safe, capabilityOverrides: { "linkedin:*": "direct" } })).not.toThrow();
    expect(Object.keys(safe).sort()).toEqual(["accountKindViolations", "capabilityOverrides", "enabled", "simulatedAccountGrants"]);
  });

  it("SCP-Sa2: refuses the switch beside ANY account that breaks the account-kind rule", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, accountKindViolations: 1 })).toThrowError(SocialSimulationBootError);
    expect(() => assertSocialSimulationBootSafe({ ...safe, accountKindViolations: 2 })).toThrowError(/2 social_accounts row\(s\) break the account-kind rule/);
  });

  it("SCP-Sa2: refuses the switch beside ANY OAuth grant on a simulated account", () => {
    expect(() => assertSocialSimulationBootSafe({ ...safe, simulatedAccountGrants: 1 })).toThrowError(/1 social_oauth_tokens row\(s\) name a simulated account/);
  });

  it("refuses an override naming the simulator, switch ON or OFF (unchanged)", () => {
    for (const enabled of [true, false]) {
      expect(() => assertSocialSimulationBootSafe({ ...safe, enabled, capabilityOverrides: { "*:schedule": "simulated" } }))
        .toThrowError(/'\*:schedule' to 'simulated'/);
    }
  });

  it("with the switch off, nothing else is checked: a real deployment boots exactly as before", () => {
    expect(() => assertSocialSimulationBootSafe({
      enabled: false, capabilityOverrides: { "linkedin:*": "direct" }, accountKindViolations: 9, simulatedAccountGrants: 9,
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
    const readDbFacts = vi.fn(async () => ({ accountKindViolations: 0, simulatedAccountGrants: 0 }));
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
    const readDbFacts = vi.fn(async () => ({ accountKindViolations: 0, simulatedAccountGrants: 0 }));
    await wireSocialPublisher({ readDbFacts });
    expect(readDbFacts).toHaveBeenCalledTimes(1);
    expect(listPublishers().map((p) => p.key).sort()).toEqual(["direct", "simulated"]);
    expect(resolveSimulatedPublisher("schedule").key).toBe("simulated");
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n"))
      .toMatch(/^\[social:simulation-enabled\] SOCIAL_SIMULATION_ENABLED is ON/m);
  });

  it("SCP-Sa2: switch ON beside a row that breaks the kind rule or a grant on a simulated account: refuses BEFORE registering anything", async () => {
    setFlag(true);
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ accountKindViolations: 3, simulatedAccountGrants: 0 }) }))
      .rejects.toThrowError(SocialSimulationBootError);
    expect(listPublishers()).toHaveLength(0);
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ accountKindViolations: 0, simulatedAccountGrants: 1 }) }))
      .rejects.toThrowError(/name a simulated account/);
    expect(listPublishers()).toHaveLength(0);
  });

  it("SCP-Sa2 (was: refuses beside Postiz): switch ON with Postiz configured BOOTS, registering postiz, direct and the simulator side by side, and the warning names both", async () => {
    setFlag(true);
    config.social.publisher.baseUrl = "http://10.88.0.2:4007";
    await wireSocialPublisher({ readDbFacts: async () => ({ accountKindViolations: 0, simulatedAccountGrants: 0 }) });
    expect(listPublishers().map((p) => p.key).sort()).toEqual(["direct", "postiz", "simulated"]);
    expect(isSimulatedPublisher(resolvePublisher("postiz"))).toBe(false);
    expect(resolveSimulatedPublisher("schedule").key).toBe("simulated");
    expect(realPublisherKey()).toBe("postiz");
    expect((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n"))
      .toMatch(/Real accounts publish through 'postiz' beside it/);
  });

  it("SCP-Sa2 (was: refuses any override): switch ON with an override naming a REAL driver boots; one naming the simulator still refuses", async () => {
    setFlag(true);
    config.social.publisher.capabilityDrivers = { "linkedin:schedule": "direct" };
    await wireSocialPublisher({ readDbFacts: async () => ({ accountKindViolations: 0, simulatedAccountGrants: 0 }) });
    expect(listPublishers().map((p) => p.key).sort()).toEqual(["direct", "simulated"]);
    resetPublishers();
    config.social.publisher.capabilityDrivers = { "linkedin:schedule": "simulated" };
    await expect(wireSocialPublisher({ readDbFacts: async () => ({ accountKindViolations: 0, simulatedAccountGrants: 0 }) }))
      .rejects.toThrowError(/to 'simulated'/);
    expect(listPublishers()).toHaveLength(0);
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

  it("does not connect, sync or verify (SCP-Sb seeds accounts), reports metrics only for a simulated handle (SCP-Sd), and costs nothing", async () => {
    const d = createSimulatedPublisher({ guard: passGuard });
    expect([...d.capabilities].sort()).toEqual(["account_metrics", "cancel", "media_upload", "post_metrics", "post_status", "schedule"]);
    expect(await codeOf(d.connectUrl(simHandle(), "instagram", "https://x.invalid"))).toBe("capability_unsupported");
    expect(await codeOf(d.listIntegrations(simHandle()))).toBe("capability_unsupported");
    expect(await codeOf(d.verifyOrg(simHandle()))).toBe("capability_unsupported");
    // SCP-Sd: the metrics pair answers (simulated-metrics.test.ts), but behind the same switch and handle as every other method.
    setFlag(false);
    expect(await codeOf(d.getAccountMetrics(simHandle(), "i", { from: "2026-11-01", to: "2026-11-02" }))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    expect(await codeOf(d.getPostMetrics(simHandle(), ["x"]))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    setFlag(true);
    expect(await codeOf(d.getAccountMetrics(new OrgHandle("r", "o", "k"), "i", { from: "2026-11-01", to: "2026-11-02" })))
      .toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(await codeOf(d.getPostMetrics(new OrgHandle("r", "o", "k"), ["x"]))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
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

describe("SCP-Sa2 · runtime: with the switch ON, a REAL account may be connected (was: refused simulation_real_account_refused)", () => {
  beforeEach(() => setFlag(true));
  const GONE = "simulation_real_account_refused";

  it("the old refusal code is gone from the vocabulary", () => {
    expect(Object.values(SOCIAL_SIMULATION_REFUSAL)).not.toContain(GONE);
    expect(() => assertSimulatedWriteAllowed("x")).not.toThrow();
  });

  // Each readiness check now goes PAST the simulator to its own next (config-only) check, with no database read: the
  // answer is that check's code, never the simulator's. (The DB half, a real connect beside a simulated account, is
  // side-by-side.db.test.ts.)
  it("account connect readiness answers its own next check, not the simulator", async () => {
    const r = await checkConnectReadiness(T, ACCOUNT, "instagram");
    expect(r.reason).not.toBe(GONE);
    expect(r).toMatchObject({ ok: false, reason: "client_connect_requires_signoff" });
  });

  it("LinkedIn and YouTube connect readiness answer their own next check, not the simulator", async () => {
    expect((await checkLinkedInConnectReadiness(T, ACCOUNT)).reason).not.toBe(GONE);
    expect((await checkYouTubeConnectReadiness(T, ACCOUNT)).reason).not.toBe(GONE);
  });
});

describe("SCP-Sa · runtime: with the switch OFF, nothing writes a simulated mark", () => {
  beforeEach(() => setFlag(false));

  it("assertSimulatedWriteAllowed refuses simulation_disabled", async () => {
    expect(await codeOf(() => assertSimulatedWriteAllowed("x"))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
  });
});

// ── 3/4. SCP-Sa2: one kind per account, and the reverse fence ──────────────────────────────────────────────────────

describe("SCP-Sa2 · the reverse fence: a real path refuses a simulated account, switch on or off", () => {
  const REFUSED = SOCIAL_SIMULATION_REFUSAL.simulatedOnRealPublisher;
  for (const on of [true, false]) {
    it(`refuses on each independent signal (switch ${on ? "on" : "off"})`, async () => {
      setFlag(on);
      expect(realPublisherRefusal("x", { simulated: true })?.code).toBe(REFUSED);
      expect(realPublisherRefusal("x", { simulated: false, integrationId: "simulated:instagram" })?.code).toBe(REFUSED);
      expect(realPublisherRefusal("x", { providerPostId: "simulated:facebook:1:0b6a7a52-77c3-4c1f-9d0e-5f2d3f8e1a11" })?.code).toBe(REFUSED);
      expect(await codeOf(() => assertRealPublisherTarget("x", { simulated: true }))).toBe(REFUSED);
    });
  }

  it("passes a plainly real target, and never mistakes a near miss for the prefix", () => {
    expect(realPublisherRefusal("x", {})).toBeNull();
    expect(realPublisherRefusal("x", { simulated: false, integrationId: "ig_1234", providerPostId: "postiz-1" })).toBeNull();
    expect(realPublisherRefusal("x", { simulated: null, integrationId: null, providerPostId: null })).toBeNull();
    // `direct`'s sentinel and a case variant are real: the CHECK's LIKE is case-sensitive, and so is this.
    expect(realPublisherRefusal("x", { integrationId: "direct:linkedin" })).toBeNull();
    expect(realPublisherRefusal("x", { integrationId: "Simulated:instagram" })).toBeNull();
    expect(isSimulatedId("simulated")).toBe(false);
    expect(isSimulatedId(`${SIMULATED_ID_PREFIX}x`)).toBe(true);
  });

  it("the message names the path and the ruling, and the code renders 409", async () => {
    const e = realPublisherRefusal("real 'schedule' for account a1", { simulated: true })!;
    expect(e.message).toMatch(/^real 'schedule' for account a1: refused because its account is simulated/);
    expect(e.message).toMatch(/SCP-D9/);
  });

  it("a real account writer refuses a simulated integration id, and names a handle a simulated account holds", async () => {
    expect(await codeOf(() => assertRealIntegrationId("sync", "simulated:instagram"))).toBe(REFUSED_WRITE);
    expect(() => assertRealIntegrationId("sync", "ig_1234")).not.toThrow();
    expect(() => assertRealIntegrationId("sync", null)).not.toThrow();
    const e = realWriteOnSimulatedRow("account connect", "instagram", "@mock-kopi");
    expect(e.code).toBe(REFUSED_WRITE);
    expect(e.message).toMatch(/'@mock-kopi' belongs to a simulated account/);
  });
});
const REFUSED_WRITE = SOCIAL_SIMULATION_REFUSAL.simulatedOnRealPublisher;

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
/** The file that writes `simulated = true` accounts behind fence 4 (SCP-Sb's seed). */
const SIMULATED_ACCOUNT_WRITER = "modules/social/simulated-accounts.ts";
/** SCP-Sb's prepare script: the one other writer of the mark. It runs BEFORE the switch is on (boot refuses the switch beside any
 *  non-simulated row), so it cannot sit behind fence 4; the test below pins what it may do instead. */
const SIMULATED_PREPARE_SCRIPT = "seed/social-simulation-prepare.ts";
const sqlLiterals = (src: string) => [...src.matchAll(/`[^`]*`/g)].map((m) => m[0]);
/** SCP-Sa2 — every SQL statement in `src` that starts with `re`, read from the match to the closing backtick of its template
 *  literal. Independent of backtick pairing in comments (which `sqlLiterals` depends on). */
const statementsAt = (src: string, re: RegExp): string[] =>
  [...src.matchAll(new RegExp(re.source, "g"))].map((m) => src.slice(m.index ?? 0, src.indexOf("`", m.index ?? 0)));
/** SCP-Sa2 — does this statement WRITE an account's mark (a SET of `simulated` to anything but false, or an INSERT naming
 *  the column)? A real writer may READ the mark in its WHERE (`simulated = false`, the fence); that is not a write. */
const writesAccountMark = (stmt: string): boolean =>
  /\bsimulated\s*=(?!\s*false\b)/.test(stmt) || /INSERT\s+INTO\s+social_accounts\s*\([^)]*\bsimulated\b/.test(stmt);
/** SCP-3b (2026-10-29) — the same test for a variant's mark: clearing it (`simulated = false`) is not a write of it. */
const writesVariantMark = (stmt: string): boolean =>
  /\bsimulated\s*=(?!\s*false\b)/.test(stmt) || /INSERT\s+INTO\s+social_post_variants\s*\([^)]*\bsimulated\b/.test(stmt);
/** Source without its comments, for "who CALLS this" inventories (a comment that names a function is not a call). */
const codeOnly = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("SCP-Sa · static inventory of the writers (src/, tests excluded)", () => {
  const files = sourceFiles();

  it("found the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(rel)).toContain("modules/social/dispatch.ts");
  });

  it("SCP-Sa2 (was: every real writer refuses under the switch): every REAL writer of social_accounts can never land on a simulated row", () => {
    const writers = files.filter((f) => /\b(INSERT\s+INTO|UPDATE)\s+social_accounts\b/.test(readFileSync(f, "utf8")));
    expect(writers.map(rel).sort()).toEqual([
      "modules/social/publisher/linkedin-oauth.ts",
      "modules/social/publisher/provisioning.ts",
      "modules/social/publisher/youtube-oauth.ts",
      "modules/social/simulated-accounts.ts",
      "seed/portal-engagement.ts",
      "seed/social-simulation-prepare.ts",
    ]);
    for (const f of writers) {
      // SCP-Sb's seed and the prepare script are the writers of SIMULATED accounts: pinned by the next test instead.
      if (rel(f) === SIMULATED_ACCOUNT_WRITER || rel(f) === SIMULATED_PREPARE_SCRIPT) continue;
      const src = readFileSync(f, "utf8");
      const stmts = statementsAt(src, /\b(?:INSERT\s+INTO|UPDATE)\s+social_accounts\b/);
      expect(stmts.length, rel(f)).toBeGreaterThan(0);
      for (const stmt of stmts) {
        // A real writer never writes the mark (it may READ it in a WHERE: that is the fence).
        expect(writesAccountMark(stmt), `${rel(f)}: ${stmt.slice(0, 60)}`).toBe(false);
        // Every conflict update that could land on an existing row is fenced off simulated rows.
        if (/ON\s+CONFLICT[\s\S]*DO\s+UPDATE/.test(stmt)) expect(stmt, rel(f)).toMatch(/WHERE social_accounts\.simulated = false/);
        // Every UPDATE of social_accounts in a real writer names `simulated = false` in its WHERE.
        if (/^UPDATE\s+social_accounts\b/.test(stmt)) expect(stmt, rel(f)).toMatch(/\bsimulated = false\b/);
      }
    }
    // The portal seed inserts with no integration id and no mark: it can only ever write the real kind.
    const portal = statementsAt(readFileSync(join(SRC, "seed", "portal-engagement.ts"), "utf8"), /\bINSERT\s+INTO\s+social_accounts\b/);
    expect(portal).toHaveLength(1);
    expect(portal[0]).not.toMatch(/simulated|postiz_integration_id|ON\s+CONFLICT/);
  });

  it("the ONLY statement that writes a variant's `simulated` mark is dispatch.ts's stamp; the ONLY account-mark writers are SCP-Sb's seed and its prepare script", () => {
    const variantMarkWriters: string[] = [];
    const variantMarkClearers: string[] = [];
    const accountMarkWriters: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const lit of sqlLiterals(src)) {
        if (!/\bsimulated\b/.test(lit)) continue;
        if (/\b(INSERT\s+INTO|UPDATE)\s+social_post_variants\b/.test(lit)) (writesVariantMark(lit) ? variantMarkWriters : variantMarkClearers).push(rel(f));
      }
      // SCP-Sa2: real writers now READ the mark in their WHERE (the fence), so an account-mark WRITER is a statement that
      // sets it or inserts it, not one that merely names it.
      for (const stmt of statementsAt(src, /\b(?:INSERT\s+INTO|UPDATE)\s+social_accounts\b/)) {
        if (writesAccountMark(stmt)) accountMarkWriters.push(rel(f));
      }
    }
    expect(variantMarkWriters).toEqual(["modules/social/dispatch.ts"]);
    // SCP-3b (2026-10-29): the mark is CLEARED where the result it records is thrown away, so a post posted by hand after a
    // `[simulate-fail]` is not `simulated`: the unschedule reset and the officer's hand-post (a variant the simulator did not
    // publish). Nothing else clears it; a third clearer fails here until it is looked at.
    expect(variantMarkClearers).toEqual(["modules/social/pipeline/pipeline-effects.ts", "modules/social/pipeline/pipeline-effects.ts"]);
    const effects = sqlLiterals(readFileSync(join(SRC, "modules", "social", "pipeline", "pipeline-effects.ts"), "utf8")).filter((l) => /\bsimulated\b/.test(l) && /UPDATE\s+social_post_variants\b/.test(l));
    expect(effects[0]).toMatch(/SET status = 'draft', approval_id = NULL, provider_post_id = NULL, simulated = false, updated_at = now\(\)/);
    expect(effects[1]).toMatch(/SET simulated = false, updated_at = now\(\)\s+WHERE tenant_id = \$1 AND post_id = \$2 AND deleted_at IS NULL AND simulated AND status <> 'published'/);
    // SCP-Sb's seed is the ONE writer of an account's mark: it calls `assertSimulatedWriteAllowed` before it writes, and its
    // controller calls it again before the body is read. A second writer fails here until it is fenced the same way.
    expect([...new Set(accountMarkWriters)].sort()).toEqual([SIMULATED_ACCOUNT_WRITER, SIMULATED_PREPARE_SCRIPT]);
    // The prepare script only ever turns the mark ON, on rows that are off and never reached an engine, inserts nothing
    // and deletes nothing. SCP-Sa2: it writes the simulated integration id in the same statement (social_accounts_kind_ck).
    const prepare = sqlLiterals(readFileSync(join(SRC, SIMULATED_PREPARE_SCRIPT), "utf8")).join(" "); // the SQL literals only: the header quotes the statement
    expect(prepare.match(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+social_\w+/g)).toEqual(["UPDATE social_accounts"]);
    expect(prepare).toMatch(
      /UPDATE social_accounts SET simulated = true, postiz_integration_id = '\$\{SIMULATED_ID_PREFIX\}' \|\| network, updated_at = now\(\) WHERE tenant_id = \$1 AND simulated = false AND postiz_integration_id IS NULL AND connected_by IS NULL AND id = ANY/,
    );
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

  it("the one road in has exactly three on-ramps: the dispatch resolver, the status sweep and (SCP-Sd) the metrics sweep", () => {
    const callers = files
      .filter((f) => !f.endsWith(`${sep}registry.ts`))
      .filter((f) => /\bresolveSimulatedPublisher\(/.test(readFileSync(f, "utf8")));
    // SCP-Sd added metrics-job.ts DELIBERATELY: the simulated numbers must travel the same seam a real engine's do (the sweep
    // resolves the simulator for a simulated account and writes the answer), not a side door beside it. Its call sits behind
    // `isSocialSimulationEnabled()` and is made only for an account whose `social_accounts.simulated` is true (metrics-job.ts).
    expect(callers.map(rel).sort()).toEqual([
      "modules/social/metrics-job.ts",
      "modules/social/post-status-sync-job.ts",
      "modules/social/publisher/provisioning.ts",
    ]);
  });

  it("SCP-Sd: the ONLY statements that write a simulated metric row are metrics-job.ts's two simulated writers, each behind the switch", () => {
    // A SQL literal that INSERTs into a metrics table and names the 'simulated' source. A second writer fails here until fenced.
    const writers: string[] = [];
    for (const f of files) {
      for (const lit of sqlLiterals(readFileSync(f, "utf8"))) {
        if (/\bINSERT\s+INTO\s+social_(post_metrics|metrics_daily)\b/.test(lit) && /'simulated'/.test(lit)) writers.push(rel(f));
      }
    }
    expect(writers).toEqual(["modules/social/metrics-job.ts", "modules/social/metrics-job.ts"]);
    const job = readFileSync(join(SRC, "modules", "social", "metrics-job.ts"), "utf8");
    for (const fn of ["applySimulatedDailyMetrics", "appendSimulatedPostMetrics"]) {
      const body = job.slice(job.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 400), fn).toMatch(/assertSimulatedWriteAllowed\(/);
    }
    // And the two REAL writers never name the simulated source.
    for (const fn of ["applyAccountDailyMetrics", "appendPostMetrics"]) {
      const start = job.indexOf(`export async function ${fn}`);
      const body = job.slice(start, job.indexOf("\n}\n", start));
      expect(body, fn).not.toMatch(/simulated/i);
    }
  });

  it("SCP-Sa2 · the reverse fence: every real path that hands a variant or account to a real engine asks it", () => {
    // `openOrg(` hands back a REAL engine. Its callers are pinned so a new one fails here until it is reviewed: each
    // that serves a variant or an account must ask the reverse fence. best-time.ts only reads the driver's capability set
    // (no engine call), and provisioning.ts's own callers are org-level (verify, sync, connect), fenced as writers above.
    const openOrgCallers = files.filter((f) => /\bopenOrg\(/.test(codeOnly(readFileSync(f, "utf8")))).map(rel).sort();
    expect(openOrgCallers).toEqual([
      "modules/social/best-time.ts",
      "modules/social/creator-info-verifier.ts",
      "modules/social/metrics-job.ts",
      "modules/social/post-status-sync-job.ts",
      "modules/social/publisher/provisioning.ts",
    ]);
    for (const f of ["modules/social/creator-info-verifier.ts", "modules/social/metrics-job.ts", "modules/social/post-status-sync-job.ts", "modules/social/pipeline/pipeline-effects.ts"]) {
      expect(readFileSync(join(SRC, f), "utf8"), f).toMatch(/\b(realPublisherRefusal|assertRealPublisherTarget)\(/);
    }
    // The dispatch resolver: the reverse fence sits on the REAL branch, after the fork to the simulator and before any
    // real driver is resolved.
    const prov = readFileSync(join(SRC, "modules", "social", "publisher", "provisioning.ts"), "utf8");
    const body = prov.slice(prov.indexOf("export async function resolveDispatchOrgHandle"));
    const fork = body.indexOf("resolveSimulatedPublisher(capability)");
    const fence = body.indexOf("assertRealPublisherTarget(");
    const real = body.indexOf("resolvePublisherForCapability(");
    expect(fork).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(fork);
    expect(real).toBeGreaterThan(fence);
    // The status sweep fences its real groups BEFORE it opens the real driver for them, and the webhook intake too.
    const sweep = readFileSync(join(SRC, "modules", "social", "post-status-sync-job.ts"), "utf8");
    const tenantSweep = sweep.slice(sweep.indexOf("export async function reconcileTenantPostStatus"));
    expect(tenantSweep.indexOf("refuseSimulatedOnRealGroup(")).toBeGreaterThan(-1);
    expect(tenantSweep.indexOf("refuseSimulatedOnRealGroup(")).toBeLessThan(tenantSweep.indexOf("openStatusDriver("));
    const intake = sweep.slice(sweep.indexOf("export async function reconcileOneProviderPost"));
    expect(intake.indexOf("realPublisherRefusal(")).toBeGreaterThan(-1);
    expect(intake.indexOf("realPublisherRefusal(")).toBeLessThan(intake.indexOf("openStatusDriver("));
    // The metrics sweep fences both real halves before `openOrg`.
    const job = readFileSync(join(SRC, "modules", "social", "metrics-job.ts"), "utf8");
    const halves = job.slice(job.indexOf("export async function pullTenantMetrics"));
    const firstOpen = halves.indexOf("openOrg(");
    const secondOpen = halves.indexOf("openOrg(", firstOpen + 1);
    expect(halves.indexOf("assertRealPublisherTarget(")).toBeLessThan(firstOpen);
    expect(halves.indexOf("realPublisherRefusal(")).toBeGreaterThan(firstOpen);
    expect(halves.indexOf("realPublisherRefusal(")).toBeLessThan(secondOpen);
    // And dispatch.ts never sends a simulated chain to the real creator-info probe.
    expect(readFileSync(join(SRC, "modules", "social", "dispatch.ts"), "utf8")).toMatch(/preview\.chain && !preview\.chain\.simulated\)/);
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
      await wireSocialPublisher({ readDbFacts: async () => ({ accountKindViolations: 0, simulatedAccountGrants: 0 }) });
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
    ["simulated_account_on_real_publisher", 409],
    ["simulation_disabled", 409],
    ["simulated_account_required", 409],
    ["simulated_approval_not_decided", 409],
    ["simulated_publish_failed", 502],
  ] as const)("%s -> %i, with the code in the body", (code, status) => {
    expect(render(new SocialPublisherError(code, "why"))).toEqual({ status, body: { error: "why", code } });
  });
});
