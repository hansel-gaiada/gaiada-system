// M6-P4j (WSK-D81) -- the contract artifact bytes over the control channel: `ContractReadService.readArtifact` and the
// `GET /control/v1/tenants/:slug/contract/:contractVersion/artifacts/:artifact` handler. NO services: a fake
// StorageAdapter and a fake tenant lookup / audit sink, the controller driven directly (the guards are the same two
// every other control route carries and have their own suites; the HTTP path is in codegen-contract-controller.spec.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ExecutionContext } from "@nestjs/common";
import { BadRequestException, InternalServerErrorException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ContractController } from "../src/control/contract/contract.controller";
import { ContractReadService, MAX_CONTRACT_ARTIFACT_BYTES, CONTRACT_ARTIFACT_NAMES } from "../src/codegen/contract-read.service";
import type { StorageAdapter } from "../src/storage/storage.types";
import type { LatestContractPointer } from "../src/codegen/contract-manifest.types";
import type { ControlRequest } from "../src/control/auth/control-request";
import type { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import { CommandAuditService } from "../src/control/command-audit.service";
import { TenantLookupService as TenantLookup } from "../src/tenants/tenant-lookup.service";
import { ControlAuthGuard } from "../src/control/auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../src/control/policy/command-authorization.guard";

const SLUG = "acme";
const BLOCK_KEY = "blocks/0.1.0/152692016228633b/gaiada-webdesk-blocks-0.1.0.tgz";

// A tgz-shaped buffer: gzip magic plus every byte value, so a utf8 round trip would corrupt it.
const TGZ = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0xff, 0xfe, 0x00])]);

function pointer(version = "1.0.0", withBlockLibrary = true): LatestContractPointer {
  return {
    contractVersion: version,
    vocabularyVersion: "1.5.0",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" },
    contentHash: `sha256:${"c".repeat(64)}`,
    generatedAt: "2026-10-13T00:00:00.000Z",
    artifactKeys: {
      openapiJson: `contracts/${SLUG}/${version}/openapi.v1.json`,
      sdkTs: `contracts/${SLUG}/${version}/sdk.d.ts`,
      sdkPhp: `contracts/${SLUG}/${version}/sdk.php`,
      contractMd: `contracts/${SLUG}/${version}/CONTENT-CONTRACT.md`,
      ...(withBlockLibrary ? { blockLibrary: BLOCK_KEY } : {}),
    },
    hashes: { openapiJson: "a", sdkTs: "b", sdkPhp: "c", contractMd: "d" },
    compositionSnapshot: {},
  };
}

type Store = Map<string, { body: Buffer; contentLength?: number }>;

function fakeStorage(store: Store): { storage: StorageAdapter; gets: string[] } {
  const gets: string[] = [];
  const storage = {
    providerName: "fake",
    headObject: async (_b: string, key: string) => {
      const o = store.get(key);
      return o ? { contentLength: o.contentLength ?? o.body.length } : null;
    },
    presignGetObject: async (_b: string, key: string) => `http://rustfs:9000/${key}?X-Amz-Signature=sig`,
    getObject: async (_b: string, key: string) => {
      gets.push(key);
      const o = store.get(key);
      if (!o) throw new Error(`NoSuchKey ${key}`);
      return { body: o.body };
    },
  } as unknown as StorageAdapter;
  return { storage, gets };
}

function seedStore(opts: { sdkPhp?: boolean; blockLibrary?: boolean } = {}): Store {
  const { sdkPhp = true, blockLibrary = true } = opts;
  const store: Store = new Map();
  const ptr = pointer("1.0.0", blockLibrary);
  store.set(`contracts/${SLUG}/latest.json`, { body: Buffer.from(JSON.stringify(ptr)) });
  store.set(ptr.artifactKeys.openapiJson, { body: Buffer.from('{"openapi":"3.1.0"}') });
  store.set(ptr.artifactKeys.sdkTs, { body: Buffer.from("export declare const sdk: unknown;\n") });
  if (sdkPhp) store.set(ptr.artifactKeys.sdkPhp, { body: Buffer.from("<?php\nclass Sdk {}\n") });
  store.set(ptr.artifactKeys.contractMd, { body: Buffer.from("# Content contract\n") });
  if (blockLibrary) store.set(BLOCK_KEY, { body: TGZ });
  return store;
}

