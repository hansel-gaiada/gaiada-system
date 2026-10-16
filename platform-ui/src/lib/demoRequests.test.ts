import { describe, it, expect, beforeEach } from "vitest";
import { DEMO_ROUTE_IDS, requestsDemo, resetRequestsDemo, setDemoRoute } from "./demoRequests";
import { getDemoResponse } from "./demoFixtures";

// DW-10e: the demo store answers the sender routes, the receiving side's new fields and the cancel rules in the SERVER's order of checks
// (BFF §60.5, §60.6), so the demo can be driven without a backend and teaches nothing the real thing does not do.
const SENDER = "u-resort"; // Ni Luh Sekar, a plain member of Viceroy (co-resort)
const COLLEAGUE = "demo-viceroy-marketing"; // Made Sari, another plain member of Viceroy
const ADMIN = "demo-hansel";
const OWNER = "demo-owner";
const CREATIVE = "u-creative"; // a member of the agency, in Creatives
const CLIENT = "demo-client";

type Out = { status: number; json: any };
const call = (method: string, path: string, user: string, body?: unknown): Out => {
  const q = new URL(path, "http://demo");
  const r = requestsDemo(method, q.pathname, q.searchParams, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), user);
  if (!r) throw new Error(`not answered: ${method} ${path}`);
  return r as Out;
};
const get = (path: string, user: string) => call("GET", path, user);
const post = (path: string, user: string, body?: unknown) => call("POST", path, user, body);

const FORM = { deliverables: [{ format: "image", size: "1080x1350", quantity: 2 }] };
const send = (user: string, over: Record<string, unknown> = {}, tenant = "co-resort") =>
  post(`/api/${tenant}/requests/outbound`, user, { routeId: DEMO_ROUTE_IDS.creativesToViceroy, title: "DEMO Test banners", form: FORM, ...over });

beforeEach(() => resetRequestsDemo());

describe("the routes (DW-D39)", () => {
  it("answers Viceroy's two routes to the agency's Creatives and Web Dev, from Viceroy's own URL", () => {
    const r = get("/api/co-resort/requests/routes", SENDER);
    expect(r.status).toBe(200);
    expect(r.json.enabled).toBe(true);
    expect(r.json.routes).toEqual([
      { routeId: DEMO_ROUTE_IDS.creativesToViceroy, kind: "assets", company: { id: "co-agency", name: "Gaia Digital Agency" }, unit: { name: "Creatives" } },
      { routeId: DEMO_ROUTE_IDS.webDevToViceroy, kind: "engineering", company: { id: "co-agency", name: "Gaia Digital Agency" }, unit: { name: "Web Dev" } },
    ]);
  });

  it("answers the holding's two routes too, and none for the agency itself (it is the provider)", () => {
    expect(get("/api/co-holding/requests/routes", ADMIN).json.routes.map((x: { unit: { name: string } }) => x.unit.name)).toEqual(["Creatives", "Web Dev"]);
    expect(get("/api/co-agency/requests/routes", CREATIVE).json.routes).toEqual([]);
  });

  it("lists only active routes whose unit is active", () => {
    setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { status: "suspended" });
    setDemoRoute(DEMO_ROUTE_IDS.webDevToViceroy, { unitActive: false });
    expect(get("/api/co-resort/requests/routes", SENDER).json.routes).toEqual([]);
  });

  it("is 403 for a client contact and for a person who is not in the company", () => {
    expect(get("/api/co-resort/requests/routes", CLIENT).status).toBe(403);
    expect(get("/api/co-resort/requests/routes", CREATIVE).status).toBe(403);
  });
});

