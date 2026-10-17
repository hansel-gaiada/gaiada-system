import { describe, it, expect } from "vitest";
import {
  findRoute, fromText, hasLiveAgreement, mergeNewestFirst, mergeSentReads, normalizeOutboundFiles, normalizeOutboundSummary, normalizePrice,
  normalizeRequestDetail, normalizeRequestRow, normalizeRoutes, outboundActions, outboundAssetHref, outboundBodyFrom, outboundFileHref, priceText,
  receiverText, requestActions, requestErrorText, requestHref, routeAskLabel, routeHref, routeToText, sentScopeCopy, toText, originsByChangeRequest,
  type RequestRoute, type RequestRow, type WorkState,
} from "./requests";

// DW-10e (docs/FRONTEND-BFF-CONTRACT.md §60): the pure half of the UI for requests across group companies: what the wire sends, what a person
// reads, who is offered Cancel, how the two reads merge, and every refusal of §60.5 as a sentence.

const wireSender = (over: Record<string, unknown> = {}) => ({
  id: "r1", kind: "assets", title: "Banners", status: "open", neededBy: null, createdAt: "2026-10-12T03:00:00.000Z", closedAt: null,
  fromUnit: { id: "hosp-dept-1", name: "Front Office", unitMissing: false }, toUnit: { id: "dept-2", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u-resort", name: "Ni Luh Sekar" }, campaign: null,
  // §60.5: the sender's `work` carries NO ids.
  work: { type: "pm_task", status: "in_progress", isDone: false, responsibleName: "Putu Rani" }, assetCount: 0,
  receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" }, routeId: "5a0c0000-0000-4000-8000-000000000001", price: null, ...over,
});
const wireReceiver = (over: Record<string, unknown> = {}) => ({
  id: "r2", kind: "assets", title: "Banners", status: "open", neededBy: null, createdAt: "2026-10-12T03:00:00.000Z", closedAt: null,
  fromUnit: null, toUnit: { id: "dept-2", name: "Creatives", unitMissing: false }, requestedBy: { id: "u-resort", name: "Ni Luh Sekar" }, campaign: null,
  work: { type: "pm_task", id: "t1", projectId: null, status: "in_progress", isDone: false, responsibleName: "Putu Rani" }, assetCount: 0,
  requestingCompany: { id: "co-resort", name: "Viceroy" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" }, client: { id: "cl-viceroy", name: "Viceroy" }, ...over,
});
const row = (over: Partial<RequestRow> = {}): RequestRow => ({ ...normalizeRequestRow(wireSender(), { outbound: true })!, ...over });
const route = (over: Partial<RequestRoute> = {}): RequestRoute => ({
  routeId: "5a0c0000-0000-4000-8000-000000000001", kind: "assets", company: { id: "co-agency", name: "Gaia Digital Agency" }, unit: { name: "Creatives" }, ...over,
});

describe("the sender's rows (§60.5)", () => {
  it("reads a row that names the receiving company and carries no ids of the receiver's work", () => {
    const r = normalizeRequestRow(wireSender(), { outbound: true })!;
    expect(r.receivingCompany).toEqual({ id: "co-agency", name: "Gaia Digital Agency" });
    expect(r.routeId).toBe("5a0c0000-0000-4000-8000-000000000001");
    // An id-less pm_task is a live work item on the sender's wire (it is "unknown" on §32's, where the id is required).
    expect(r.work).toEqual({ state: "live", work: { type: "pm_task", id: "", projectId: null, status: "in_progress", isDone: false, responsibleName: "Putu Rani" } });
    expect(normalizeRequestRow(wireSender(), { outbound: false })!.work).toEqual({ state: "unknown" });
    expect(r.requestingCompany).toBeNull();
  });

  it("keeps a unit that has a name and no id (another company's tree), only on the sender's wire", () => {
    const wire = wireSender({ toUnit: { name: "Creatives" } });
    expect(normalizeRequestRow(wire, { outbound: true })!.toUnit).toEqual({ id: "", name: "Creatives", unitMissing: false });
    expect(normalizeRequestRow(wire)!.toUnit.unitMissing).toBe(true);
  });

  it("reads a change request's status without an id", () => {
    const r = normalizeRequestRow(wireSender({ kind: "engineering", work: { type: "change_request", status: "new" }, price: { impact: "none", agreement: null } }), { outbound: true })!;
    expect(r.work).toEqual({ state: "live", work: { type: "change_request", id: "", status: "new", route: null } });
  });

  it("opens a request to another company on the sender's page, and any other at the ordinary one", () => {
    expect(requestHref(row({ id: "a b" }))).toBe("/requests/outbound/a%20b");
    expect(requestHref({ id: "r9", receivingCompany: null })).toBe("/requests/r9");
    expect(requestHref({ id: "r9" })).toBe("/requests/r9");
  });

  it("reads the detail with its assets, and the downloads go through the UI proxies", () => {
    const d = normalizeRequestDetail({ ...wireSender(), brief: "b", form: { a: 1 }, declineReason: null, assets: [{ id: "a1", name: "x.png", contentType: "image/png", href: "/api/co-resort/requests/outbound/r1/assets/a1/content" }] }, { outbound: true })!;
    expect(d.assets).toEqual([{ id: "a1", name: "x.png", contentType: "image/png", href: "/api/co-resort/requests/outbound/r1/assets/a1/content" }]);
    expect(outboundAssetHref("r 1", "a/1")).toBe("/api/requests/outbound/r%201/assets/a%2F1");
    expect(outboundFileHref("r1", "f1")).toBe("/api/requests/outbound/r1/files/f1");
  });

  it("reads the files, a link row included, and refuses a payload that is not a list", () => {
    expect(normalizeOutboundFiles([
      { id: "f1", filename: "a.pdf", contentType: "application/pdf", byteSize: 10, createdAt: "2026-10-01", url: null },
      { id: "f2", filename: "Brief", contentType: "", byteSize: null, createdAt: null, url: "https://drive.example/x" },
      { nope: true },
    ])).toEqual([
      { id: "f1", filename: "a.pdf", contentType: "application/pdf", byteSize: 10, createdAt: "2026-10-01", url: null },
      { id: "f2", filename: "Brief", contentType: "", byteSize: null, createdAt: null, url: "https://drive.example/x" },
    ]);
    expect(normalizeOutboundFiles({ files: [] })).toBeNull();
  });
});

describe("the price (DW-D41): a state, never an amount", () => {
  it("reads two words from a closed vocabulary and copies nothing else", () => {
    const p = normalizePrice({ impact: "changes_price", agreement: "signed", amount: 12_000_000, currency: "IDR", contractId: "c-1", terms: "x" });
    expect(p).toEqual({ impact: "changes_price", agreement: "signed" });
    expect(Object.keys(p!).sort()).toEqual(["agreement", "impact"]);
  });

  it("holds an agreement only when the impact changes the price, and reads an unknown word as unreadable", () => {
    expect(normalizePrice({ impact: "none", agreement: "signed" })).toEqual({ impact: "none", agreement: null });
    expect(normalizePrice({ impact: "huge", agreement: null })).toBeNull();
    expect(normalizePrice({ impact: "changes_price", agreement: "paid-in-full" })).toEqual({ impact: "changes_price", agreement: null });
    expect(normalizePrice(null)).toBeNull();
    expect(normalizePrice("12000")).toBeNull();
  });

  it("drops an amount that reaches the row, whatever it is called", () => {
    const r = normalizeRequestRow(wireSender({ kind: "engineering", work: { type: "change_request", status: "new" }, price: { impact: "changes_price", agreement: "preparing", amount: 5_000_000, value: "Rp 5.000.000" } }), { outbound: true })!;
    expect(JSON.stringify(r)).not.toMatch(/5000000|5\.000\.000|amount|value/);
  });

  it("says each state in words: preparing, awaiting signature, signed, closed", () => {
    const names = { provider: "Gaia Digital Agency", requester: "Viceroy" };
    expect(priceText({ impact: "unassessed", agreement: null }, names)).toBe("Not assessed yet");
    expect(priceText({ impact: "none", agreement: null }, names)).toBe("No price change");
    expect(priceText({ impact: "changes_price", agreement: "preparing" }, names)).toBe("Gaia Digital Agency is preparing a price agreement");
    expect(priceText({ impact: "changes_price", agreement: null }, names)).toBe("Gaia Digital Agency is preparing a price agreement");
    expect(priceText({ impact: "changes_price", agreement: "awaiting_signature" }, names)).toBe("Waiting for Viceroy's signature in Gaia Digital Agency's client portal");
    expect(priceText({ impact: "changes_price", agreement: "signed" }, names)).toBe("Price agreed");
    expect(priceText({ impact: "changes_price", agreement: "closed" }, names)).toBe("The price agreement was declined or withdrawn; Gaia Digital Agency will re-assess");
    expect(priceText(null, names)).toBe("The price state cannot be read.");
  });

  it("no sentence carries a number with a currency", () => {
    const currency = /(?:rp|idr|usd|eur|\$|€|£)\s?\d|\d[\d.,]*\s?(?:rp|idr|usd|eur|rupiah|\$|€|£)/i;
    const names = { provider: "Gaia Digital Agency", requester: "Viceroy" };
    for (const impact of ["unassessed", "none", "changes_price"] as const) {
      for (const agreement of [null, "preparing", "awaiting_signature", "signed", "closed"] as const) {
        expect(priceText({ impact, agreement }, names)).not.toMatch(currency);
      }
    }
  });

  it("holds a live agreement while one is a draft, sent or signed", () => {
    expect(hasLiveAgreement({ impact: "changes_price", agreement: "preparing" })).toBe(true);
    expect(hasLiveAgreement({ impact: "changes_price", agreement: "awaiting_signature" })).toBe(true);
    expect(hasLiveAgreement({ impact: "changes_price", agreement: "signed" })).toBe(true);
    expect(hasLiveAgreement({ impact: "changes_price", agreement: "closed" })).toBe(false);
    expect(hasLiveAgreement({ impact: "none", agreement: null })).toBe(false);
    expect(hasLiveAgreement(null)).toBe(false);
  });
});

describe("the receiving side (§60.6)", () => {
  it("reads the requesting company, its department and the client, and null on a same-company row", () => {
    const r = normalizeRequestRow(wireReceiver())!;
    expect(r.requestingCompany).toEqual({ id: "co-resort", name: "Viceroy" });
    expect(r.requesterUnit).toEqual({ id: "hosp-dept-1", name: "Front Office" });
    expect(r.client).toEqual({ id: "cl-viceroy", name: "Viceroy" });
    expect(r.receivingCompany).toBeNull();
    const same = normalizeRequestRow(wireReceiver({ requestingCompany: null, requesterUnit: null, client: null, fromUnit: { id: "d", name: "SEO", unitMissing: false } }))!;
    expect([same.requestingCompany, same.requesterUnit, same.client]).toEqual([null, null, null]);
  });

  it("names the company and the department it asked from, else the department", () => {
    expect(fromText(normalizeRequestRow(wireReceiver())!)).toBe("Viceroy · Front Office");
    expect(fromText(normalizeRequestRow(wireReceiver({ requesterUnit: null }))!)).toBe("Viceroy");
    expect(fromText(normalizeRequestRow(wireReceiver({ requestingCompany: null, requesterUnit: null, fromUnit: { id: "d", name: "SEO", unitMissing: false } }))!)).toBe("SEO");
  });

  it("puts the same words in Web Dev's Origin column", () => {
    const eng = normalizeRequestRow(wireReceiver({ kind: "engineering", work: { type: "change_request", id: "cr-1", status: "new", route: null } }))!;
    expect(originsByChangeRequest([eng])["cr-1"]).toEqual({ requestId: "r2", from: "Viceroy · Front Office", person: "Ni Luh Sekar" });
  });

  it("never offers Cancel on a request another company asked for, even to the person who asked", () => {
    const cross = normalizeRequestRow(wireReceiver())!;
    expect(requestActions(cross, { isRequester: true, canDecide: false, isAssignee: false }).cancel).toBe(false);
    expect(requestActions(cross, { isRequester: true, canDecide: true, isAssignee: true }).cancel).toBe(false);
    // The receiving side still delivers and declines it.
    expect(requestActions(cross, { isRequester: false, canDecide: true, isAssignee: false })).toMatchObject({ deliver: true, decline: true, cancel: false });
    const same = normalizeRequestRow(wireReceiver({ requestingCompany: null, requesterUnit: null, client: null }))!;
    expect(requestActions(same, { isRequester: true, canDecide: false, isAssignee: false }).cancel).toBe(true);
  });
});

describe("Cancel on the sender's page (§60.9)", () => {
  const eng = (workStatus: string, price: RequestRow["price"], status = "open") =>
    row({ kind: "engineering", status, price, work: { state: "live", work: { type: "change_request", id: "", status: workStatus, route: null } } as WorkState });
  const me = { isRequester: true, canManage: false };

  it("is offered to the requester, and to the company's manager or administrator, while the request is open", () => {
    expect(outboundActions(row(), me).cancel).toBe(true);
    expect(outboundActions(row(), { isRequester: false, canManage: true }).cancel).toBe(true);
    expect(outboundActions(row(), { isRequester: false, canManage: false }).cancel).toBe(false);
  });

  it("is not offered once the request is closed", () => {
    for (const status of ["delivered", "declined", "cancelled"]) expect(outboundActions(row({ status }), me).cancel, status).toBe(false);
  });

  it("is offered for an engineering request only while its change request is new with no live price agreement", () => {
    expect(outboundActions(eng("new", { impact: "unassessed", agreement: null }), me).cancel).toBe(true);
    expect(outboundActions(eng("new", { impact: "none", agreement: null }), me).cancel).toBe(true);
    expect(outboundActions(eng("new", { impact: "changes_price", agreement: "closed" }), me).cancel).toBe(true);
    for (const agreement of ["preparing", "awaiting_signature", "signed"] as const) {
      expect(outboundActions(eng("new", { impact: "changes_price", agreement }), me).cancel, agreement).toBe(false);
    }
    expect(outboundActions(eng("in_progress", { impact: "none", agreement: null }), me).cancel).toBe(false);
  });
});

describe("the routes (§60.5)", () => {
  it("reads {enabled, routes}, drops a route that cannot be read alone, and refuses any other shape", () => {
    expect(normalizeRoutes({ enabled: true, routes: [
      { routeId: "r1", kind: "assets", company: { id: "c", name: "Gaia" }, unit: { name: "Creatives" } },
      { routeId: "r2", kind: "mystery", company: { id: "c", name: "Gaia" }, unit: { name: "X" } },
      { routeId: "r3", kind: "engineering", company: { id: "c", name: "Gaia" } },
    ] })).toEqual({ enabled: true, routes: [{ routeId: "r1", kind: "assets", company: { id: "c", name: "Gaia" }, unit: { name: "Creatives" } }] });
    expect(normalizeRoutes({ enabled: false, routes: [] })).toEqual({ enabled: false, routes: [] });
    expect(normalizeRoutes([])).toBeNull();
    expect(normalizeRoutes({ routes: [] })).toBeNull();
    expect(normalizeRoutes({ enabled: true })).toBeNull();
  });

  it("says each route in words and links it to the form", () => {
    const assets = route();
    const eng = route({ kind: "engineering", unit: { name: "Web Dev" }, routeId: "r-2" });
    expect(routeToText(assets)).toBe("To Creatives · Gaia Digital Agency");
    expect(routeAskLabel(assets)).toBe("Ask Creatives at Gaia Digital Agency for assets");
    expect(routeAskLabel(eng)).toBe("Ask Web Dev at Gaia Digital Agency");
    expect(routeHref("a b")).toBe("/requests/new?route=a%20b");
  });

  it("finds the route a ?route= names, and nothing for an absent or unknown one", () => {
    const routes = [route(), route({ routeId: "r-2" })];
    expect(findRoute(routes, "r-2")?.routeId).toBe("r-2");
    expect(findRoute(routes, ["r-2", "x"])?.routeId).toBe("r-2");
    expect(findRoute(routes, "nope")).toBeNull();
    expect(findRoute(routes, undefined)).toBeNull();
    expect(findRoute([], "r-2")).toBeNull();
  });

  it("turns the form's check into the outbound body: the route replaces the department, no campaign part", () => {
    expect(outboundBodyFrom("r-1", { kind: "assets", toUnitId: "r-1", title: "T", brief: "b", neededBy: "2026-11-01", campaignPartId: "p1", form: { x: 1 } }))
      .toEqual({ routeId: "r-1", kind: "assets", title: "T", brief: "b", neededBy: "2026-11-01", form: { x: 1 } });
    expect(outboundBodyFrom("r-1", { kind: "engineering", toUnitId: "r-1", title: "T", form: {} })).toEqual({ routeId: "r-1", kind: "engineering", title: "T", form: {} });
  });

  it("says a row to another company as 'To <unit> · <company>', and a same-company row as the department", () => {
    expect(toText(row())).toBe("To Creatives · Gaia Digital Agency");
    expect(toText({ toUnit: { id: "d", name: "Creatives", unitMissing: false }, receivingCompany: null })).toBe("Creatives");
  });

  it("says the receiver without a leading 'To' for a row whose label already says where it went (DW-10e-5)", () => {
    expect(receiverText(row())).toBe("Creatives · Gaia Digital Agency");
    expect(receiverText({ toUnit: { id: "d", name: "Creatives", unitMissing: false }, receivingCompany: null })).toBe("Creatives");
  });
});

describe("the summary and the list scope (DW-D40)", () => {
  it("reads the scope and the count, and refuses an answer without a scope", () => {
    expect(normalizeOutboundSummary({ scope: "own", sent: { open: 2 } })).toEqual({ scope: "own", sent: { open: 2 } });
    expect(normalizeOutboundSummary({ scope: "company", sent: { open: 0 } })).toEqual({ scope: "company", sent: { open: 0 } });
    expect(normalizeOutboundSummary({ sent: { open: 2 } })).toBeNull();
    expect(normalizeOutboundSummary({ scope: "everyone", sent: { open: 2 } })).toBeNull();
    expect(normalizeOutboundSummary({ scope: "own", sent: { open: "2" } })).toBeNull();
    expect(normalizeOutboundSummary({ scope: "own", sent: { open: -1 } })).toBeNull();
  });

  it("words the list by scope: 'Requests you sent' for own, 'Requests <company> sent' for company", () => {
    expect(sentScopeCopy("company", "Viceroy").title).toBe("Requests Viceroy sent");
    expect(sentScopeCopy("company", null).title).toBe("Requests your company sent");
    expect(sentScopeCopy("company", "Viceroy").note).toBeNull();
    expect(sentScopeCopy("own", "Viceroy").title).toBe("Requests you sent");
    expect(sentScopeCopy("own", "Viceroy").note).toBe("Only the requests you sent to other companies are shown. Managers and administrators of Viceroy see all of them.");
    // Without an answer from the sender read, the page claims no scope.
    expect(sentScopeCopy(null, "Viceroy")).toMatchObject({ title: "Requests you sent", note: null });
  });
});

describe("one list from the two reads (§60.9)", () => {
  const own = [row({ id: "same-1", createdAt: "2026-10-10T00:00:00Z", receivingCompany: null })];
  const across = [row({ id: "x-1", createdAt: "2026-10-12T00:00:00Z" }), row({ id: "x-2", createdAt: "2026-10-08T00:00:00Z" })];
  const ok = <T,>(data: T) => ({ kind: "ok" as const, data });

  it("merges newest first and carries the scope", () => {
    const m = mergeSentReads(ok(own), ok({ scope: "own" as const, rows: across }));
    expect(m.rows.map((r) => r.id)).toEqual(["x-1", "same-1", "x-2"]);
    expect(m).toMatchObject({ scope: "own", acrossCount: 2, failed: [] });
  });

  it("when the sender read fails, shows the department part and names the part that is missing", () => {
    const m = mergeSentReads(ok(own), { kind: "unavailable", reason: "boom" });
    expect(m.rows.map((r) => r.id)).toEqual(["same-1"]);
    expect(m.scope).toBeNull();
    expect(m.failed).toEqual([{ part: "companies", kind: "unavailable", reason: "boom" }]);
  });

  it("when the department read fails, shows the other companies' part and names the missing one", () => {
    const m = mergeSentReads({ kind: "forbidden" }, ok({ scope: "company" as const, rows: across }));
    expect(m.rows.map((r) => r.id)).toEqual(["x-1", "x-2"]);
    expect(m.failed).toEqual([{ part: "departments", kind: "forbidden" }]);
  });

  it("sorts rows with no date last", () => {
    expect(mergeNewestFirst([row({ id: "n", createdAt: null })], [row({ id: "d", createdAt: "2026-10-01T00:00:00Z" })]).map((r) => r.id)).toEqual(["d", "n"]);
  });
});

describe("every refusal of §60.5 in words", () => {
  const say = (reason: string, extra: { status?: number; detail?: Record<string, unknown>; company?: string } = {}) =>
    requestErrorText({ status: extra.status ?? 409, reason, message: "raw", detail: extra.detail }, { company: extra.company });

  it("says route_invalid, route_not_found and request_routes_disabled", () => {
    expect(say("route_invalid", { status: 400 })).toBe("Choose one of your company's routes to send this request.");
    expect(say("route_not_found", { status: 404 })).toBe("Your company can no longer send requests there.");
    expect(say("request_routes_disabled")).toBe("Requests between group companies are switched off.");
  });

  it("says route_inactive by the route's status, naming the company when it is known", () => {
    expect(say("route_inactive", { detail: { status: "proposed" }, company: "Gaia" })).toMatch(/Gaia has not accepted the route yet\./);
    expect(say("route_inactive", { detail: { status: "suspended" }, company: "Gaia" })).toMatch(/Gaia has paused the route\./);
    expect(say("route_inactive", { detail: { status: "revoked" }, company: "Gaia" })).toMatch(/route to Gaia has been withdrawn\./);
    expect(say("route_inactive", { detail: { status: "orphaned" } })).toMatch(/department there has been removed/);
    expect(say("route_inactive", { detail: { status: "changed" } })).toMatch(/changed while you were sending/);
    expect(say("route_inactive", { detail: { status: "proposed" } })).toMatch(/That company has not accepted/);
    expect(say("route_inactive")).toBe("Your company cannot send requests there right now. The route is not active.");
  });

  it("says group_client_missing as the contract words it", () => {
    expect(say("group_client_missing", { company: "Gaia Digital Agency" })).toBe("Gaia Digital Agency has not set your company up as a client yet. Ask an administrator.");
    expect(say("group_client_missing")).toBe("That company has not set your company up as a client yet. Ask an administrator.");
  });

  it("says group_client_ambiguous and route_unit_unavailable", () => {
    expect(say("group_client_ambiguous", { company: "Gaia" })).toMatch(/Gaia has your company down as a client more than once/);
    expect(say("route_unit_unavailable", { company: "Gaia" })).toMatch(/Gaia's department is no longer in its org chart/);
  });

  it("says requester_side_only, price_agreement_open and the not-found answers", () => {
    expect(say("requester_side_only")).toMatch(/Only the company that sent this request can cancel it\. Decline it instead/);
    expect(say("price_agreement_open", { detail: { agreement: "signed" } })).toMatch(/price agreement is already open/);
    expect(say("asset_not_found", { status: 404 })).toBe("That asset is no longer part of this request.");
    expect(say("file_not_found", { status: 404 })).toBe("That file is no longer available.");
  });

  it("keeps the 400 field sentences, and the 403 sentence", () => {
    expect(requestErrorText({ status: 400, reason: "form_invalid", message: "x", field: "form.deliverables[0].quantity" })).toBe("Deliverable 1: a quantity is a whole number from 1 to 50.");
    expect(requestErrorText({ status: 403, message: "forbidden" })).toBe("You do not have permission to do that.");
  });
});