describe("ContractReadService.readArtifact", () => {
  const read = (store: Store, version: string, artifact: (typeof CONTRACT_ARTIFACT_NAMES)[number]) =>
    new ContractReadService(fakeStorage(store).storage).readArtifact(SLUG, version, artifact);

  it("returns the stored bytes and a content type for each of the five artifacts", async () => {
    const store = seedStore();
    expect((await read(store, "1.0.0", "openapi"))!).toEqual({ body: Buffer.from('{"openapi":"3.1.0"}'), contentType: "application/json" });
    expect((await read(store, "1.0.0", "sdkTs"))!.body.toString()).toBe("export declare const sdk: unknown;\n");
    expect((await read(store, "1.0.0", "sdkPhp"))!.body.toString()).toBe("<?php\nclass Sdk {}\n");
    expect((await read(store, "1.0.0", "contractMd"))!.contentType).toContain("text/markdown");
    const lib = (await read(store, "1.0.0", "blockLibrary"))!;
    expect(lib.contentType).toBe("application/gzip");
    expect(Buffer.compare(lib.body, TGZ)).toBe(0); // byte-exact, binary-safe
  });

  it("is null for a version this tenant has no artifacts for", async () => {
    const store = seedStore();
    for (const a of CONTRACT_ARTIFACT_NAMES) expect(await read(store, "9.9.9", a)).toBeNull();
  });

  it("is null for the block library of a version that is not the pointer's (the pointer describes only the latest)", async () => {
    const store = seedStore();
    store.set(`contracts/${SLUG}/0.9.0/openapi.v1.json`, { body: Buffer.from("{}") });
    expect(await read(store, "0.9.0", "openapi")).not.toBeNull();
    expect(await read(store, "0.9.0", "blockLibrary")).toBeNull();
  });

  it("is null for an optional artifact that was never generated (no sdkPhp, no block library)", async () => {
    const store = seedStore({ sdkPhp: false, blockLibrary: false });
    expect(await read(store, "1.0.0", "sdkPhp")).toBeNull();
    expect(await read(store, "1.0.0", "blockLibrary")).toBeNull();
    expect(await read(store, "1.0.0", "sdkTs")).not.toBeNull();
  });

  it("is null when there is no pointer at all (block library of a tenant never generated)", async () => {
    expect(await read(new Map(), "1.0.0", "blockLibrary")).toBeNull();
  });

  it.each(["../1.0.0", "1.0.0/../../x", "latest", "1.0", "1.0.0%2f", "", "1.0.0 "])("never builds a key from a non-semver version (%j)", async (bad) => {
    const { storage, gets } = fakeStorage(seedStore());
    expect(await new ContractReadService(storage).readArtifact(SLUG, bad, "openapi")).toBeNull();
    expect(gets).toEqual([]);
  });

  it("refuses an artifact over the cap, from the head size, without downloading it", async () => {
    const store = seedStore();
    store.set(BLOCK_KEY, { body: TGZ, contentLength: MAX_CONTRACT_ARTIFACT_BYTES + 1 });
    const { storage, gets } = fakeStorage(store);
    await expect(new ContractReadService(storage).readArtifact(SLUG, "1.0.0", "blockLibrary")).rejects.toThrow(/over the \d+-byte control-channel cap/);
    expect(gets).not.toContain(BLOCK_KEY);
  });

  it("serves an artifact exactly at the cap", async () => {
    const store = seedStore();
    store.set(BLOCK_KEY, { body: Buffer.alloc(MAX_CONTRACT_ARTIFACT_BYTES, 7) });
    const res = await read(store, "1.0.0", "blockLibrary");
    expect(res!.body.length).toBe(MAX_CONTRACT_ARTIFACT_BYTES);
  });
});

