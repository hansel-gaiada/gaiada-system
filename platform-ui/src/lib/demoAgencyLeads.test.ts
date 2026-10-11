import { describe, it, expect } from "vitest";
import { agencyLeadsDemo } from "./demoAgencyLeads";

// The demo store is the twin the UI is driven against with no backend (DEMO_MODE): it must refuse the way
// the real routes do, with the same typed `reason` codes, or a demo walk-through shows a UI the API never produces.
const call = (method: string, path: string, body?: unknown) =>
  agencyLeadsDemo(method, `/api/co-1/agency${path}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), "demo-user")!;

describe("demo pipeline routes", () => {
  it("serves the reference: six stages and the active currencies", () => {
    const r = call("GET", "/pipeline/reference");
    const j = r.json as { stages: { key: string }[]; currencies: { code: string; minorUnit: number }[] };
    expect(j.stages.map((s) => s.key)).toEqual(["enquiry", "contacted", "qualified", "proposal", "won", "lost"]);
    expect(j.currencies.find((c) => c.code === "IDR")?.minorUnit).toBe(0);
  });

  it("the queue and detail carry stage, dealValue (a string), dealCurrency and stageEnteredAt", () => {
    const q = call("GET", "/leads").json as { id: string; stage: string; dealValue: string | null }[];
    expect(q.every((r) => typeof r.stage === "string")).toBe(true);
    const withDeal = q.find((r) => r.dealValue !== null);
    expect(typeof withDeal?.dealValue).toBe("string");
    const d = call("GET", "/leads/lead-demo-3").json as { stage: string; stageEnteredAt: string };
    expect(d.stage).toBe("qualified");
    expect(d.stageEnteredAt).toBeTruthy();
  });

  it("refuses won and lost with stage_terminal, unknown keys with stage_unknown, closed leads with lead_closed", () => {
    expect((call("POST", "/leads/lead-demo-1/stage", { stage: "won" }).json as { reason: string }).reason).toBe("stage_terminal");
    expect((call("POST", "/leads/lead-demo-1/stage", { stage: "lost" }).json as { reason: string }).reason).toBe("stage_terminal");
    expect((call("POST", "/leads/lead-demo-1/stage", { stage: "nope" }).json as { reason: string }).reason).toBe("stage_unknown");
    const closed = call("POST", "/leads/lead-demo-7/stage", { stage: "contacted" });
    expect(closed.status).toBe(409);
    expect((closed.json as { reason: string }).reason).toBe("lead_closed");
  });

  it("a move writes history newest first; a same-stage move is changed:false and writes nothing", () => {
    const first = call("POST", "/leads/lead-demo-2/stage", { stage: "contacted" }).json as { changed: boolean };
    expect(first.changed).toBe(true);
    const again = call("POST", "/leads/lead-demo-2/stage", { stage: "contacted" }).json as { changed: boolean };
    expect(again.changed).toBe(false);
    call("POST", "/leads/lead-demo-2/stage", { stage: "qualified" });
    const h = call("GET", "/leads/lead-demo-2/stage-history").json as { fromStage: string; toStage: string }[];
    expect(h.map((e) => `${e.fromStage}>${e.toStage}`)).toEqual(["contacted>qualified", "enquiry>contacted"]);
  });

  it("deal refusals carry the typed codes", () => {
    const reason = (v: unknown, c: unknown) => (call("POST", "/leads/lead-demo-1/deal", { value: v, currency: c }).json as { reason?: string }).reason;
    expect(reason("100", null)).toBe("deal_incomplete");
    expect(reason("abc", "USD")).toBe("deal_value_invalid");
    expect(reason("100", "XXX")).toBe("deal_currency_unknown");
    expect(reason("1500.5", "IDR")).toBe("deal_value_precision");
    expect(reason("10.255", "USD")).toBe("deal_value_precision");
  });

  it("a body that omits both members is incomplete, so {} can never wipe a value", () => {
    const r = call("POST", "/leads/lead-demo-3/deal", {});
    expect(r.status).toBe(400);
    expect((r.json as { reason: string }).reason).toBe("deal_incomplete");
    expect((call("GET", "/leads/lead-demo-3").json as { dealValue: string }).dealValue).toBe("15000000.0000");
  });

  it("sets a value padded like Postgres, then clears it with the explicit null pair", () => {
    const set = call("POST", "/leads/lead-demo-1/deal", { value: "10.25", currency: "USD" }).json as { dealValue: string };
    expect(set.dealValue).toBe("10.2500");
    const cleared = call("POST", "/leads/lead-demo-1/deal", { value: null, currency: null }).json as { dealValue: string | null; changed: boolean };
    expect(cleared).toMatchObject({ dealValue: null, changed: true });
  });

  it("decline now works from a new lead and sets stage lost", () => {
    const r = call("POST", "/leads/lead-demo-5/decline", { reason: "not a fit" });
    expect(r.status).toBe(200);
    expect((call("GET", "/leads/lead-demo-5").json as { stage: string }).stage).toBe("lost");
  });

  it("convert takes an optional deal, refuses a bad one, and sets stage won", () => {
    const bad = call("POST", "/leads/lead-demo-3/convert", { delegations: [], deal: { value: "1500.5", currency: "IDR" } });
    expect((bad.json as { reason: string }).reason).toBe("deal_value_precision");
    const ok = call("POST", "/leads/lead-demo-3/convert", { delegations: [], deal: { value: "20000000", currency: "IDR" } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ dealValue: "20000000.0000", dealCurrency: "IDR" });
    expect((call("GET", "/leads/lead-demo-3").json as { stage: string }).stage).toBe("won");
  });
});
