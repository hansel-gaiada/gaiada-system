// PRV-02 — the `provision-http` driver, driven over REAL SOCKETS against the PRV-00 mock.
//
// No stubbed `fetch` anywhere in this file. The mock is a `node:http` server on 127.0.0.1:0 and the
// driver talks to it with the same code path production uses, so the things that actually break in
// an HTTP client — header shape, body encoding, status handling, the 401 re-login dance, timeouts,
// connection failures — are exercised rather than asserted about.
//
// Nothing here can reach the real `provision.gaiada.online`: every base URL is the mock's ephemeral
// origin, and `egress-inventory.test.ts` separately pins that no production file hardcodes that host.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMockProvision, type ProvisionMock } from "../../testing/mock-provision";
import { config } from "../../config";
import { ProvisionHttpDriver, createProvisionHttpDriver } from "./provision-http";
import { ProvisionEgressError, ProvisionNotConfiguredError } from "./provision-provider";

const EMAIL = "erp-service@gaiada.com";
const PASSWORD = "correct-horse-battery-staple";

let mock: ProvisionMock;

const driverFor = (overrides: Partial<ConstructorParameters<typeof ProvisionHttpDriver>[0]> = {}) =>
  new ProvisionHttpDriver({
    baseUrl: mock.origin,
    serviceEmail: EMAIL,
    servicePassword: PASSWORD,
    timeoutMs: 5000,
    retryAttempts: 1,
    retryBaseDelayMs: 1,
    ...overrides,
  });

