import { beforeEach, describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { demoBillingNeedsClient, demoBillingNeedsUs, resetDemoBilling } from "./demoBilling";

// PV3-08 — the demo twin of contracts.controller.ts must model its REFUSALS, not only the happy path, or a
// browser run in DEMO_MODE proves nothing about the controller. These pin the ones the page depends on.

const HANSEL = "demo-hansel"; // platform_admin: may do everything, including countersign
const MANAGER = "dept-manager"; // may read contracts, nothing else
const IC = "gede-ic"; // a plain member: refused every one of these routes
const T = "co-agency";

const call = (method: string, path: string, user: string, body?: unknown) =>
  getDemoResponse(method, path, user, body === undefined ? undefined : JSON.stringify(body));
const rowsOf = (r: { json: unknown }) => r.json as Array<Record<string, any>>;

beforeEach(() => resetDemoBilling());

describe("demo billing · reads", () => {
  it("lists one client's contracts only, and `internal` is empty", () => {
    const r = call("GET", `/api/${T}/contracts?clientId=cl-1`, HANSEL);
    expect(r.status).toBe(200);
    expect(rowsOf(r).every((k) => k.clientId === "cl-1")).toBe(true);
    expect(rowsOf(r).map((k) => k.status).sort()).toEqual(["draft", "draft", "sent", "sent", "signed", "void"]);
    expect(rowsOf(call("GET", `/api/${T}/contracts?clientId=internal`, HANSEL))).toEqual([]);
    expect(rowsOf(call("GET", `/api/${T}/contracts?clientId=cl-2`, HANSEL))).toEqual([]);
  });

  it("🔴 canCountersign is true only for a sent, provider-unsigned row AND a caller who may countersign", () => {
    const flag = (user: string) => Object.fromEntries(rowsOf(call("GET", `/api/${T}/contracts?clientId=cl-1`, user)).map((k) => [k.id, k.canCountersign]));
    expect(flag(HANSEL)).toMatchObject({ "dk-1": true, "dk-4": true, "dk-2": false, "dk-5": false, "dk-6": false });
    // The manager may read but never countersign: no row carries the flag.
    expect(Object.values(flag(MANAGER)).every((v) => v === false)).toBe(true);
  });

  it("a caller who may not read gets a 403 (never an empty list)", () => {
    expect(call("GET", `/api/${T}/contracts?clientId=cl-1`, IC).status).toBe(403);
    expect(call("GET", `/api/${T}/invoice-payments?clientId=cl-1`, IC).status).toBe(403);
  });

  it("the detail carries the signatures", () => {
    const d = call("GET", `/api/${T}/contracts/dk-4`, HANSEL).json as { signatures: Array<{ party: string }> };
    expect(d.signatures.map((s) => s.party)).toEqual(["client"]);
  });
});

describe("demo billing · the contract flow and its refusals", () => {
  it("🔴 a draft with neither terms nor file cannot be sent (400); with terms it can", () => {
    expect(call("POST", `/api/${T}/contracts/dk-3/send`, HANSEL).status).toBe(400);
    expect(call("POST", `/api/${T}/contracts/dk-2/send`, HANSEL).status).toBe(200);
    expect(call("POST", `/api/${T}/contracts/dk-2/send`, HANSEL).status).toBe(400); // already sent
  });

  it("🔴 authorization runs BEFORE validation: a member with an empty body gets 403 on create and countersign, an admin gets 400", () => {
    expect(call("POST", `/api/${T}/contracts`, IC, {}).status).toBe(403);
    expect(call("POST", `/api/${T}/contracts`, HANSEL, {}).status).toBe(400);
    expect(call("POST", `/api/${T}/contracts/dk-4/countersign`, MANAGER, {}).status).toBe(403);
    expect(call("POST", `/api/${T}/contracts/dk-4/countersign`, HANSEL, {}).status).toBe(400);
  });

  it("🔴 a contract is Signed only when BOTH parties have signed: countersigning dk-4 (client signed first) completes it", () => {
    const r = call("POST", `/api/${T}/contracts/dk-4/countersign`, HANSEL, { signerName: "Olive Owner", signerTitle: "Owner" });
    expect(r.json).toMatchObject({ ok: true, complete: true, alreadySigned: false });
    expect((call("GET", `/api/${T}/contracts/dk-4`, HANSEL).json as { status: string }).status).toBe("signed");
    // and a repeat is idempotent
    expect(call("POST", `/api/${T}/contracts/dk-4/countersign`, HANSEL, { signerName: "Olive Owner" }).json).toMatchObject({ alreadySigned: true });
  });

  it("countersigning dk-1 (the client has NOT signed) leaves it Sent", () => {
    const r = call("POST", `/api/${T}/contracts/dk-1/countersign`, HANSEL, { signerName: "Olive Owner" });
    expect(r.json).toMatchObject({ ok: true, complete: false });
    expect((call("GET", `/api/${T}/contracts/dk-1`, HANSEL).json as { status: string }).status).toBe("sent");
  });

  it("creating is idempotent on reference, and the same reference under another client is a 409", () => {
    const a = call("POST", `/api/${T}/contracts`, HANSEL, { clientId: "cl-1", title: "New", reference: "REF-X", bodyMd: "t" });
    expect(a.status).toBe(201);
    const b = call("POST", `/api/${T}/contracts`, HANSEL, { clientId: "cl-1", title: "New", reference: "REF-X", bodyMd: "t" });
    expect(b.json).toMatchObject({ id: (a.json as { id: string }).id, deduped: true });
    expect(call("POST", `/api/${T}/contracts`, HANSEL, { clientId: "cl-3", title: "Other", reference: "REF-X" }).status).toBe(409);
  });

  it("only a draft can be edited; void works from anywhere", () => {
    expect(call("PATCH", `/api/${T}/contracts/dk-1`, HANSEL, { title: "x" }).status).toBe(400);
    expect(call("PATCH", `/api/${T}/contracts/dk-2`, HANSEL, { title: "Renamed" }).status).toBe(200);
    expect(call("PATCH", `/api/${T}/contracts/dk-1`, HANSEL, { status: "void" }).status).toBe(200);
  });
});

describe("demo billing · payments", () => {
  it("🔴 the recorder cannot decide their own payment (403 with the controller's message); someone else can", () => {
    const own = call("POST", `/api/${T}/invoice-payments/dpay-2/decide`, HANSEL, { decision: "confirm" });
    expect(own.status).toBe(403);
    expect((own.json as { error: string }).error).toMatch(/someone other than whoever recorded/);
    expect(call("POST", `/api/${T}/invoice-payments/dpay-1/decide`, HANSEL, { decision: "confirm" }).status).toBe(200);
  });

  it("🔴 reject needs a reason; a decided payment cannot be decided again; a member is refused before validation", () => {
    expect(call("POST", `/api/${T}/invoice-payments/dpay-1/decide`, HANSEL, { decision: "reject" }).status).toBe(400);
    expect(call("POST", `/api/${T}/invoice-payments/dpay-1/decide`, HANSEL, { decision: "reject", reason: "no match" }).status).toBe(200);
    expect(call("POST", `/api/${T}/invoice-payments/dpay-1/decide`, HANSEL, { decision: "confirm" }).status).toBe(400);
    expect(call("POST", `/api/${T}/invoice-payments/dpay-3/decide`, IC, {}).status).toBe(403);
  });

  it("the list filters by client and by status, pending first", () => {
    expect(rowsOf(call("GET", `/api/${T}/invoice-payments?clientId=cl-1&status=pending`, HANSEL)).map((p) => p.id)).toEqual(["dpay-1"]);
    call("POST", `/api/${T}/invoice-payments/dpay-1/decide`, HANSEL, { decision: "confirm" });
    expect(rowsOf(call("GET", `/api/${T}/invoice-payments?clientId=cl-1&status=pending`, HANSEL))).toEqual([]);
  });
});

describe("demo billing · the hub Overview agrees with the store", () => {
  it("🔴 deciding a payment clears its 'waiting on us' item, and sending a draft moves it to 'waiting on the client'", () => {
    expect(demoBillingNeedsUs("cl-1").filter((i) => i.kind === "payment").map((i) => i.id)).toEqual(["dpay-1"]);
    call("POST", `/api/${T}/invoice-payments/dpay-1/decide`, HANSEL, { decision: "confirm" });
    expect(demoBillingNeedsUs("cl-1").filter((i) => i.kind === "payment")).toEqual([]);

    expect(demoBillingNeedsClient("cl-1").map((i) => i.id)).toEqual(["dk-1"]);
    call("POST", `/api/${T}/contracts/dk-2/send`, HANSEL);
    expect(demoBillingNeedsClient("cl-1").map((i) => i.id).sort()).toEqual(["dk-1", "dk-2"]);
  });

  it("every item links to the billing page, not to the old /commercial route", () => {
    for (const i of [...demoBillingNeedsUs("cl-1"), ...demoBillingNeedsClient("cl-1")]) expect(i.href).toBe("/clients/cl-1/billing");
  });

  it("the Overview payload built from the store is what the hub renders", () => {
    const o = call("GET", `/api/${T}/clients/cl-1/overview`, HANSEL).json as { needsUs: Array<{ kind: string; href: string }>; needsClient: Array<{ kind: string; href: string }> };
    expect(o.needsUs.filter((i) => i.kind === "payment" || i.kind === "contract").every((i) => i.href === "/clients/cl-1/billing")).toBe(true);
    expect(o.needsClient.filter((i) => i.kind === "contract").every((i) => i.href === "/clients/cl-1/billing")).toBe(true);
  });
});
