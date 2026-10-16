// DW-10e-2 (BFF §60.4, §60.5 and §60.11 "Tenancy") — the PURE rules of the sender's side and the STATIC pins of its tenancy.
// No database, no Cerbos: runs everywhere. The HTTP proof is work-requests-outbound.test.ts, on the Linux gate.
//
//   * parsing: the send body (the order of refusals, `toUnitId` and `campaignPartId` refused, the form by the named kind) and
//     the list query;
//   * the price state (a STATE, never an amount) and the live-agreement rule of the cancel;
//   * the sender's row: its exact key set, and none of the receiver's ids, amounts or contract ids in it;
//   * tenancy, statically: every statement on `work_requests` in the sender files carries `SENDER_SCOPE` (`tenant_id = P` AND
//     `requester_tenant_id = H`); every `withTenants` call names exactly ONE company; nothing uses `crossRoot`; and every sender
//     read goes through `outboundReadScope`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SENDER_SCOPE, agreementState, liveAgreement, outboundAssetHref, outboundFilter, parseFormForKind, parseOutboundCreate,
  parseOutboundListQuery, priceState, shapeOutbound,
} from "./work-requests-outbound.service";
import { WorkRequestRuleError, indexOrgTree, type RequestRow } from "./work-requests.service";

function refusal(fn: () => unknown): WorkRequestRuleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkRequestRuleError);
    return e as WorkRequestRuleError;
  }
  throw new Error("expected a WorkRequestRuleError, but nothing was thrown");
}
const reason = (fn: () => unknown) => {
  const e = refusal(fn);
  return `${e.httpStatus} ${e.reason}`;
};

const ROUTE = "0190a000-0000-7000-8000-0000000000a1";
const assetsForm = { deliverables: [{ format: "image", size: "1080x1350", quantity: 2 }] };
const body = (over: Record<string, unknown> = {}) => ({ routeId: ROUTE, title: "Launch banners", form: assetsForm, ...over });

describe("DW-10e §60.5 POST requests/outbound: the body", () => {
  it("parses the documented fields, lower-cases the route id, and leaves the form for the route's kind when no kind is named", () => {
    const p = parseOutboundCreate(body({ routeId: ROUTE.toUpperCase(), brief: "For the launch", neededBy: "2026-11-20" }));
    expect(p).toMatchObject({ routeId: ROUTE, title: "Launch banners", brief: "For the launch", neededBy: "2026-11-20", kind: null, form: null });
    expect(p.rawForm).toEqual(assetsForm);
    expect(parseFormForKind("assets", p.rawForm)).toEqual(assetsForm);
  });

  it("parses the form at once when the body names the kind", () => {
    expect(parseOutboundCreate(body({ kind: "assets" })).form).toEqual(assetsForm);
    expect(parseOutboundCreate(body({ kind: "engineering", form: { kind: "bug" } })).form).toEqual({ kind: "bug" });
    expect(reason(() => parseOutboundCreate(body({ kind: "engineering" })))).toBe("400 form_invalid");
  });

  it("refuses in the contract's order: body, title, brief, date, route, kind, toUnitId, campaignPartId", () => {
    expect(reason(() => parseOutboundCreate(null))).toBe("400 body_invalid");
    expect(reason(() => parseOutboundCreate([]))).toBe("400 body_invalid");
    expect(reason(() => parseOutboundCreate(body({ title: "", routeId: "nope" })))).toBe("400 title_invalid");
    expect(reason(() => parseOutboundCreate(body({ title: "x".repeat(201) })))).toBe("400 title_invalid");
    expect(reason(() => parseOutboundCreate(body({ brief: 7, routeId: "nope" })))).toBe("400 brief_invalid");
    expect(reason(() => parseOutboundCreate(body({ brief: "x".repeat(10_001) })))).toBe("400 brief_too_long");
    expect(reason(() => parseOutboundCreate(body({ neededBy: "2026-02-30", routeId: "nope" })))).toBe("400 date_invalid");
    expect(reason(() => parseOutboundCreate(body({ routeId: undefined })))).toBe("400 route_invalid");
    expect(reason(() => parseOutboundCreate(body({ routeId: "d-creative" })))).toBe("400 route_invalid");
    expect(reason(() => parseOutboundCreate(body({ kind: "design", toUnitId: "d-x" })))).toBe("400 kind_invalid");
    expect(reason(() => parseOutboundCreate(body({ toUnitId: "d-creative", campaignPartId: ROUTE })))).toBe("400 to_unit_invalid");
    expect(reason(() => parseOutboundCreate(body({ campaignPartId: ROUTE })))).toBe("400 campaign_part_invalid");
  });

  it("a null toUnitId or campaignPartId means none and passes; the server never reads requested_by, a client or a company from the body", () => {
    const p = parseOutboundCreate(body({ toUnitId: null, campaignPartId: null, requestedBy: "x", clientId: "y", tenantId: "z" }));
    expect(Object.keys(p).sort()).toEqual(["brief", "form", "kind", "neededBy", "rawForm", "routeId", "title"]);
  });
});

