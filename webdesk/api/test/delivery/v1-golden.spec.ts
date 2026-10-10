// WSK-48b -- the /v1 golden suite. It replaces v1-differential.spec.ts (WSK-48a), which replayed two
// corpora against the old Payload router AND the api and compared them byte for byte. Payload is
// deleted; the same requests now go to the api alone and each answer is compared with a committed
// golden file recorded from the api (the differential had proved the api equal to the old router
// apart from the named M3 T1 divergences, so the api is the reference from here on).
//
//   contract replay   the envelope contract's own requests (24 + 1 outside /v1/)   -> golden/contract.json
//   extra corpus      662 + 6 outside /v1/: error paths and edge cases (golden-corpus.ts) -> golden/extra.json
//
// How the answers are made comparable (volatile ids, timestamps, slugs, keys, cursors) is documented
// in v1-contract/golden.ts. To re-record after an INTENDED change to /v1's bytes:
//
//     WEBDESK_V1_GOLDEN_RECORD=1 npx vitest run test/delivery/v1-golden.spec.ts
//
// then review the diff of v1-contract/golden/*.json like any other change to a frozen contract (the
// rewritten files are the proof of what changed). `WEBDESK_V1_GOLDEN_DIR` redirects the output.
// The recording is deterministic: two recordings on two fresh databases are byte-identical.
//
// envelope-contract.spec.ts (the contract's 60 checks) is a separate spec and is untouched; the contract
// replay here asserts them too, since it runs the same suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "../helpers/app";
import { TenantQuotaService } from "../../src/rate-limit/tenant-quota.service";
import { CONTRACT_CHECK_COUNT, runEnvelopeContract } from "./v1-contract/envelope-contract";
import { runExtraCorpus } from "./v1-contract/golden-corpus";
import { createGoldenRecorder, diffGolden, readGolden, writeGolden, type GoldenEntry } from "./v1-contract/golden";

const RECORD = process.env.WEBDESK_V1_GOLDEN_RECORD === "1";

// Entry counts, pinned so a request silently dropped from either corpus fails here even in record mode:
// the differential's own numbers, 24 + 1 status-only and 662 + 6 status-only.
const EXPECTED_ENTRIES = { contract: 24 + 1, extra: 662 + 6 };

function settle(name: "contract" | "extra", entries: GoldenEntry[]): void {
  expect(entries.length).toBe(EXPECTED_ENTRIES[name]);
  if (RECORD) {
    writeGolden(name, entries);
    return;
  }
  expect(diffGolden(entries, readGolden(name))).toEqual([]);
}

describe(`WSK-48b golden -- the api's /v1 against its committed recordings${RECORD ? " (RECORD MODE: writing the goldens)" : ""}`, () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  beforeAll(async () => {
    if (!process.env.APP_DATABASE_URL) throw new Error("APP_DATABASE_URL not set");
    app = await startTestApp();
    // ~800 requests in well under a minute, most of them on one tenant: lift the read quota the way
    // tenant-quota.spec.ts does, on this app instance only.
    app.get(TenantQuotaService).withLimits(1_000_000, 60_000);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    if (app) await stopTestApp(app);
  });

  it("contract replay: every request of the envelope contract answers as recorded, contract green", async () => {
    const rec = createGoldenRecorder({ baseUrl });
    const contract = await runEnvelopeContract(rec.handleV1Request);
    expect(contract.checks.filter((c) => !c.ok).map((c) => `${c.name} -- ${c.detail}`)).toEqual([]);
    expect(contract.passed).toBe(CONTRACT_CHECK_COUNT);
    settle("contract", rec.entries);
  }, 120_000);

  it("extra error-path / edge-case corpus: every request answers as recorded", async () => {
    const rec = createGoldenRecorder({ baseUrl });
    const harnessFailures = await runExtraCorpus(rec.recordPair);
    expect(harnessFailures).toEqual([]);
    settle("extra", rec.entries);
  }, 300_000);
});
