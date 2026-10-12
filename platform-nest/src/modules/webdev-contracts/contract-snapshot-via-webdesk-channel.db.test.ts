// M6-P4j (WSK-D81) -- the whole mirror refresh over the REAL-channel provider, against live Postgres (RLS, the files
// subsystem) and a fake `WebdeskControlClient`. The contract body names artifact URLs on WebDesk's internal object
// store (`http://rustfs:9000/...`, unresolvable from here, as in production); the only way the bytes can arrive is
// the client's `getContractArtifact`. Server-run suite (needs the DB containers): see platform-nest/CLAUDE.md.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import type { WebdeskControlResponse } from "../webdev/webdesk-control-client";
import { WebdeskChannelContractProvider, type ContractChannelClient } from "./contract-fetch-webdesk";
import { computeContentHash, refreshContractSnapshot } from "./contract-snapshot.service";

const SLUG = "m6-gate-static-prd";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const TGZ = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0xc3, 0x28, 0xff])]);
const GOOD = {
  sdkTs: Buffer.from("export declare const sdk: unknown;\n"),
  sdkPhp: Buffer.from("<?php\nclass Sdk {}\n"),
  openapi: Buffer.from('{"openapi":"3.1.0"}'),
  contractMd: Buffer.from("# Content contract\n"),
  blockLibrary: TGZ,
};

const ok = (body: unknown): WebdeskControlResponse => {
  const bodyText = JSON.stringify(body);
  return { status: 200, contentType: "application/json", json: body, bodyText, bodyBytes: Buffer.from(bodyText) };
};

/** A WebDesk that serves `served` over the control channel, and a contract body that claims the hash of `GOOD`. */
function channel(version: string, served: Record<string, Buffer>): { client: ContractChannelClient; asked: string[] } {
  const asked: string[] = [];
  const u = (f: string) => `http://rustfs:9000/artifacts/contracts/${SLUG}/${version}/${f}?X-Amz-Signature=sig`;
  const client = {
    getContract: async () =>
      ok({
        version,
        vocabularyVersion: "1.5.0",
        blockLibrary: { package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" },
        artifacts: {
          sdkTsUrl: u("sdk.d.ts"),
          sdkPhpUrl: u("sdk.php"),
          openapiUrl: u("openapi.v1.json"),
          contractMdUrl: u("CONTENT-CONTRACT.md"),
          blockLibraryUrl: `http://rustfs:9000/artifacts/blocks/0.1.0/x/lib.tgz?X-Amz-Signature=sig`,
          blockLibrarySha256: sha(TGZ),
        },
        contentHash: computeContentHash({ sdkTs: GOOD.sdkTs, sdkPhp: GOOD.sdkPhp, openapi: GOOD.openapi, contractMd: GOOD.contractMd }).contentHash,
        generatedAt: "2026-10-13T00:00:00.000Z",
      }),
    getContractArtifact: async (_slug: string, _version: string, artifact: string) => {
      asked.push(artifact);
      const b = served[artifact];
      return { status: 200, contentType: "application/octet-stream", json: null, bodyText: b.toString("utf8"), bodyBytes: b } satisfies WebdeskControlResponse;
    },
  } as unknown as ContractChannelClient;
  return { client, asked };
}

let tenant: string;
let manager: string;

describe.skipIf(!TEST_URL)("M6-P4j: contract pin over the real control channel", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("P4j Tenant", ["webdev"]);
    manager = await createUser("p4j-mgr@a.test", "Manager P4j");
    await addMembership(tenant, manager);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("pins the snapshot from bytes fetched through the channel, the tarball byte-exact and its sha256 verified", async () => {
    const { client, asked } = channel("1.0.0", GOOD);
    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: new WebdeskChannelContractProvider(client) });
    expect(outcome.outcome).toBe("created");
    expect([...asked].sort()).toEqual(["blockLibrary", "contractMd", "openapi", "sdkPhp", "sdkTs"]);

    const row = (
      await adminPool().query(`SELECT artifacts FROM webdev_contract_snapshots WHERE tenant_id = $1 AND webdesk_tenant_slug = $2 AND contract_version = '1.0.0'`, [tenant, SLUG])
    ).rows[0] as { artifacts: { hashes: Record<string, string> } };
    expect(row.artifacts.hashes.blockLibrary).toBe(sha(TGZ));
    expect(row.artifacts.hashes.sdkTs).toBe(sha(GOOD.sdkTs));
  });

  it("a body that differs from what the contract claims is still refused (the channel is not trusted for integrity)", async () => {
    const { client } = channel("1.0.1", { ...GOOD, sdkTs: Buffer.from("export declare const sdk: 'tampered';\n") });
    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: new WebdeskChannelContractProvider(client) });
    expect(outcome.outcome).toBe("hash_mismatch");
    const rows = await adminPool().query(`SELECT 1 FROM webdev_contract_snapshots WHERE tenant_id = $1 AND contract_version = '1.0.1'`, [tenant]);
    expect(rows.rowCount).toBe(0);
  });

  it("a tarball that does not match the claimed sha256 is refused too", async () => {
    const { client } = channel("1.0.2", { ...GOOD, blockLibrary: Buffer.concat([TGZ, Buffer.from([0])]) });
    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: new WebdeskChannelContractProvider(client) });
    expect(outcome.outcome).toBe("block_library_hash_mismatch");
  });
});
