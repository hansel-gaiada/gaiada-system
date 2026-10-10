// WSK-48a (tests port) — the WSK-06 envelope contract (design §05/§06 AC), run against the api's
// own /v1 route over real HTTP: a listening app built exactly as main.ts builds it, the real raw
// Fastify delivery route, real Postgres under real RLS (the api reads as webdesk_app).
//
// This is the gate that outlives Payload: WSK-48b deletes webdesk/payload/ (and with it the
// original envelope-contract.test.mjs and the old router the differential compares against), and
// this file keeps pinning the frozen envelope. The suite itself is v1-contract/envelope-contract.ts
// (shared with v1-differential.spec.ts); see that file for the port rules.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "../helpers/app";
import { CONTRACT_CHECK_COUNT, runEnvelopeContract, type V1Handle } from "./v1-contract/envelope-contract";

describe("WSK-06 envelope contract — on the api's /v1 route", () => {
  let app: NestFastifyApplication;
  let base: string;

  beforeAll(async () => {
    app = await startTestApp();
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it(`passes every check of the frozen contract (${CONTRACT_CHECK_COUNT}/${CONTRACT_CHECK_COUNT})`, async () => {
    const handle: V1Handle = async (request) => {
      const u = new URL(request.url);
      return fetch(base + u.pathname + u.search, { method: request.method, headers: request.headers, redirect: "manual" });
    };
    const result = await runEnvelopeContract(handle);
    expect(result.checks.filter((c) => !c.ok).map((c) => `${c.name} -- ${c.detail}`)).toEqual([]);
    expect(result.passed).toBe(CONTRACT_CHECK_COUNT);
  }, 60_000);
});