describe("sending, in the server's order of checks (§60.5)", () => {
  it("201 with the id, the kind (the route's) and the receiving company", () => {
    const r = send(SENDER);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "assets", receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" } });
    expect(typeof r.json.id).toBe("string");
  });

  it("403 comes first: a client contact with a malformed body, and a person outside the company, are refused before any body check", () => {
    expect(post("/api/co-resort/requests/outbound", CLIENT, "{not json").status).toBe(403);
    expect(send(CREATIVE).status).toBe(403);
    expect(send(CLIENT, { title: "" }).status).toBe(403);
  });

  it("400 body_invalid for a body that is not an object", () => {
    expect(post("/api/co-resort/requests/outbound", SENDER, "{not json")).toMatchObject({ status: 400, json: { reason: "body_invalid" } });
    expect(post("/api/co-resort/requests/outbound", SENDER, "[1]")).toMatchObject({ status: 400, json: { reason: "body_invalid" } });
  });

  it("with a kind in the body, the form is checked BEFORE the route; without one, AFTER it", () => {
    // kind given: a bad title is 400 even though the route is unknown.
    expect(send(SENDER, { kind: "assets", title: "", routeId: "5a0c0000-0000-4000-8000-0000000000ff" })).toMatchObject({ status: 400, json: { reason: "title_invalid", field: "title" } });
    // kind absent: the unknown route is 404 even though the title is bad.
    expect(send(SENDER, { title: "", routeId: "5a0c0000-0000-4000-8000-0000000000ff" })).toMatchObject({ status: 404, json: { reason: "route_not_found" } });
    // kind absent, route found: now the form is checked.
    expect(send(SENDER, { title: "" })).toMatchObject({ status: 400, json: { reason: "title_invalid" } });
  });

  it("400 for each field of the form, with the field the form shows it beside", () => {
    expect(send(SENDER, { form: { deliverables: [{ format: "image", quantity: 99 }] } }).json).toMatchObject({ reason: "form_invalid", field: "form.deliverables[0].quantity" });
    expect(send(SENDER, { form: { deliverables: [{ format: "cake", quantity: 1 }] } }).json).toMatchObject({ reason: "form_invalid", field: "form.deliverables[0].format" });
    expect(send(SENDER, { form: { deliverables: [] } }).json).toMatchObject({ reason: "form_invalid", field: "form.deliverables" });
    expect(send(SENDER, { neededBy: "2026-02-30" }).json).toMatchObject({ reason: "date_invalid", field: "neededBy" });
    expect(send(SENDER, { brief: "x".repeat(10_001) }).json).toMatchObject({ reason: "brief_too_long" });
    const eng = (form: unknown) => send(SENDER, { routeId: DEMO_ROUTE_IDS.webDevToViceroy, kind: "engineering", form });
    expect(eng({ kind: "mystery" }).json).toMatchObject({ reason: "form_invalid", field: "form.kind" });
    expect(eng({ kind: "bug" }).status).toBe(201);
  });

  it("400 route_invalid for a route id that is not uuid-shaped, kind_invalid for a kind that is not the route's, and to_unit_invalid and campaign_part_invalid", () => {
    expect(send(SENDER, { routeId: "creatives" })).toMatchObject({ status: 400, json: { reason: "route_invalid" } });
    expect(send(SENDER, { routeId: undefined })).toMatchObject({ status: 400, json: { reason: "route_invalid" } });
    // A kind in the body parses the form with it first (BFF §60.14), so a mismatch with the route shows once the form fits that kind.
    expect(send(SENDER, { kind: "engineering" })).toMatchObject({ status: 400, json: { reason: "form_invalid" } });
    expect(send(SENDER, { kind: "engineering", form: { kind: "bug" } })).toMatchObject({ status: 400, json: { reason: "kind_invalid" } });
    expect(send(SENDER, { kind: "mystery" })).toMatchObject({ status: 400, json: { reason: "kind_invalid" } });
    expect(send(SENDER, { toUnitId: "dept-2" })).toMatchObject({ status: 400, json: { reason: "to_unit_invalid" } });
    expect(send(SENDER, { campaignPartId: "p1" })).toMatchObject({ status: 400, json: { reason: "campaign_part_invalid" } });
    // `null` reads as "none".
    expect(send(SENDER, { toUnitId: null, campaignPartId: null }).status).toBe(201);
  });

  it("404 route_not_found for an unknown route and for a route that is another company's", () => {
    expect(send(SENDER, { routeId: "5a0c0000-0000-4000-8000-0000000000ff" })).toMatchObject({ status: 404, json: { reason: "route_not_found" } });
    // The holding's route, used by Viceroy.
    expect(send(SENDER, { routeId: "5a0c0000-0000-4000-8000-000000000003" })).toMatchObject({ status: 404, json: { reason: "route_not_found" } });
  });

  it("409 route_inactive with detail.status: proposed, suspended, revoked, and orphaned (an active route on a removed unit)", () => {
    for (const status of ["proposed", "suspended", "revoked"] as const) {
      setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { status });
      expect(send(SENDER), status).toMatchObject({ status: 409, json: { reason: "route_inactive", detail: { status } } });
    }
    setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { status: "active", unitActive: false });
    expect(send(SENDER)).toMatchObject({ status: 409, json: { reason: "route_inactive", detail: { status: "orphaned" } } });
  });

  it("409 route_unit_unavailable, group_client_missing and group_client_ambiguous, in that order after route_inactive", () => {
    setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { unitAvailable: false, clientRecords: 0 });
    expect(send(SENDER).json.reason).toBe("route_unit_unavailable");
    setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { unitAvailable: true });
    expect(send(SENDER).json.reason).toBe("group_client_missing");
    setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { clientRecords: 2 });
    expect(send(SENDER).json.reason).toBe("group_client_ambiguous");
    setDemoRoute(DEMO_ROUTE_IDS.creativesToViceroy, { status: "suspended" });
    expect(send(SENDER).json.reason).toBe("route_inactive");
  });
});