describe("DW-10e §60.5 GET requests/outbound: the query", () => {
  it("box is mine|sent|all; status defaults to open; unitId is required for sent and ignored otherwise", () => {
    expect(parseOutboundListQuery({ box: "mine" })).toEqual({ box: "mine", unitId: null, status: "open", kind: null });
    expect(parseOutboundListQuery({ box: "all", status: "closed", kind: "engineering", unitId: "d-hr" }))
      .toEqual({ box: "all", unitId: null, status: "closed", kind: "engineering" });
    expect(parseOutboundListQuery({ box: "sent", unitId: " d-hr " })).toMatchObject({ box: "sent", unitId: "d-hr" });
    expect(reason(() => parseOutboundListQuery({ box: "incoming" }))).toBe("400 box_invalid");
    expect(reason(() => parseOutboundListQuery({}))).toBe("400 box_invalid");
    expect(reason(() => parseOutboundListQuery({ box: "sent" }))).toBe("400 unit_invalid");
    expect(reason(() => parseOutboundListQuery({ box: "mine", status: "done" }))).toBe("400 status_invalid");
    expect(reason(() => parseOutboundListQuery({ box: "mine", kind: "design" }))).toBe("400 kind_invalid");
  });

  it("the narrowing: scope own ALWAYS binds requested_by; scope company binds it only for box=mine; parameters start at $3", () => {
    const me = "0190a000-0000-7000-8000-0000000000e1";
    const own = outboundFilter({ box: "all", unitId: null, status: "all", kind: null }, "own", me);
    expect(own).toEqual({ sql: " AND r.requested_by = $3::uuid", args: [me] });
    const company = outboundFilter({ box: "all", unitId: null, status: "all", kind: null }, "company", me);
    expect(company).toEqual({ sql: "", args: [] });
    const mine = outboundFilter({ box: "mine", unitId: null, status: "open", kind: "assets" }, "company", me);
    expect(mine).toEqual({ sql: " AND r.requested_by = $3::uuid AND r.status = 'open' AND r.kind = $4", args: [me, "assets"] });
    const sentOwn = outboundFilter({ box: "sent", unitId: "d-hr", status: "closed", kind: null }, "own", me);
    expect(sentOwn).toEqual({ sql: " AND r.requested_by = $3::uuid AND r.requester_unit_id = $4 AND r.status <> 'open'", args: [me, "d-hr"] });
  });
});

describe("DW-10e §60.5 the price state, never an amount", () => {
  it("maps the contract's status to a state", () => {
    expect(agreementState("draft")).toBe("preparing");
    expect(agreementState("sent")).toBe("awaiting_signature");
    expect(agreementState("signed")).toBe("signed");
    for (const s of ["declined", "void", "expired", null, "weird"]) expect(agreementState(s), String(s)).toBe("closed");
  });

  it("is engineering only, sets the agreement only on changes_price, and reads an unknown impact as unassessed", () => {
    expect(priceState("assets", true, "changes_price", "draft")).toBeNull();
    expect(priceState("engineering", false, "none", null)).toBeNull();
    expect(priceState("engineering", true, "unassessed", null)).toEqual({ impact: "unassessed", agreement: null });
    expect(priceState("engineering", true, null, null)).toEqual({ impact: "unassessed", agreement: null });
    expect(priceState("engineering", true, "none", "signed")).toEqual({ impact: "none", agreement: null });
    expect(priceState("engineering", true, "changes_price", "sent")).toEqual({ impact: "changes_price", agreement: "awaiting_signature" });
    expect(priceState("engineering", true, "changes_price", null)).toEqual({ impact: "changes_price", agreement: "closed" });
  });

  it("a draft, sent or signed amendment holds the cancel; a dead one or none does not", () => {
    expect(liveAgreement("c1", "draft")).toBe("preparing");
    expect(liveAgreement("c1", "sent")).toBe("awaiting_signature");
    expect(liveAgreement("c1", "signed")).toBe("signed");
    for (const s of ["declined", "void", "expired", null]) expect(liveAgreement("c1", s), String(s)).toBeNull();
    expect(liveAgreement(null, "draft")).toBeNull();
  });
});

