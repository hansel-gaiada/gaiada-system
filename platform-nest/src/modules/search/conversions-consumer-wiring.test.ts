// M5-P2 — the consumer loop ACTUALLY invokes the stage-changed handler (the SMM-14 trap, driven rather than only grepped).
//
// `searchModule.eventHandlers["agency.lead.stage_changed"]` is dead code unless main.ts's `startConsumerLoop([...])` lists the
// `agency_lead` stream: the event is written, relayed, and read by nobody, and nothing goes red. conversions.test.ts pins the
// source text; THIS suite goes further. It takes the watched-stream list OUT OF main.ts's source, drives the real
// `consumeOnce` (the function `startConsumerLoop` calls per stream) over every stream in that list, against an in-memory Redis
// that holds one `agency.lead.stage_changed` entry on `events:agency_lead`, with the REAL searchModule registered, and asserts
// the handler ran. A negative control removes `agency_lead` from the list and asserts it did NOT: so this test fails, by
// construction, if the wiring line in main.ts is ever deleted. It needs no Postgres and no Redis.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const handler = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./conversions.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conversions.service")>()),
  handleStageChanged: handler,
}));
// `isModuleEnabled` reads Postgres; the module gate itself is not what this test is about.
vi.mock("../registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../registry")>()),
  isModuleEnabled: vi.fn(async () => true),
}));

import { consumeOnce } from "../../events/consumer.service";
import { setRedis } from "../../events/redis";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";

const TENANT = "44444444-4444-4444-8444-444444444444";
const LEAD = "11111111-1111-4111-8111-111111111111";
const payload = {
  v: 1, leadId: LEAD, stageEventId: "66666666-6666-4666-8666-666666666666", submissionRef: "22222222-2222-4222-8222-222222222222",
  fromStage: "proposal", toStage: "won", dealValue: null, dealCurrency: null, occurredAt: "2026-10-12T09:00:00.000Z",
};

/** The watched entity-type list, read from main.ts's startConsumerLoop([...]) call. Spreads (`...POSITION_STREAMS`) are skipped. */
function watchedStreams(): string[] {
  const main = readFileSync(join(__dirname, "..", "..", "main.ts"), "utf8");
  const call = main.slice(main.indexOf("startConsumerLoop(["));
  const list = call.slice("startConsumerLoop([".length, call.indexOf("]);"));
  const noComments = list.replace(/\/\/.*$/gm, "");
  return [...noComments.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** Just enough of ioredis for consumeOnce: one stream holds one undelivered entry. */
function fakeRedis(entryStream: string, entryFields: string[]) {
  const delivered = new Set<string>();
  const acked: string[] = [];
  return {
    acked,
    client: {
      async xgroup() { return "OK"; },
      async xautoclaim() { return ["0-0", [], []]; },
      async xreadgroup(...args: string[]) {
        const stream = args[args.indexOf("STREAMS") + 1];
        if (stream !== `events:${entryStream}` || delivered.has(stream)) return null;
        delivered.add(stream);
        return [[stream, [["1-0", entryFields]]]];
      },
      async xack(_stream: string, _group: string, id: string) { acked.push(id); return 1; },
      async xpending() { return []; },
      async xadd() { return "2-0"; },
    },
  };
}

const fields = (eventType: string): string[] => [
  "outboxId", "99999999-9999-4999-8999-999999999999", "tenantId", TENANT, "entityId", LEAD, "eventType", eventType,
  "payload", JSON.stringify(payload), "originSite", "central", "schemaVersion", "1", "createdAt", new Date().toISOString(),
];

describe("M5-P2 — the consumer loop invokes agency.lead.stage_changed", () => {
  beforeEach(() => {
    handler.mockClear();
    resetModules();
    registerModule(searchModule);
  });

  it("main.ts's watched-stream list includes agency_lead, and consuming every watched stream reaches the handler once, with the event", async () => {
    const streams = watchedStreams();
    expect(streams.length).toBeGreaterThan(5); // the parse found the real list
    expect(streams).toContain("agency_lead");
    const redis = fakeRedis("agency_lead", fields("agency.lead.stage_changed"));
    setRedis(redis.client as never);
    for (const t of streams) await consumeOnce(t);
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = (handler.mock.calls[0] as unknown as [{ eventType: string; tenantId: string; entityType: string; payload: unknown }])[0];
    expect(ev).toMatchObject({ eventType: "agency.lead.stage_changed", tenantId: TENANT, entityType: "agency_lead", payload });
    expect(redis.acked).toEqual(["1-0"]); // handled, acknowledged
  });

  it("NEGATIVE CONTROL: without agency_lead in the list, the same event is read by nobody (this is what the wiring line prevents)", async () => {
    const without = watchedStreams().filter((t) => t !== "agency_lead");
    setRedis(fakeRedis("agency_lead", fields("agency.lead.stage_changed")).client as never);
    for (const t of without) await consumeOnce(t);
    expect(handler).not.toHaveBeenCalled();
  });

  it("an agency_lead event the search module has no handler for (created, converted) is acknowledged and reaches nothing", async () => {
    const redis = fakeRedis("agency_lead", fields("agency.lead.created"));
    setRedis(redis.client as never);
    await consumeOnce("agency_lead");
    expect(handler).not.toHaveBeenCalled();
    expect(redis.acked).toEqual(["1-0"]);
  });
});