describe("the sender's lists and the scope (DW-D40)", () => {
  it("a member reads only their own: scope own, every box", () => {
    const l = get("/api/co-resort/requests/outbound?box=all&status=all", SENDER);
    expect(l.json.scope).toBe("own");
    expect(l.json.rows.length).toBeGreaterThan(0);
    for (const row of l.json.rows) expect(row.requestedBy.id).toBe(SENDER);
    const colleague = get("/api/co-resort/requests/outbound?box=all&status=all", COLLEAGUE);
    expect(colleague.json.scope).toBe("own");
    expect(colleague.json.rows.map((x: { id: string }) => x.id)).toEqual(["wr-across-4"]);
  });

  it("an administrator and the owner read every request the company sent: scope company", () => {
    for (const user of [ADMIN, OWNER]) {
      const l = get("/api/co-resort/requests/outbound?box=all&status=all", user);
      expect(l.json.scope, user).toBe("company");
      expect(l.json.rows.map((x: { id: string }) => x.id).sort()).toEqual(["wr-across-1", "wr-across-2", "wr-across-3", "wr-across-4", "wr-across-5"]);
    }
  });

  it("never lists another company's requests, nor the receiver's own", () => {
    const holding = get("/api/co-holding/requests/outbound?box=all&status=all", ADMIN);
    expect(holding.json.rows.map((x: { id: string }) => x.id)).toEqual(["wr-across-6"]);
    expect(get("/api/co-agency/requests/outbound?box=all&status=all", ADMIN).json.rows).toEqual([]);
  });

  it("mine, sent (by the requester's department) and status filters; newest first", () => {
    const mine = get("/api/co-resort/requests/outbound?box=mine&status=open", ADMIN);
    expect(mine.json.rows).toEqual([]); // hansel sent nothing from Viceroy
    const sent = get("/api/co-resort/requests/outbound?box=sent&unitId=hosp-dept-1&status=all", SENDER);
    const dates = sent.json.rows.map((x: { createdAt: string }) => Date.parse(x.createdAt));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(sent.json.rows.length).toBe(4);
    const closed = get("/api/co-resort/requests/outbound?box=mine&status=closed", SENDER);
    expect(closed.json.rows.map((x: { status: string }) => x.status)).toEqual(["delivered"]);
    const engineering = get("/api/co-resort/requests/outbound?box=mine&status=all&kind=engineering", SENDER);
    expect(engineering.json.rows.every((x: { kind: string }) => x.kind === "engineering")).toBe(true);
  });

  it("400 for a missing or unknown box, an unknown status and a sent box without a unit", () => {
    expect(get("/api/co-resort/requests/outbound", SENDER).json.reason).toBe("box_invalid");
    expect(get("/api/co-resort/requests/outbound?box=everything", SENDER).json.reason).toBe("box_invalid");
    expect(get("/api/co-resort/requests/outbound?box=mine&status=nope", SENDER).json.reason).toBe("status_invalid");
    expect(get("/api/co-resort/requests/outbound?box=sent", SENDER).json.reason).toBe("unit_invalid");
  });

  it("the summary counts open requests of the department, in the caller's scope", () => {
    expect(get("/api/co-resort/requests/outbound/summary?unitId=hosp-dept-1", SENDER).json).toEqual({ scope: "own", sent: { open: 3 } });
    expect(get("/api/co-resort/requests/outbound/summary?unitId=hosp-dept-1", ADMIN).json.scope).toBe("company");
    expect(get("/api/co-resort/requests/outbound/summary", SENDER).status).toBe(400);
  });
});