describe("DW-10e §60.5 the sender's row", () => {
  const P = "0190a000-0000-7000-8000-0000000000b0";
  const H = "0190a000-0000-7000-8000-0000000000c0";
  const RECEIVER_IDS = {
    task: "0190a000-0000-7000-8000-0000000000d1", project: "0190a000-0000-7000-8000-0000000000d2",
    cr: "0190a000-0000-7000-8000-0000000000d3", contract: "0190a000-0000-7000-8000-0000000000d4",
    client: "0190a000-0000-7000-8000-0000000000d5", part: "0190a000-0000-7000-8000-0000000000d6",
  };
  const indexP = indexOrgTree({ id: "root", name: "Agency", kind: "company", children: [{ id: "d-creative", name: "Creatives", kind: "department", children: [] }] } as never);
  const indexH = indexOrgTree({ id: "root", name: "Holding", kind: "company", children: [{ id: "d-creative", name: "Holding Creative Desk", kind: "department", children: [] }] } as never);
  const row = (over: Partial<RequestRow> = {}): RequestRow => ({
    id: "0190a000-0000-7000-8000-0000000000f1", kind: "engineering", title: "Fix", status: "open", needed_by: null,
    created_at: "2026-10-16T01:00:00.000Z", closed_at: null, to_unit_id: "d-creative", from_unit_id: null,
    requested_by: "0190a000-0000-7000-8000-0000000000e1", requested_by_name: "A Sender", brief: "b", form: {}, decline_reason: null,
    campaign_part_id: RECEIVER_IDS.part, campaign_id: RECEIVER_IDS.part, campaign_name: "x",
    pm_task_id: RECEIVER_IDS.task, t_id: RECEIVER_IDS.task, t_project_id: RECEIVER_IDS.project, t_status: "doing", t_is_done: false,
    t_responsible_name: "R", change_request_id: RECEIVER_IDS.cr, cr_id: RECEIVER_IDS.cr, cr_status: "new", cr_route: "pm_task",
    asset_count: 0, tenant_id: P, requester_tenant_id: H, requester_unit_id: "d-creative", requester_unit_name: "Holding Creative Desk",
    service_assignment_id: "0190a000-0000-7000-8000-0000000000a1", client_id: RECEIVER_IDS.client, requesting_company_name: "Holding",
    client_name: "Holding at Agency", cr_price_impact: "changes_price", cr_amendment_contract_id: RECEIVER_IDS.contract, amendment_status: "sent",
    ...over,
  });

  it("has exactly the contract's keys", () => {
    const s = shapeOutbound(row(), { id: P, name: "Agency" }, indexP, indexH);
    expect(Object.keys(s).sort()).toEqual([
      "assetCount", "campaign", "closedAt", "createdAt", "fromUnit", "id", "kind", "neededBy", "price", "receivingCompany",
      "requestedBy", "routeId", "status", "title", "toUnit", "work",
    ]);
    expect(Object.keys(s.work as object).sort()).toEqual(["status", "type"]);
    expect(Object.keys(s.price as object).sort()).toEqual(["agreement", "impact"]);
    const a = shapeOutbound(row({ kind: "assets" }), { id: P, name: "Agency" }, indexP, indexH);
    expect(Object.keys(a.work as object).sort()).toEqual(["isDone", "responsibleName", "status", "type"]);
    expect(a.price).toBeNull();
  });

  it("carries none of the receiver's ids (task, project, change request, contract, client, campaign part) and no amount", () => {
    for (const kind of ["assets", "engineering"] as const) {
      const text = JSON.stringify(shapeOutbound(row({ kind }), { id: P, name: "Agency" }, indexP, indexH));
      for (const [what, id] of Object.entries(RECEIVER_IDS)) expect(text, `${kind}: ${what}`).not.toContain(id);
      for (const word of ["amount", "value", "currency", "rate", "hours", "minutes", "invoice", "contractId", "projectId", "route\""]) {
        expect(text.toLowerCase(), `${kind}: ${word}`).not.toContain(word.toLowerCase());
      }
      expect(JSON.parse(text).campaign).toBeNull();
    }
  });

  it("names toUnit from P's tree and fromUnit from H's tree, never across (the node id collides)", () => {
    const s = shapeOutbound(row(), { id: P, name: "Agency" }, indexP, indexH);
    expect(s.toUnit).toEqual({ id: "d-creative", name: "Creatives", unitMissing: false });
    expect(s.fromUnit).toEqual({ id: "d-creative", name: "Holding Creative Desk", unitMissing: false });
    expect(s.receivingCompany).toEqual({ id: P, name: "Agency" });
    expect(shapeOutbound(row({ requester_unit_id: null }), { id: P, name: "Agency" }, indexP, indexH).fromUnit).toBeNull();
  });

  it("links an asset through the SENDER's route under the requesting company", () => {
    expect(outboundAssetHref(H, "r1", "a1")).toBe(`/api/${H}/requests/outbound/r1/assets/a1/content`);
  });
});

