// WSK-48a (tests port) — the byte-identity gate between the OLD Payload-hosted /v1 router and the
// api's route, ported from webdesk/payload/test/run-v1-differential.mjs so it runs in this
// package's `npm test` (and so in CI's webdesk-api job). Three passes, as the original runner made:
//
//   1. the envelope contract replayed through the tee, its assertions evaluated on the API's
//      responses — every request the suite makes goes to BOTH servers and is byte-compared;
//   2. the same with the assertions on the OLD router's responses: the baseline proving the tee is
//      neutral (it must pass exactly like the original suite);
//   3. the extra corpus: the error paths and edge cases the contract never exercises.
//
// The OLD side is the real payload/collections/router.ts, imported at run time from the Payload
// tree and served by a plain Node http.Server. It needs only `pg`, resolved from webdesk/'s own
// node_modules — the webdesk-api CI job installs that in its migration step, before `npm test`.
// Its pool reads DATABASE_URI, which is pointed at the api's own runtime role (webdesk_app), so
// both sides read the same rows through the same RLS.
//
// When WSK-48b deletes webdesk/payload/, this file goes with it; envelope-contract.spec.ts stays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "../helpers/app";
import { TenantQuotaService } from "../../src/rate-limit/tenant-quota.service";
import { CONTRACT_CHECK_COUNT, runEnvelopeContract, type ContractResult, type V1Handle } from "./v1-contract/envelope-contract";
import { createV1Differential, serveOldRouter } from "./v1-contract/differential";
import { runExtraCorpus } from "./v1-contract/differential-extra";

const WEBDESK_ROOT = path.resolve(__dirname, "../../..");
const OLD_ROUTER = path.join(WEBDESK_ROOT, "payload/collections/router.ts");
const OLD_DB = path.join(WEBDESK_ROOT, "payload/collections/db.ts");

// Pair counts, pinned so a request silently dropped from either corpus fails here. They are the
// original runner's own numbers: run-v1-differential.mjs and this file, on one tree and one
// database, both reported 24+1 / 24+1 / 662+6 with 14 classified divergences (710 byte-compared
// pairs, 696 identical, 0 unexplained) — the same totals WSK-48a was accepted on.
const EXPECTED = {
  contractApi: { pairs: 24, statusOnly: 1 },
  contractOld: { pairs: 24, statusOnly: 1 },
  extra: { pairs: 662, statusOnly: 6, knownDivergent: 14 },
  // M3 T1: the 14 are all the bad-'%' path class (now 400 problem+json, slug invalid-path-encoding);
  // the rest are the named intended divergences (decoding, cursors). Pinned per class.
  extraByName: {} as Record<string, number>,
};

type Differential = ReturnType<typeof createV1Differential>;

function expectNoUnexplainedDifference(d: Differential): void {
  // eslint-disable-next-line no-console
  console.log(d.reportLines().join("\n"));
  expect(d.stats.mismatches.map((m) => `${m.request}${m.note ? ` (${m.note})` : ""}: ${m.diffs.join(" | ")}`)).toEqual([]);
  expect(d.stats.statusOnlyIdentical).toBe(d.stats.statusOnlyPairs);
  expect(d.stats.identical + d.stats.knownDivergent.length).toBe(d.stats.pairs);
}

function expectContractGreen(result: ContractResult): void {
  expect(result.checks.filter((c) => !c.ok).map((c) => `${c.name} -- ${c.detail}`)).toEqual([]);
  expect(result.passed).toBe(CONTRACT_CHECK_COUNT);
}

describe("WSK-48a differential — the old Payload router vs the api's /v1, byte for byte", () => {
  let app: NestFastifyApplication;
  let newUrl: string;
  let old: { url: string; close: () => Promise<void> } | undefined;
  let closeOldPool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(WEBDESK_ROOT, "node_modules", "pg"))) {
      throw new Error(
        `the old router needs webdesk/node_modules (pg): run \`npm ci\` in ${WEBDESK_ROOT} first ` +
          "(CI's webdesk-api job does, in its migration step, before `npm test`)",
      );
    }
    if (!process.env.APP_DATABASE_URL) throw new Error("APP_DATABASE_URL not set");
    process.env.DATABASE_URI = process.env.APP_DATABASE_URL;

    app = await startTestApp();
    // ~800 requests in well under a minute, most of them on one tenant: lift the read quota the way
    // tenant-quota.spec.ts does, on this app instance only. (The original ran the api with
    // WEBDESK_READ_QUOTA_PER_MIN=1000000.) In-quota responses are byte-identical either way.
    app.get(TenantQuotaService).withLimits(1_000_000, 60_000);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    newUrl = `http://127.0.0.1:${port}`;

    // A computed specifier on purpose: tsc must not follow it into the Payload tree (ESM, `.ts`
    // import specifiers), and vitest loads it at run time like any other module.
    const oldRouter = (await import(OLD_ROUTER)) as { handleV1Request: V1Handle };
    const oldDb = (await import(OLD_DB)) as { closePool: () => Promise<void> };
    closeOldPool = oldDb.closePool;
    old = await serveOldRouter(oldRouter.handleV1Request);
  }, 60_000);

  afterAll(async () => {
    await old?.close();
    await closeOldPool?.();
    if (app) await stopTestApp(app);
  });

  it("contract-suite replay, assertions on API responses: every pair identical, contract green", async () => {
    const d = createV1Differential({ oldUrl: old!.url, newUrl, target: "api", label: "contract-suite replay, assertions on API responses" });
    const contract = await runEnvelopeContract(d.handleV1Request);
    expectNoUnexplainedDifference(d);
    expect(d.stats.knownDivergent).toEqual([]);
    expectContractGreen(contract);
    expect({ pairs: d.stats.pairs, statusOnly: d.stats.statusOnlyPairs }).toEqual(EXPECTED.contractApi);
  }, 120_000);

  it("contract-suite replay, assertions on OLD responses (baseline: the tee is neutral)", async () => {
    const d = createV1Differential({ oldUrl: old!.url, newUrl, target: "old", label: "contract-suite replay, assertions on OLD responses (baseline)" });
    const contract = await runEnvelopeContract(d.handleV1Request);
    expectNoUnexplainedDifference(d);
    expect(d.stats.knownDivergent).toEqual([]);
    expectContractGreen(contract);
    expect({ pairs: d.stats.pairs, statusOnly: d.stats.statusOnlyPairs }).toEqual(EXPECTED.contractOld);
  }, 120_000);

  it("extra error-path / edge-case replay: every pair identical or a classified framework divergence", async () => {
    const d = createV1Differential({ oldUrl: old!.url, newUrl, target: "api", label: "extra error-path / edge-case replay" });
    const harnessFailures = await runExtraCorpus(d.comparePair);
    expect(harnessFailures).toEqual([]);
    expectNoUnexplainedDifference(d);
    // The classified divergences, each NAMED and counted separately (a new class, or a member that
    // moves between classes, fails here). The first is the original framework class: a raw '%' without
    // two hex digits in the PATH, which the old router never saw (Fastify refused it before any route);
    // the api now answers it as 400 problem+json. The other two are behaviours M3 T1 changed on purpose.
    const byName: Record<string, number> = {};
    for (const k of d.stats.knownDivergent) byName[k.name] = (byName[k.name] ?? 0) + 1;
    expect(byName).toEqual(EXPECTED.extraByName);
    expect({ pairs: d.stats.pairs, statusOnly: d.stats.statusOnlyPairs, knownDivergent: d.stats.knownDivergent.length }).toEqual(EXPECTED.extra);
  }, 300_000);
});