describe("the sender's detail", () => {
  it("is the row plus brief, form, decline reason and assets; another person's request is 404 to a member, 200 to an administrator", () => {
    const own = get("/api/co-resort/requests/outbound/wr-across-1", SENDER);
    expect(own.status).toBe(200);
    expect(own.json).toMatchObject({ id: "wr-across-1", brief: expect.any(String), form: expect.any(Object), declineReason: null, assets: [] });
    expect(get("/api/co-resort/requests/outbound/wr-across-4", SENDER)).toMatchObject({ status: 404, json: { reason: "request_not_found" } });
    expect(get("/api/co-resort/requests/outbound/wr-across-4", ADMIN).status).toBe(200);
    expect(get("/api/co-resort/requests/outbound/nope", ADMIN).status).toBe(404);
    // Another company's request, by id, under the wrong company.
    expect(get("/api/co-resort/requests/outbound/wr-across-6", ADMIN).status).toBe(404);
  });

  it("lists a delivered request's assets with the sender's own download route, and its files", () => {
    const d = get("/api/co-resort/requests/outbound/wr-across-3", SENDER);
    expect(d.json.assets).toEqual([{ id: "ast-demo-1", name: "DEMO spring menu cover.png", contentType: "image/png", href: "/api/co-resort/requests/outbound/wr-across-3/assets/ast-demo-1/content" }]);
    const files = get("/api/co-resort/requests/outbound/wr-across-3/files", SENDER);
    expect(files.json.map((f: { id: string }) => f.id)).toEqual(["f-demo-1"]);
    expect(get("/api/co-resort/requests/outbound/wr-across-4/files", SENDER).status).toBe(404);
  });

  it("carries NO id of the receiver's work and NO amount: the price is two words", () => {
    const rows = get("/api/co-resort/requests/outbound?box=all&status=all", ADMIN).json.rows as Record<string, any>[];
    for (const row of rows) {
      expect(row.work.id, row.id).toBeUndefined();
      expect(row.work.projectId, row.id).toBeUndefined();
      expect(row.campaign).toBeNull();
      expect(row.fromUnit?.id ?? "hosp-dept-1").toBe("hosp-dept-1");
      if (row.kind === "engineering") expect(Object.keys(row.price).sort()).toEqual(["agreement", "impact"]);
      else expect(row.price).toBeNull();
    }
    const text = JSON.stringify(get("/api/co-resort/requests/outbound/wr-across-2", SENDER).json);
    expect(text).not.toMatch(/amount|currency|rate|invoice|contract|value|hours|task-|cr-wr/i);
    expect(get("/api/co-resort/requests/outbound/wr-across-2", SENDER).json.price).toEqual({ impact: "changes_price", agreement: "awaiting_signature" });
  });
});

