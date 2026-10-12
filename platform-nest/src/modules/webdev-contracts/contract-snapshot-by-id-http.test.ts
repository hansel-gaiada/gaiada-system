// M6-P4a — GET contracts/:snapshotId and GET contracts/:snapshotId/artifacts/:artifact, in the same
// ISOLATED-app posture as `contract-snapshots-http.test.ts` (only `ContractSnapshotsController` is
// mounted; real controller -> real service -> real Postgres incl. the third wall; only the Zone B
// egress is faked). Storage is swapped for an in-memory backend so the tamper case can rewrite a
// stored object without touching disk.
//
// What this file is trying to falsify:
//   1. another tenant's snapshot id, an unknown id and a malformed id are all 404 (never the row);
//   2. each of the five artifacts (M6-P4b0 added `blockLibrary`) comes back as bytes whose sha256 equals the
//      hash recorded at mirror time, and the SDK files carry their real types (text/plain, text/x-php);
//   3. the artifact route can only name one of five stored artifacts (400 otherwise) — the file id is
//      resolved from the snapshot's own pointer, never from the caller;
//   4. a null sdkPhp or blockLibrary pointer is a 404 with the distinct reason `artifact_absent`;
//   5. `read` is enforced (plain member denied) and the hub's OBO path (verified n8n link, assurance
//      "linked") satisfies the policy's `notLow` while an unenrolled OBO identity (anonymous) does not;
//   6. a tampered stored object is refused as `artifact_hash_mismatch`, never served.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { setStorageForTest, localStorage } from "../../core/storage";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../../testing/fixtures";
import { ContractSnapshotsController, setWebdevControlProviderForTests } from "./contract-snapshots.controller";
import { computeContentHash } from "./contract-snapshot.service";
import type { ContractBundleMeta, WebdevControlProvider } from "./contract-fetch-provider";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function providerFor(version: string, seed: string, withPhp: boolean, withBlocks = false): WebdevControlProvider {
  const set = {
    sdkTs: Buffer.from(`sdk-${seed}`),
    openapi: Buffer.from(`openapi-${seed}`),
    contractMd: Buffer.from(`md-${seed}`),
    sdkPhp: withPhp ? Buffer.from(`<?php // sdk ${seed}`) : null,
  };
  const { contentHash } = computeContentHash(set);
  const meta: ContractBundleMeta = {
    version,
    vocabularyVersion: "1.2.0",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
    artifacts: {
      sdkTsUrl: "fixture://sdk",
      sdkPhpUrl: withPhp ? "fixture://php" : null,
      openapiUrl: "fixture://openapi",
      contractMdUrl: "fixture://md",
      blockLibraryUrl: withBlocks ? "fixture://blocks" : null,
    },
    contentHash,
    generatedAt: new Date().toISOString(),
  };
  const byUrl: Record<string, Buffer> = {
    "fixture://sdk": set.sdkTs, "fixture://openapi": set.openapi, "fixture://md": set.contractMd,
  };
  if (set.sdkPhp) byUrl["fixture://php"] = set.sdkPhp;
  if (withBlocks) byUrl["fixture://blocks"] = Buffer.from(`blocks-tarball-${seed}`);
  return { key: "fixture", getContractBundle: async () => meta, downloadArtifact: async (u: string) => byUrl[u] };
}

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [ContractSnapshotsController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("M6-P4a · contract snapshot by id + artifact bytes (HTTP, isolated app)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let otherTenant: string;
  let admin: string; // company_admin in `tenant`
  let otherAdmin: string; // company_admin in `otherTenant` only
  let plain: string; // member of `tenant`, no role
  let botUser: string; // company_admin in `tenant`, reached only through a verified OBO link
  let snapNoPhp: string; // sdkPhp pointer is null
  let snapWithPhp: string; // all five artifacts present (php + block library)
  const mem = new Map<string, Buffer>();

  const url = (t: string, id: string, art?: string) =>
    `/api/${t}/modules/webdev/contracts/${id}${art ? `/artifacts/${art}` : ""}`;

  async function mirror(provider: WebdevControlProvider, slug: string): Promise<string> {
    setWebdevControlProviderForTests(provider);
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: { slug },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    tenant = await createCompany("M6-P4a Tenant", ["webdev"]);
    otherTenant = await createCompany("M6-P4a Other Tenant", ["webdev"]);
    admin = await createUser("m6p4a-admin@a.test", "P4a Admin");
    otherAdmin = await createUser("m6p4a-other-admin@a.test", "P4a Other Admin");
    plain = await createUser("m6p4a-plain@a.test", "P4a Plain");
    botUser = await createUser("m6p4a-bot@a.test", "P4a Bot");
    await addMembership(tenant, admin);
    await addMembership(otherTenant, otherAdmin);
    await addMembership(tenant, plain);
    await addMembership(tenant, botUser);
    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", tenant);
    await grantRole(otherAdmin, adminRole, "company", otherTenant);
    await grantRole(botUser, adminRole, "company", tenant);
    await linkIdentity(botUser, "n8n", "wf:delivery", true);
    app = await buildIsolatedApp();
    snapNoPhp = await mirror(providerFor("10.0.0", "p4a-nophp", false), "p4a-nophp");
    snapWithPhp = await mirror(providerFor("10.1.0", "p4a-php", true, true), "p4a-php");
  });
  afterAll(async () => {
    setWebdevControlProviderForTests(null);
    setStorageForTest(localStorage);
    await app.close();
    await teardownTestDb();
  });

  it("GET by id returns the SnapshotDto with the artifact pointer and hash manifest", async () => {
    const r = await app.inject({ method: "GET", url: url(tenant, snapNoPhp), headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      id: snapNoPhp, tenantId: tenant, webdeskTenantSlug: "p4a-nophp", contractVersion: "10.0.0",
      artifacts: { sdkPhp: null, hashes: expect.any(Object) },
    });
  });

  it("another tenant's snapshot id is 404 (third wall), as are an unknown and a malformed id", async () => {
    const cross = await app.inject({ method: "GET", url: url(otherTenant, snapNoPhp), headers: asUser(otherAdmin) });
    expect(cross.statusCode).toBe(404);
    const crossArt = await app.inject({ method: "GET", url: url(otherTenant, snapNoPhp, "openapi"), headers: asUser(otherAdmin) });
    expect(crossArt.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "GET", url: url(tenant, "00000000-0000-4000-8000-000000000000"), headers: asUser(admin),
    });
    expect(unknown.statusCode).toBe(404);
    const malformed = await app.inject({ method: "GET", url: url(tenant, "not-a-uuid"), headers: asUser(admin) });
    expect(malformed.statusCode).toBe(404);
  });

  it("each of the five artifacts returns bytes whose sha256 matches the hash stored at mirror time", async () => {
    const snap = (await app.inject({ method: "GET", url: url(tenant, snapWithPhp), headers: asUser(admin) })).json();
    for (const art of ["openapi", "sdkTs", "sdkPhp", "contractMd", "blockLibrary"] as const) {
      const r = await app.inject({ method: "GET", url: url(tenant, snapWithPhp, art), headers: asUser(admin) });
      expect(r.statusCode, art).toBe(200);
      const body = r.json();
      // The tarball's file id lives in `artifacts.blockLibraryFile` (`artifacts.blockLibrary` is the version ref).
      const pointerField = art === "blockLibrary" ? "blockLibraryFile" : art;
      expect(body).toMatchObject({ snapshotId: snapWithPhp, artifact: art, fileId: snap.artifacts[pointerField] });
      const bytes = Buffer.from(body.base64, "base64");
      expect(sha(bytes)).toBe(body.sha256);
      expect(body.sha256).toBe(snap.artifacts.hashes[art]);
      expect(body.byteSize).toBe(bytes.byteLength);
      expect(typeof body.contentType).toBe("string");
    }
    const md = (await app.inject({ method: "GET", url: url(tenant, snapWithPhp, "contractMd"), headers: asUser(admin) })).json();
    expect(Buffer.from(md.base64, "base64").toString("utf8")).toBe("md-p4a-php");
    const blocks = (await app.inject({ method: "GET", url: url(tenant, snapWithPhp, "blockLibrary"), headers: asUser(admin) })).json();
    expect(Buffer.from(blocks.base64, "base64").toString("utf8")).toBe("blocks-tarball-p4a-php");
    expect(blocks.contentType).toBe("application/gzip");
    // The block library's hash sits beside the manifest, and the manifest itself is unchanged (4 keys).
    expect(Object.keys(snap.artifacts.hashes).sort()).toEqual(["blockLibrary", "contractMd", "openapi", "sdkPhp", "sdkTs"]);
  });

  it("M6-P4b0: the SDK files are stored under their real types (text/plain, text/x-php), not as gzip tarballs", async () => {
    const ts = (await app.inject({ method: "GET", url: url(tenant, snapWithPhp, "sdkTs"), headers: asUser(admin) })).json();
    const php = (await app.inject({ method: "GET", url: url(tenant, snapWithPhp, "sdkPhp"), headers: asUser(admin) })).json();
    expect(ts.contentType).toBe("text/plain");
    expect(php.contentType).toBe("text/x-php");
    const names = await adminPool().query<{ filename: string }>(
      `SELECT filename FROM files WHERE target_entity_id = $1 ORDER BY filename`, [snapWithPhp],
    );
    expect(names.rows.map((x) => x.filename)).toEqual([
      "CONTENT-CONTRACT.md", "gaiada-webdesk-blocks-1.3.2.tgz", "openapi.v1.json", "sdk.d.ts", "sdk.php",
    ]);
  });

  it("an artifact name outside the five is a 400 — there is no way to name a file", async () => {
    for (const bad of ["hashes", "blockLibraryFile", "fileId", "sdk"]) {
      const r = await app.inject({ method: "GET", url: url(tenant, snapNoPhp, bad), headers: asUser(admin) });
      expect(r.statusCode, bad).toBe(400);
    }
  });

  it("a null sdkPhp pointer is a 404 with the distinct reason artifact_absent", async () => {
    const r = await app.inject({ method: "GET", url: url(tenant, snapNoPhp, "sdkPhp"), headers: asUser(admin) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "artifact_absent", reason: "artifact_absent" });
  });

  it("a snapshot with no block library gives 404 artifact_absent for blockLibrary (a null pointer, like sdkPhp)", async () => {
    const r = await app.inject({ method: "GET", url: url(tenant, snapNoPhp, "blockLibrary"), headers: asUser(admin) });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "artifact_absent", reason: "artifact_absent" });
  });

  it("a plain member (no role carrying read) is DENIED on both routes", async () => {
    const one = await app.inject({ method: "GET", url: url(tenant, snapNoPhp), headers: asUser(plain) });
    expect(one.statusCode).toBe(403);
    const art = await app.inject({ method: "GET", url: url(tenant, snapNoPhp, "openapi"), headers: asUser(plain) });
    expect(art.statusCode).toBe(403);
  });

  it("notLow: a verified OBO link (the hub's n8n/wf:delivery path, assurance linked) passes read; an unenrolled OBO identity is denied", async () => {
    const linked = await app.inject({
      method: "GET", url: url(tenant, snapNoPhp, "openapi"),
      headers: { ...svc, "x-obo-provider": "n8n", "x-obo-external-id": "wf:delivery" },
    });
    expect(linked.statusCode).toBe(200);
    const unlinked = await app.inject({
      method: "GET", url: url(tenant, snapNoPhp, "openapi"),
      headers: { ...svc, "x-obo-provider": "n8n", "x-obo-external-id": "wf:not-enrolled" },
    });
    expect(unlinked.statusCode).toBe(403);
  });

  it("a tampered stored object is refused as artifact_hash_mismatch (502) and never served", async () => {
    const f = await adminPool().query<{ storage_key: string }>(
      `SELECT storage_key FROM files WHERE target_entity_id = $1 AND filename = 'openapi.v1.json'`, [snapWithPhp],
    );
    const key = f.rows[0].storage_key;
    const original = mem.get(key)!;
    mem.set(key, Buffer.from("tampered"));
    try {
      const r = await app.inject({ method: "GET", url: url(tenant, snapWithPhp, "openapi"), headers: asUser(admin) });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "artifact_hash_mismatch", reason: "artifact_hash_mismatch" });
      expect(r.body).not.toContain(Buffer.from("tampered").toString("base64"));
    } finally {
      mem.set(key, original);
    }
  });
});