describe("ContractController.getContractArtifact", () => {
  type Rig = {
    controller: ContractController;
    audits: Array<{ tenantId: string; command: string; actor: string; args: Record<string, unknown> }>;
    headers: Record<string, string>;
    reply: FastifyReply;
  };

  function rig(store: Store, tenantStatus: "active" | "archived" | null = "active"): Rig {
    const audits: Rig["audits"] = [];
    const headers: Record<string, string> = {};
    const tenants = {
      bySlug: async (slug: string) => (tenantStatus && slug === SLUG ? { id: "tenant-1", slug, status: tenantStatus, companyRef: "c" } : null),
    } as unknown as TenantLookupService;
    const commandAudit = { recordTenant: async (e: Rig["audits"][number]) => void audits.push(e) } as unknown as CommandAuditService;
    const reply = { header: (k: string, v: string) => void (headers[k] = v) } as unknown as FastifyReply;
    return { controller: new ContractController(tenants, commandAudit, new ContractReadService(fakeStorage(store).storage)), audits, headers, reply };
  }

  const req = { control: { principal: { subject: "erp-platform" }, ws4ApprovalId: null } } as unknown as ControlRequest;
  const call = (r: Rig, version: string, artifact: string, slug = SLUG) => r.controller.getContractArtifact(req, slug, version, artifact, r.reply);

  it("answers the raw bytes with content-type and content-length, for each artifact", async () => {
    const r = rig(seedStore());
    const lib = await call(r, "1.0.0", "blockLibrary");
    expect(Buffer.compare(lib, TGZ)).toBe(0);
    expect(r.headers["content-type"]).toBe("application/gzip");
    expect(r.headers["content-length"]).toBe(String(TGZ.length));
    const md = await call(r, "1.0.0", "contractMd");
    expect(md.toString()).toBe("# Content contract\n");
    expect(r.headers["content-type"]).toContain("text/markdown");
    expect((await call(r, "1.0.0", "openapi")).toString()).toBe('{"openapi":"3.1.0"}');
    expect((await call(r, "1.0.0", "sdkTs")).length).toBeGreaterThan(0);
    expect((await call(r, "1.0.0", "sdkPhp")).toString()).toContain("<?php");
  });

  it("audits every call as contract.read, with the artifact and version in the args", async () => {
    const r = rig(seedStore());
    await call(r, "1.0.0", "sdkTs");
    expect(r.audits).toEqual([
      { tenantId: "tenant-1", command: "contract.read", actor: "erp-platform", args: { tenantSlug: SLUG, contractVersion: "1.0.0", artifact: "sdkTs", outcome: "served" } },
    ]);
  });

  it("400s an unknown artifact name, naming the allowed ones", async () => {
    const r = rig(seedStore());
    const err = await call(r, "1.0.0", "latest").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(err.getResponse())).toContain("openapi, sdkTs, sdkPhp, contractMd, blockLibrary");
  });

  it("404s an unknown version, RFC-9457-shaped, and audits the miss", async () => {
    const r = rig(seedStore());
    const err = await call(r, "7.7.7", "openapi").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/contract-artifact-not-found", status: 404 });
    expect(r.audits[0].args.outcome).toBe("not-found");
  });

  it("404s an optional artifact that is absent for the version", async () => {
    const r = rig(seedStore({ sdkPhp: false, blockLibrary: false }));
    await expect(call(r, "1.0.0", "sdkPhp")).rejects.toBeInstanceOf(NotFoundException);
    await expect(call(r, "1.0.0", "blockLibrary")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s an inactive or unknown tenant, before reading storage or writing an audit row", async () => {
    const archived = rig(seedStore(), "archived");
    await expect(call(archived, "1.0.0", "openapi")).rejects.toBeInstanceOf(NotFoundException);
    const unknown = rig(seedStore(), null);
    await expect(call(unknown, "1.0.0", "openapi")).rejects.toBeInstanceOf(NotFoundException);
    expect(archived.audits).toEqual([]);
    expect(unknown.audits).toEqual([]);
  });

  it("refuses an over-cap artifact with a 5xx RFC-9457 body and audits it", async () => {
    const store = seedStore();
    store.set(BLOCK_KEY, { body: TGZ, contentLength: MAX_CONTRACT_ARTIFACT_BYTES + 1 });
    const r = rig(store);
    const err = await call(r, "1.0.0", "blockLibrary").catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(err.getResponse()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/contract-artifact-too-large", status: 500 });
    expect(r.audits[0].args.outcome).toBe("too-large");
  });

  it("401s a request with no control-channel context", async () => {
    const r = rig(seedStore());
    await expect(r.controller.getContractArtifact({} as ControlRequest, SLUG, "1.0.0", "openapi", r.reply)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// The real Fastify adapter, the real handler and route table, guards stubbed: proves the Buffer leaves as the raw
// body with the headers the handler set (the one thing the direct calls above cannot show).
describe("GET .../contract/:contractVersion/artifacts/:artifact over Fastify", () => {
  let app: NestFastifyApplication;
  const audits: unknown[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ContractController],
      providers: [
        { provide: TenantLookup, useValue: { bySlug: async (slug: string) => (slug === SLUG ? { id: "tenant-1", slug, status: "active", companyRef: "c" } : null) } },
        { provide: CommandAuditService, useValue: { recordTenant: async (e: unknown) => void audits.push(e) } },
        { provide: ContractReadService, useValue: new ContractReadService(fakeStorage(seedStore()).storage) },
      ],
    })
      .overrideGuard(ControlAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          (ctx.switchToHttp().getRequest() as ControlRequest).control = { principal: { subject: "erp-platform" }, ws4ApprovalId: null } as ControlRequest["control"];
          return true;
        },
      })
      .overrideGuard(CommandAuthorizationGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("answers a binary tarball byte-exact with content-type and content-length", async () => {
    const res = await app.inject({ method: "GET", url: `/control/v1/tenants/${SLUG}/contract/1.0.0/artifacts/blockLibrary` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-length"]).toBe(String(TGZ.length));
    expect(Buffer.compare(res.rawPayload, TGZ)).toBe(0);
    expect(audits).toHaveLength(1);
  });

  it("answers the problem shape for a 404 and a 400, and does not collide with the bundle route", async () => {
    const missing = await app.inject({ method: "GET", url: `/control/v1/tenants/${SLUG}/contract/9.9.9/artifacts/openapi` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().type).toBe("https://webdesk.gaiada.online/errors/contract-artifact-not-found");
    const bad = await app.inject({ method: "GET", url: `/control/v1/tenants/${SLUG}/contract/1.0.0/artifacts/nope` });
    expect(bad.statusCode).toBe(400);
    const bundle = await app.inject({ method: "GET", url: `/control/v1/tenants/${SLUG}/contract` });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.json().version).toBe("1.0.0");
  });
});