describe("Cancel by the sender", () => {
  it("cancels the requester's own open asset request", () => {
    expect(post("/api/co-resort/requests/outbound/wr-across-1/cancel", SENDER)).toMatchObject({ status: 200, json: { id: "wr-across-1", status: "cancelled" } });
    expect(get("/api/co-resort/requests/outbound/wr-across-1", SENDER).json.status).toBe("cancelled");
  });

  it("is 404 for another person's request (never an oracle) and 403 to the owner, who reads everything but holds no cancel", () => {
    expect(post("/api/co-resort/requests/outbound/wr-across-4/cancel", SENDER).status).toBe(404);
    expect(post("/api/co-resort/requests/outbound/wr-across-4/cancel", OWNER).status).toBe(403);
    expect(post("/api/co-resort/requests/outbound/wr-across-4/cancel", ADMIN).status).toBe(200);
  });

  it("409 request_not_open with the status, and nothing is changed", () => {
    expect(post("/api/co-resort/requests/outbound/wr-across-3/cancel", SENDER)).toMatchObject({ status: 409, json: { reason: "request_not_open", detail: { status: "delivered" } } });
  });

  it("409 price_agreement_open while a draft, sent or signed agreement is live; allowed once it is closed or the change is unassessed", () => {
    expect(post("/api/co-resort/requests/outbound/wr-across-2/cancel", SENDER)).toMatchObject({ status: 409, json: { reason: "price_agreement_open", detail: { agreement: "awaiting_signature" } } });
    expect(post("/api/co-resort/requests/outbound/wr-across-5/cancel", SENDER).status).toBe(200);
  });

  it("is 404 under another company, and 403 for a client contact", () => {
    expect(post("/api/co-holding/requests/outbound/wr-across-1/cancel", ADMIN).status).toBe(404);
    expect(post("/api/co-resort/requests/outbound/wr-across-1/cancel", CLIENT).status).toBe(403);
  });
});