describe("DW-10e §60.11 Tenancy: static pins of the sender files", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
  const files = { controller: read("work-requests-outbound.controller.ts"), service: read("work-requests-outbound.service.ts") };
  const code = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const templates = (text: string) => [...code(text).matchAll(/`([^`]*)`/g)].map((m) => m[1]);

  it("SENDER_SCOPE binds both companies: the receiving company as $1 and the requesting company as $2", () => {
    expect(SENDER_SCOPE).toContain("r.tenant_id = $1");
    expect(SENDER_SCOPE).toContain("r.requester_tenant_id = $2");
    expect(SENDER_SCOPE).toContain("r.deleted_at IS NULL");
  });

  it("every SQL statement on work_requests (and every REQUEST_SELECT read) in the sender files carries SENDER_SCOPE", () => {
    let seen = 0;
    for (const [name, text] of Object.entries(files)) {
      for (const t of templates(text)) {
        if (!/\bwork_requests\b/.test(t) && !t.includes("REQUEST_SELECT")) continue;
        seen++;
        if (/^\s*INSERT INTO work_requests/.test(t)) {
          // the one write: the row is P's, and it names H as its requester (the route guard then checks the route and client)
          expect(t, name).toMatch(/\btenant_id\b[\s\S]*\brequester_tenant_id\b/);
          continue;
        }
        expect(t,`${name}: ${t.slice(0, 120)}`).toMatch(/\$\{(out\.)?SENDER_SCOPE\}/);
      }
    }
    // readOutboundRows, readOutboundRow, countOpenFromUnit, the cancel's lock and its UPDATE: a scan that matched nothing proves nothing
    expect(seen).toBeGreaterThanOrEqual(5);
  });

  it("every withTenants call in the sender files names exactly ONE company; nothing uses crossRoot or withGlobal", () => {
    for (const [name, text] of Object.entries(files)) {
      const calls = [...code(text).matchAll(/withTenants\(\s*([^,]*),/g)].map((m) => m[1].trim());
      expect(calls.length, name).toBeGreaterThan(0);
      for (const arg of calls) expect(arg, `${name}: withTenants(${arg}, ...)`).toMatch(/^\[[A-Za-z_.]+\]$/);
      expect(code(text), name).not.toMatch(/crossRoot/);
      expect(code(text), name).not.toMatch(/withGlobal/);
    }
  });

  it("every sender READ goes through outboundReadScope: the list and summary directly, every id route through visible() -> findVisibleOutbound", () => {
    const c = code(files.controller);
    const handler = (name: string) => {
      const start = c.indexOf(`async ${name}(`);
      expect(start, name).toBeGreaterThan(0);
      const next = c.indexOf("\n  @", start);
      return c.slice(start, next < 0 ? undefined : next);
    };
    for (const h of ["list", "summary"]) expect(handler(h), h).toContain("out.outboundReadScope(");
    for (const h of ["detail", "assetContent", "files", "fileContent", "cancel"]) expect(handler(h), h).toContain("this.visible(");
    const visible = c.slice(c.indexOf("private async visible("));
    expect(visible).toMatch(/authorize\([^;]*"read"\);\s*const v = await out\.findVisibleOutbound\(/);
    const svcCode = code(files.service);
    const find = svcCode.slice(svcCode.indexOf("export async function findVisibleOutbound("));
    expect(find).toContain("outboundReadScope(principal, requesterTenantId, id)");
  });

  it("every handler authorizes FIRST, on the requesting company (validation never pre-empts a 403)", () => {
    const c = code(files.controller);
    for (const [h, action] of [["routes", "read"], ["send", "send_across"], ["list", "read"], ["summary", "read"]] as const) {
      const start = c.indexOf(`async ${h}(`);
      const body = c.slice(c.indexOf("{", c.indexOf(")", start)) + 1);
      expect(body.trimStart().startsWith(`await authorize(req.principal, resource(tenantId), "${action}");`), h).toBe(true);
    }
    for (const h of ["detail", "assetContent", "files", "fileContent", "cancel"]) {
      const start = c.indexOf(`async ${h}(`);
      const body = c.slice(c.indexOf("{\n", start) + 2);
      expect(body.trimStart().startsWith("const v = await this.visible(req, tenantId, id);"), h).toBe(true);
    }
  });

  it("the routes and providers reads look for ROUTES only (module_key = ANY(REQUEST_ROUTE_KEYS)), on the TARGET side", () => {
    for (const [name, text] of Object.entries(files)) {
      for (const t of templates(text).filter((x) => /service_assignments/.test(x))) {
        expect(t, name).toMatch(/sa\.module_key = ANY\(\$\d::text\[\]\)/);
        expect(t, name).toMatch(/sa\.target_tenant_id = \$\d/);
      }
    }
  });
});
