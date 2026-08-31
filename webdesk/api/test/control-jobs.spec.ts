// WSK-21 — "long-running commands job-tracked and queryable" (ticket AC) + the §06 contract-read
// not-yet-available surface. Two app instances are built: the DEFAULT one (using
// NotYetAvailableReleaseTransport, control.module.ts's real default binding — proves a release
// command still completes its OWN job lifecycle correctly even though the transport itself has
// nothing to talk to yet) and a SECOND one with RELEASE_TRANSPORT overridden by a fake adapter
// (proves the full succeeded path, incl. the `releases` table write, without inventing a real
// deploy target — WSK-25/26'/29's job per design WSK-D26).
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK21_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55490/webdesk";
process.env.API_KEY_PEPPER = "wsk21-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { RELEASE_TRANSPORT, type ReleaseTransportAdapter, type ReleaseTransportInput, type ReleaseTransportResult } from "../src/control/release/release-transport";

const MIGRATOR_URL =
  process.env.WSK21_MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk";

class FakeSucceedingReleaseTransport implements ReleaseTransportAdapter {
  readonly calls: ReleaseTransportInput[] = [];
  async execute(input: ReleaseTransportInput): Promise<ReleaseTransportResult> {
    this.calls.push(input);
    return { ok: true, detail: `fake ${input.kind} ok` };
  }
}

async function buildControlApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  return app;
}

async function buildControlAppWithFakeTransport(fake: ReleaseTransportAdapter): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule] })
    .overrideProvider(RELEASE_TRANSPORT)
    .useValue(fake)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  return app;
}

function headers(opts: { scopes: string[]; ws4?: string; idempotencyKey?: string; subject?: string }) {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": opts.subject ?? "wsk21-jobs-test",
    "x-webdesk-control-scopes": opts.scopes.join(","),
  };
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  if (opts.idempotencyKey) h["idempotency-key"] = opts.idempotencyKey;
  return h;
}

function freshSlug() {
  return `wsk21-jobs-${randomUUID().slice(0, 8)}`;
}

async function withTenant<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