describe("PRV-02 — provision-http driver (real sockets vs the PRV-00 mock)", () => {
  beforeAll(async () => {
    mock = await startMockProvision({ serviceEmail: EMAIL, servicePassword: PASSWORD });
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => mock.resetHitCounts());

  it("creates a project and returns the correlation key + URLs", async () => {
    const d = driverFor();
    const r = await d.createProject({ name: "acme-site-a", framework: "vite", devName: "Manager Mo" });
    expect(r.outcome).toBe("accepted");
    if (r.outcome !== "accepted") return;
    // Row CONTENT, not just "it worked": provider_ref is what every later poll and every ownership
    // decision keys on, so an empty/undefined id here would silently disarm the whole 409 rule.
    expect(r.project.id).toBeTruthy();
    expect(r.project.name).toBe("acme-site-a");
    expect(r.project.status).toBe("pending");
    expect(r.project.repoUrl).toBe("https://github.com/gaiadabali/acme-site-a");
    expect(r.project.stagingUrl).toBe("https://acme-site-a.gaiada.online");
  });

  it("logs in exactly ONCE for a burst of concurrent calls (no session stampede)", async () => {
    const d = driverFor();
    await Promise.all([
      d.createProject({ name: "burst-1", framework: "vite", devName: "Mo" }),
      d.createProject({ name: "burst-2", framework: "vite", devName: "Mo" }),
      d.createProject({ name: "burst-3", framework: "vite", devName: "Mo" }),
    ]);
    expect(mock.hitCount("login")).toBe(1);
    expect(mock.hitCount("provision")).toBe(3);
  });

  it("caches the session across calls and re-logs-in exactly once after a 401", async () => {
    const d = driverFor();
    await d.createProject({ name: "cache-a", framework: "vite", devName: "Mo" });
    expect(mock.hitCount("login")).toBe(1);
    await d.getProject("nope-not-a-project");
    expect(mock.hitCount("login")).toBe(1); // reused, not re-minted

    // Force the far side to reject our cached token by restarting its session identity.
    const stale = await startMockProvision({ serviceEmail: EMAIL, servicePassword: PASSWORD });
    try {
      const d2 = new ProvisionHttpDriver({
        baseUrl: stale.origin, serviceEmail: EMAIL, servicePassword: PASSWORD,
        timeoutMs: 5000, retryAttempts: 1, retryBaseDelayMs: 1,
      });
      await d2.createProject({ name: "reauth-1", framework: "vite", devName: "Mo" });
      expect(stale.hitCount("login")).toBe(1);
      // Poison the cached token: private, so reach it the way a real expiry would — by pointing the
      // driver at a NEW server instance that never issued this token.
      const rotated = await startMockProvision({ serviceEmail: EMAIL, servicePassword: PASSWORD });
      try {
        d2.setBaseUrlForTests(rotated.origin);
        const r = await d2.createProject({ name: "reauth-2", framework: "vite", devName: "Mo" });
        expect(r.outcome).toBe("accepted");
        // One 401, then exactly one re-login, then the retried call. Never a login loop.
        expect(rotated.hitCount("login")).toBe(1);
        expect(rotated.hitCount("provision")).toBe(2); // the 401'd attempt + the retried one
      } finally {
        await rotated.close();
      }
    } finally {
      await stale.close();
    }
  });

  it("returns `conflict` (never throws) when the name is taken, and reads back the far-side record", async () => {
    mock.seedProject({
      id: "proj-foreign-9", name: "taken-name", repoUrl: "https://github.com/gaiadabali/taken-name",
      stagingUrl: "https://taken-name.gaiada.online", status: "live", isOurs: false,
    });
    const d = driverFor();
    const r = await d.createProject({ name: "taken-name", framework: "vite", devName: "Mo" });
    expect(r.outcome).toBe("conflict");
    if (r.outcome !== "conflict") return;
    expect(r.existing?.id).toBe("proj-foreign-9");
    // The driver reads the record so the SERVICE can test ownership against the ERP's own table.
    // It does not, and must not, forward any far-side ownership claim.
    expect(JSON.stringify(r.existing)).not.toContain("isOurs");
  });

  it("returns `rejected` (never throws) for a 400 — an HTTP answer is data, not an exception", async () => {
    const d = driverFor();
    // The mock validates `framework` server-side; cast past the compile-time narrowing on purpose.
    const r = await d.createProject({ name: "bad-fw", framework: "wordpress" as "vite", devName: "Mo" });
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.status).toBe(400);
    expect(r.reason).toContain("framework");
  });

  it("WSK-D28 / §08: translates the canonical aliases (astro/node) to provision's own wire vocabulary " +
    "(vite/nextjs) rather than forwarding them literally", async () => {
    const d = driverFor();
    const astroResult = await d.createProject({ name: "canonical-astro", framework: "astro", devName: "Mo" });
    expect(astroResult.outcome).toBe("accepted"); // a literal "astro" would 400 against the mock
    const nodeResult = await d.createProject({ name: "canonical-node", framework: "node", devName: "Mo" });
    expect(nodeResult.outcome).toBe("accepted"); // a literal "node" would 400 against the mock
  });

  it("WSK-D28 / §08: `wp` is refused at THIS driver's own capability boundary — honestly, and " +
    "without ever reaching the far side over the wire (provision cannot build it, full stop)", async () => {
    const d = driverFor();
    const r = await d.createProject({ name: "wp-site", framework: "wp", devName: "Mo" });
    expect(r.outcome).toBe("rejected");
    if (r.outcome !== "rejected") return;
    expect(r.status).toBe(422);
    expect(r.reason).toMatch(/WordPress|webdesk provider/i);
    expect(mock.hitCount("provision")).toBe(0);
  });

  it("finds by name exactly, and returns null for a free name", async () => {
    const d = driverFor();
    await d.createProject({ name: "findable-site", framework: "nextjs", devName: "Mo" });
    const found = await d.findProjectByName("findable-site");
    expect(found?.name).toBe("findable-site");
    expect(await d.findProjectByName("definitely-free-name")).toBeNull();
  });

  it("polls a project by id and reflects the far side's progression", async () => {
    const d = driverFor();
    const created = await d.createProject({ name: "progress-site", framework: "vite", devName: "Mo" });
    if (created.outcome !== "accepted") throw new Error("setup failed");
    expect((await d.getProject(created.project.id))?.status).toBe("pending");
    mock.progressStatus(created.project.id, "provisioned");
    expect((await d.getProject(created.project.id))?.status).toBe("provisioned");
    mock.progressStatus(created.project.id, "live");
    const live = await d.getProject(created.project.id);
    expect(live?.status).toBe("live");
    expect(live?.stagingUrl).toBe("https://progress-site.gaiada.online");
  });

  it("returns null (not an error) for a project the far side no longer knows about", async () => {
    expect(await driverFor().getProject("proj-does-not-exist")).toBeNull();
  });

  // ── Fail-closed + credential hygiene ───────────────────────────────────────────────────────────

  it("refuses to construct without a base URL or a credential — fail-closed, no default endpoint", () => {
    expect(() => driverFor({ baseUrl: "" })).toThrow(ProvisionNotConfiguredError);
    expect(() => driverFor({ serviceEmail: "" })).toThrow(ProvisionNotConfiguredError);
    expect(() => driverFor({ servicePassword: "" })).toThrow(ProvisionNotConfiguredError);
  });

  it("createProvisionHttpDriver() is fail-closed on unset env and has NO default endpoint", () => {
    const saved = { ...config.provision };
    try {
      config.provision.baseUrl = "";
      config.provision.serviceEmail = "";
      config.provision.servicePassword = "";
      expect(() => createProvisionHttpDriver()).toThrow(ProvisionNotConfiguredError);
      // Half-configured is UNCONFIGURED, not "partly working".
      config.provision.baseUrl = "https://example.invalid";
      expect(() => createProvisionHttpDriver()).toThrow(ProvisionNotConfiguredError);
      config.provision.serviceEmail = EMAIL;
      expect(() => createProvisionHttpDriver()).toThrow(ProvisionNotConfiguredError);
    } finally {
      Object.assign(config.provision, saved);
    }
  });

  it("a wrong credential fails loudly and NEVER echoes the credential", async () => {
    const d = driverFor({ servicePassword: "wrong-password-value" });
    await expect(d.createProject({ name: "x", framework: "vite", devName: "Mo" }))
      .rejects.toBeInstanceOf(ProvisionEgressError);
    try {
      await d.createProject({ name: "x", framework: "vite", devName: "Mo" });
    } catch (err) {
      const text = `${(err as Error).message}\n${(err as Error).stack ?? ""}`;
      expect(text).not.toContain("wrong-password-value");
      expect(text).not.toContain(PASSWORD);
    }
  });

  it("a dead host raises a transport error whose message carries no credential", async () => {
    // Port 1 on loopback: connection refused immediately, no DNS involved, no real network egress.
    const d = driverFor({ baseUrl: "http://127.0.0.1:1", retryAttempts: 2, retryBaseDelayMs: 1 });
    await expect(d.createProject({ name: "dead", framework: "vite", devName: "Mo" }))
      .rejects.toBeInstanceOf(ProvisionEgressError);
    try {
      await d.createProject({ name: "dead", framework: "vite", devName: "Mo" });
    } catch (err) {
      expect((err as Error).message).not.toContain(PASSWORD);
      expect((err as Error).message).toContain("attempt(s)");
    }
  });

  it("the driver's own enumerable surface carries no credential (nothing serializes a secret)", async () => {
    const d = driverFor();
    await d.createProject({ name: "serialize-probe", framework: "vite", devName: "Mo" });
    const dumped = JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? "";
    expect(dumped).not.toContain(PASSWORD);
    // The minted session token must not be serializable off the instance either.
    expect(dumped).not.toContain("mock-jwt-");
  });

  it("never re-POSTs a create in response to an HTTP ANSWER (only transport failures retry)", async () => {
    // Three retry attempts configured; a 400 answer must still produce exactly ONE POST. A blind
    // retry of an answered create is how one approved request becomes two GitHub repos.
    const d = driverFor({ retryAttempts: 3 });
    mock.resetHitCounts();
    const r = await d.createProject({ name: "answered-once", framework: "php" as "vite", devName: "Mo" });
    expect(r.outcome).toBe("rejected");
    expect(mock.hitCount("provision")).toBe(1);
  });
});