describe("the receiving side (§60.6)", () => {
  it("lists a cross row in Creatives' Incoming with the requesting company, its department and the client; a same-company row has nulls", () => {
    const inc = get("/api/co-agency/requests?box=incoming&unitId=dept-2&status=open", CREATIVE).json as Record<string, any>[];
    const cross = inc.find((r) => r.id === "wr-across-1")!;
    expect(cross).toMatchObject({
      fromUnit: null, requestingCompany: { id: "co-resort", name: "Viceroy" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" }, client: { id: "cl-viceroy", name: "Viceroy" },
      work: { type: "pm_task", id: expect.any(String) },
    });
    const same = inc.find((r) => r.id === "wr-same-1")!;
    expect([same.requestingCompany, same.requesterUnit, same.client]).toEqual([null, null, null]);
    expect(same.fromUnit).toMatchObject({ id: "dept-3", name: "SEO" });
    // Oldest first, as the server has it.
    const dates = inc.map((r) => Date.parse(r.createdAt));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it("a new cross request shows up there at once", () => {
    const id = send(SENDER, { title: "DEMO Brand new ask" }).json.id as string;
    const inc = get("/api/co-agency/requests?box=incoming&unitId=dept-2&status=open", CREATIVE).json as { id: string; title: string }[];
    expect(inc.find((r) => r.id === id)?.title).toBe("DEMO Brand new ask");
  });

  it("the receiver's `mine` leaves a cross request out (a person in both companies would otherwise find it), and `sent` never matches it", () => {
    const mine = get("/api/co-agency/requests?box=mine&status=all", ADMIN).json as { id: string }[];
    expect(mine.find((r) => r.id === "wr-across-6")).toBeUndefined();
    const sent = get("/api/co-agency/requests?box=sent&unitId=hosp-dept-1&status=all", ADMIN).json as unknown[];
    expect(sent).toEqual([]);
  });

  it("the detail names the other company; a request of another company is 404 here", () => {
    const d = get("/api/co-agency/requests/wr-across-1", CREATIVE).json;
    expect(d).toMatchObject({ requestingCompany: { name: "Viceroy" }, client: { name: "Viceroy" }, brief: expect.any(String) });
    expect(get("/api/co-resort/requests/wr-across-1", SENDER).status).toBe(404);
  });

  it("a sender holds no right in the receiving company: every §32 route under it is 403", () => {
    expect(get("/api/co-agency/requests?box=incoming&unitId=dept-2", SENDER).status).toBe(403);
    expect(get("/api/co-agency/requests/wr-across-1", SENDER).status).toBe(403);
    expect(post("/api/co-agency/requests/wr-across-1/cancel", SENDER).status).toBe(403);
  });

  it("the receiving side cannot cancel a cross row: 409 requester_side_only, whoever it is", () => {
    for (const user of [CREATIVE, ADMIN]) {
      expect(post("/api/co-agency/requests/wr-across-1/cancel", user), user).toMatchObject({ status: 409, json: { reason: "requester_side_only" } });
    }
    expect(get("/api/co-resort/requests/outbound/wr-across-1", SENDER).json.status).toBe("open");
  });

  it("the receiving side still declines one, and the sender sees it declined with the reason", () => {
    expect(post("/api/co-agency/requests/wr-across-1/decline", CREATIVE, { reason: "x" }).status).toBe(403); // a plain member cannot decide
    expect(post("/api/co-agency/requests/wr-across-1/decline", ADMIN, { reason: "" }).json.reason).toBe("reason_invalid");
    expect(post("/api/co-agency/requests/wr-across-1/decline", ADMIN, { reason: "Out of scope" }).status).toBe(200);
    const d = get("/api/co-resort/requests/outbound/wr-across-1", SENDER).json;
    expect(d).toMatchObject({ status: "declined", declineReason: "Out of scope" });
  });

  it("a same-company request is cancelled by its requester as before", () => {
    expect(post("/api/co-agency/requests/wr-same-1/cancel", "u-seo")).toMatchObject({ status: 200, json: { status: "cancelled" } });
    expect(post("/api/co-agency/requests/wr-same-1/cancel", "u-seo").json.reason).toBe("request_not_open");
  });

  it("does not serve `requests/summary` on purpose (the Overview's Requests block stays 'Unavailable' in the demo, DW-3f)", () => {
    expect(get("/api/co-agency/requests/summary?unitId=dept-2", CREATIVE).status).toBe(404);
  });
});

describe("the demo dispatcher", () => {
  it("routes /api/:tenant/requests through the full dispatcher, ahead of anything that could swallow it", () => {
    const r = getDemoResponse("GET", "/api/co-resort/requests/routes", SENDER);
    expect(r.status).toBe(200);
    expect((r.json as { routes: unknown[] }).routes).toHaveLength(2);
    expect(getDemoResponse("GET", "/api/co-resort/requests/outbound?box=mine&status=open", SENDER).status).toBe(200);
    expect(getDemoResponse("GET", "/api/co-agency/requests?box=incoming&unitId=dept-2&status=open", CREATIVE).status).toBe(200);
  });

  it("answers null for anything else", () => {
    expect(requestsDemo("GET", "/api/co-agency/projects", new URLSearchParams(), undefined, CREATIVE)).toBeNull();
    expect(requestsDemo("GET", "/api/co-agency/requests-other", new URLSearchParams(), undefined, CREATIVE)).toBeNull();
  });
});

describe("ORG-13 in the demo: a route places nobody and needs the provider's client (BFF §60.2)", () => {
  const unitPath = "/api/co-agency/org-structure/units/dept-2/assignments";
  const dry = (b: unknown) => getDemoResponse("POST", `${unitPath}?dryRun=1`, ADMIN, JSON.stringify(b)) as Out;
  const propose = (b: unknown) => getDemoResponse("POST", unitPath, ADMIN, JSON.stringify(b)) as Out;

  it("the dry run of a routing key is route-only with nobody listed, and marks a target that is not a client", () => {
    const r = dry({ targets: ["co-resort", "co-holding", "co-nowhere"], module: "asset_requests" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, routeOnly: true, items: [] });
    expect(r.json.companies.map((c: { id: string; included: boolean; reason?: string }) => [c.id, c.included, c.reason])).toEqual([
      ["co-resort", true, undefined], ["co-holding", true, undefined], ["co-nowhere", false, "no_group_client"],
    ]);
  });

  it("a module's dry run is as it was: it lists who would be served", () => {
    const r = dry({ targets: ["co-resort"], module: "hr" });
    expect(r.json.routeOnly).toBeUndefined();
    expect(r.json.items.length).toBeGreaterThan(0);
  });

  it("propose refuses a route with a lead (422 route_has_no_lead) and a target with no client record (422 route_needs_group_client, with the target)", () => {
    expect(propose({ targets: ["co-resort"], module: "asset_requests", leadUserId: "u-1" })).toMatchObject({ status: 422, json: { reason: "route_has_no_lead" } });
    expect(propose({ targets: ["co-nowhere"], module: "engineering_requests" })).toMatchObject({ status: 422, json: { reason: "route_needs_group_client", detail: { targetId: "co-nowhere" } } });
    expect(propose({ targets: ["co-resort"], module: "asset_requests" }).status).toBe(201);
  });
});
