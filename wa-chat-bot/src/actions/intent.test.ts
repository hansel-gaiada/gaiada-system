import { describe, it, expect, beforeEach } from "vitest";
import { routeIntent } from "./intent";
import { registerBusinessActions } from "./builtins";
import { resetActions } from "./registry";
import { config } from "../config";

const reply = (s: string) => async () => s;

describe("routeIntent (LLM → proposed action, never executes)", () => {
  beforeEach(() => {
    resetActions();
    registerBusinessActions();
    config.intentRoutingEnabled = true;
    config.intentConfidenceThreshold = 0.7;
  });

  it("high-confidence catalog action is proposed", async () => {
    const r = await routeIntent("mark task t-9 as done", reply('{"action":"task.complete","args":{"taskId":"t-9"},"confidence":0.95}'));
    expect(r.kind).toBe("action");
    if (r.kind === "action") { expect(r.actionName).toBe("task.complete"); expect((r.args as any).taskId).toBe("t-9"); }
  });

  it("low-confidence result asks for clarification, never proposes", async () => {
    const r = await routeIntent("do the thing", reply('{"action":"task.complete","args":{},"confidence":0.4}'));
    expect(r.kind).toBe("clarify");
  });

  it("explicit clarify is passed through", async () => {
    const r = await routeIntent("assign it", reply('{"action":"clarify","question":"Which task and to whom?"}'));
    expect(r).toEqual({ kind: "clarify", question: "Which task and to whom?" });
  });

  it("non-action chatter returns none (falls back to Q&A)", async () => {
    const r = await routeIntent("what did we decide yesterday?", reply('{"action":"none"}'));
    expect(r.kind).toBe("none");
  });

  it("a hallucinated action outside the catalog is ignored", async () => {
    const r = await routeIntent("delete everything", reply('{"action":"database.drop","args":{},"confidence":0.99}'));
    expect(r.kind).toBe("none");
  });

  it("non-JSON model output degrades to none", async () => {
    const r = await routeIntent("hello", reply("[Gateway unreachable: ECONNREFUSED]"));
    expect(r.kind).toBe("none");
  });

  it("extracts JSON embedded in surrounding prose", async () => {
    const r = await routeIntent("create project Rebrand", reply('Sure! {"action":"project.create","args":{"name":"Rebrand"},"confidence":0.9} hope that helps'));
    expect(r.kind).toBe("action");
    if (r.kind === "action") expect((r.args as any).name).toBe("Rebrand");
  });

  it("disabled routing short-circuits to none", async () => {
    config.intentRoutingEnabled = false;
    const r = await routeIntent("mark task t-9 done", reply('{"action":"task.complete","confidence":0.99}'));
    expect(r.kind).toBe("none");
  });
});