async function provisionTenantSiteEnv(app: NestFastifyApplication) {
  const slug = freshSlug();
  const provision = await app.inject({
    method: "POST",
    url: "/control/v1/tenants",
    headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
    payload: { slug, companyRef: randomUUID() },
  });
  const tenantId = provision.json().tenant.id as string;

  const site = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites`,
    headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
    payload: { kind: "astro", name: "release-test-site" },
  });
  const siteId = site.json().site.id as string;

  const env = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
    headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
    payload: { name: "staging" },
  });
  const envId = env.json().environment.id as string;

  return { slug, tenantId, siteId, envId };
}

async function waitForTerminal(app: NestFastifyApplication, slug: string, jobId: string, subject: string) {
  const deadline = Date.now() + 5000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await app.inject({
      method: "GET",
      url: `/control/v1/tenants/${slug}/jobs/${jobId}`,
      headers: headers({ scopes: ["webdesk:read"], subject }),
    });
    const job = res.json();
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach a terminal state in time (last status: ${job.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("control-plane release commands — job-tracked, non-blocking, idempotent", () => {
  describe("default transport (NotYetAvailableReleaseTransport — the shipped binding)", () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await buildControlApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it("release.deploy returns a jobId immediately (does not block on the transport)", async () => {
      const { slug, envId } = await provisionTenantSiteEnv(app);
      const started = Date.now();
      const res = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/${slug}/environments/${envId}/deploy`,
        headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
        payload: { version: "1.0.0" },
      });
      const elapsedMs = Date.now() - started;
      expect(res.statusCode).toBe(201);
      expect(typeof res.json().jobId).toBe("string");
      expect(elapsedMs).toBeLessThan(500); // the transport call itself is fire-and-forget

      const job = await waitForTerminal(app, slug, res.json().jobId, "wsk21-jobs-test");
      expect(job.status).toBe("failed"); // default transport always throws — documented, not a bug
      expect(job.error.code).toBe("TRANSPORT_NOT_AVAILABLE");
    });

    it("double-fire with the SAME idempotency key returns the SAME jobId, not a second job", async () => {
      const { slug, envId, tenantId } = await provisionTenantSiteEnv(app);
      const idempotencyKey = randomUUID();
      const hdrs = headers({ scopes: ["webdesk:operate"], idempotencyKey });

      const first = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/${slug}/environments/${envId}/rebuild`,
        headers: hdrs,
      });
      const second = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/${slug}/environments/${envId}/rebuild`,
        headers: hdrs,
      });
      expect(first.json().jobId).toBe(second.json().jobId);
      expect(second.json().replayed).toBe(true);

      await waitForTerminal(app, slug, first.json().jobId, "wsk21-jobs-test");

      const list = await app.inject({
        method: "GET",
        url: `/control/v1/tenants/${slug}/jobs`,
        headers: headers({ scopes: ["webdesk:read"] }),
      });
      const rebuildJobs = list.json().jobs.filter((j: { command: string }) => j.command === "release.triggerRebuild");
      expect(rebuildJobs).toHaveLength(1); // ONE job, not two, despite two HTTP calls

      // rebuild has no `releases.kind` value in the CHECK constraint — confirm no row was invented for it.
      const releaseCount = await withTenant(tenantId, async (client) => {
        const { rows } = await client.query("SELECT count(*)::int AS n FROM releases WHERE env_id = $1", [envId]);
        return rows[0].n as number;
      });
      expect(releaseCount).toBe(0);
    });

    it("release.promote is HIGH-impact — refused without a WS4 assertion", async () => {
      const { slug, envId } = await provisionTenantSiteEnv(app);
      const res = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/${slug}/environments/${envId}/promote`,
        headers: headers({ scopes: ["webdesk:promote"], idempotencyKey: randomUUID() }), // no ws4
        payload: { version: "1.0.0" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("fake succeeding transport (proves the terminal 'succeeded' path + the releases table write)", () => {
    let app: NestFastifyApplication;
    let fake: FakeSucceedingReleaseTransport;

    beforeAll(async () => {
      fake = new FakeSucceedingReleaseTransport();
      app = await buildControlAppWithFakeTransport(fake);
    });

    afterAll(async () => {
      await app.close();
    });

    it("release.promote succeeds end-to-end and writes exactly one releases row (kind='promote')", async () => {
      const { slug, envId, tenantId } = await provisionTenantSiteEnv(app);
      const res = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/${slug}/environments/${envId}/promote`,
        headers: headers({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
        payload: { version: "2.3.1" },
      });
      expect(res.statusCode).toBe(201);

      const job = await waitForTerminal(app, slug, res.json().jobId, "wsk21-jobs-test");
      expect(job.status).toBe("succeeded");

      const releaseRows = await withTenant(tenantId, async (client) => {
        const { rows } = await client.query("SELECT kind, version FROM releases WHERE env_id = $1", [envId]);
        return rows;
      });
      expect(releaseRows).toHaveLength(1);
      expect(releaseRows[0]).toMatchObject({ kind: "promote", version: "2.3.1" });
      expect(fake.calls.some((c) => c.kind === "promote" && c.version === "2.3.1")).toBe(true);
    });
  });
});

describe("control-plane contract read — §06 surface (WSK-15 LANDED: 501 -> 404 when nothing generated)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildControlApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // UPDATED by coordinator when WSK-15 landed. This test previously asserted 501
  // ("codegen does not exist"). WSK-15 replaced that stub, so for a tenant with no generated
  // contract the honest answer is 404 `contract-not-generated` — the resource is absent, not
  // the capability. The invariant this test actually protects is unchanged and is the point:
  // **never a fabricated artifact**, and the read is always audited.
  it("GET .../contract returns a documented 404 when nothing is generated, never a fabricated artifact, and writes an audit row", async () => {
    const { slug, tenantId } = await provisionTenantSiteEnv(app);
    const res = await app.inject({
      method: "GET",
      url: `/control/v1/tenants/${slug}/contract`,
      headers: headers({ scopes: ["webdesk:read"] }),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.status).toBe(404);
    expect(body.type).toMatch(/contract-not-generated$/);
    // The load-bearing assertion: no artifact URLs, no contentHash, nothing invented.
    expect(body.artifacts).toBeUndefined();
    expect(body.contentHash).toBeUndefined();

    const auditCount = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND action = 'control.contract.read'`,
        [tenantId],
      );
      return rows[0].n as number;
    });
    expect(auditCount).toBe(1);
  });
});
