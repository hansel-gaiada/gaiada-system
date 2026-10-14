// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.7) — Figma links on PM tasks, work requests and campaign parts, driven over HTTP
// against real Postgres (RLS on) and real Cerbos, with the Figma REST API STUBBED at the `fetch` layer.
//
// THE STUB. Nobody on the team has Figma API access yet (DW-11), so `setFigmaClientForTests` hands the services the REAL client
// (client.ts) wired to a fake `fetch`. The fake answers with JSON trimmed from the shapes Figma documents (openapi.yaml of
// github.com/figma/rest-api-spec: GetFileResponse, GetFileNodesResponse, GetImagesResponse, GetCommentsResponse, Comment), so
// the client's own parsing, headers and error mapping are exercised too. It records every request, which is how the cache and
// the "never retried" claims are asserted: by counting calls to Figma. Live proof (one real file) waits for DW-11.
//
//   * The connection: sealed in the vault, never returned; `company.manage` only; the token kind reaches the right header.
//   * Create, list and delete per target kind; the duplicate and the freed slot.
//   * The write check per kind: a work request's asker (cancel), receiver (deliver) and lead; a stranger refused. A campaign
//     part's owner and lead. Reads need only `read`. Authorise first, then validate.
//   * Another tenant's target answers 404 target_not_found, and another tenant's link 404 link_not_found.
//   * The ten-minute refresh; `stale` on a failed refresh, on a refused token and on a 429 (one call, never a loop), with the
//     old numbers kept and never turned into "no comments".
//   * An export creates version 1 and then version 2 in the link's group, through the shared save path; the request it is on
//     is not delivered.
//   * `figma_not_connected` on thumbnail and export.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so
// what is asserted is what committed), and every refusal also asserts that nothing was written.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files). It SKIPS without a database; a
// skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { resetModules, registerModule } from "../../modules/registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { buildApp } from "../../main";
import { agencyModule } from "../../modules/agency";
import { applyOrgStructure, sanitizeStructure } from "../../admin/org-structure.service";
import { setStorageForTest } from "../storage";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";
import { createFigmaClient, setFigmaClientForTests } from "./client";

const mem = new Map<string, Buffer>();
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ───────────────────────────────────────────── the Figma stub ─────────────────────────────────────────────

const PAT = "figd_PAT_secret_value_0001";
const OAUTH = "figu_OAUTH_secret_value_0002";
const FILE_A = "AbC123xyz9QwErTy4567Zz";
const FILE_B = "Zz7654yTrEwQ9zyx321CbA";
const RENDER_HOST = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images";

type Mode = "ok" | "refused" | "rate_limited" | "down";
const fx = {
  mode: "ok" as Mode,
  /** "ok", or "null": the images map answers null for the node (Figma could not render it). */
  render: "ok" as "ok" | "null",
  nodes: { "1:2": "Hero banner", "1:3": "Footer" } as Record<string, string>,
  comments: [] as unknown[],
  seen: [] as Array<{ url: string; headers: Record<string, string> }>,
  renderSeq: 0,
  downloaded: [] as Buffer[],
};

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// A documented `Comment`, trimmed: id, file_key, parent_id (replies only), user, created_at, resolved_at, message, order_id,
// client_meta (a Vector, or a FrameOffset naming the frame), reactions.
const comment = (id: string, over: Record<string, unknown> = {}) => ({
  id, file_key: FILE_A, user: { id: "u1", handle: "Dana", img_url: "https://example.com/u1.png" },
  created_at: "2026-10-01T09:00:00Z", resolved_at: null, message: `comment ${id}`, order_id: id, reactions: [],
  client_meta: { x: 10, y: 20 }, ...over,
});
const onFrame = (id: string, nodeId: string, over: Record<string, unknown> = {}) =>
  comment(id, { client_meta: { node_id: nodeId, node_offset: { x: 1, y: 2 } }, ...over });
/** Frame 1:2 has ONE open thread (c1); the file has THREE (c1 on 1:2, c3 on 1:3, c4 on bare canvas). */
const baseComments = () => [
  onFrame("c1", "1:2"),
  onFrame("c2", "1:2", { resolved_at: "2026-10-02T10:00:00Z" }),
  onFrame("c3", "1:3"),
  comment("c4"),
  onFrame("c5", "1:2", { parent_id: "c1" }),
];

function stubFetch(input: string, init?: RequestInit): Response {
  fx.seen.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> });
  const u = new URL(input);
  if (u.hostname !== "api.figma.com") {
    // A render download: the bytes are unique per request, so two exports never share bytes.
    const bytes = Buffer.from(`RENDER-BYTES-${u.pathname}-${fx.renderSeq}`);
    fx.downloaded.push(bytes);
    const ext = u.pathname.split(".").pop();
    const type = ext === "svg" ? "image/svg+xml" : ext === "pdf" ? "application/pdf" : "image/png";
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });
  }
  if (fx.mode === "refused") return jsonRes({ status: 403, err: "Invalid token" }, 403);
  if (fx.mode === "rate_limited") return jsonRes({ status: 429, err: "Rate limit exceeded" }, 429, { "retry-after": "60" });
  if (fx.mode === "down") return jsonRes({ status: 500, err: "boom" }, 500);
  const p = u.pathname;
  if (/^\/v1\/files\/[^/]+$/.test(p)) {
    // GetFileResponse, trimmed (shallow: depth=1, so the document's children are the pages).
    return jsonRes({
      name: "Brand Kit", role: "owner", lastModified: "2026-10-10T08:30:00Z", editorType: "figma", version: "4242",
      thumbnailUrl: "https://example.com/t.png",
      document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [] }] },
    });
  }
  if (/\/nodes$/.test(p)) {
    const ids = (u.searchParams.get("ids") ?? "").split(",");
    const nodes: Record<string, unknown> = {};
    for (const id of ids) nodes[id] = fx.nodes[id] ? { document: { id, name: fx.nodes[id], type: "FRAME" }, components: {}, componentSets: {}, schemaVersion: 0, styles: {} } : null;
    return jsonRes({ name: "Brand Kit", lastModified: "2026-10-10T08:30:00Z", nodes });
  }
  if (/\/comments$/.test(p)) return jsonRes({ comments: fx.comments });
  if (/^\/v1\/images\//.test(p)) {
    const id = u.searchParams.get("ids") ?? "";
    const format = u.searchParams.get("format") ?? "png";
    fx.renderSeq++;
    return jsonRes({ err: null, images: { [id]: fx.render === "null" ? null : `${RENDER_HOST}/r${fx.renderSeq}.${format}` } });
  }
  return jsonRes({ status: 404, err: "Not found" }, 404);
}

const figma = {
  file: () => fx.seen.filter((s) => /\/v1\/files\/[^/?]+\?depth=1$/.test(s.url)),
  nodes: () => fx.seen.filter((s) => /\/nodes\?/.test(s.url)),
  comments: () => fx.seen.filter((s) => /\/comments$/.test(s.url)),
  images: () => fx.seen.filter((s) => /\/v1\/images\//.test(s.url)),
  downloads: () => fx.seen.filter((s) => !s.url.startsWith("https://api.figma.com")),
  api: () => fx.seen.filter((s) => s.url.startsWith("https://api.figma.com")),
};

type Node = { id: string; name: string; kind: string; children: Node[] };
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });

describe.skipIf(!TEST_URL)("DW-6k Figma links (HTTP, real Postgres + Cerbos, Figma stubbed at fetch)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency tenant (agency + pm on)
  let B: string; // another tenant
  let admin: string; // company_admin
  let manager: string;
  let member: string; // an ordinary member: raises tasks
  let requester: string; // member who asked for assets (the request's asker: `cancel`)
  let assignee: string; // member made the responsible person of the request's task (`deliver`)
  let stranger: string; // member with no relation to the request or the part
  let viewer: string;
  let leadCreative: string; // member + org_unit_lead of d-creative (the receiving department)
  let leadSeo: string; // member + org_unit_lead of d-seo
  let partOwner: string; // member who owns the campaign part
  let outsider: string; // a user with NO membership in A
  let adminB: string;
  let projectA: string;
  let taskA: string;
  let taskB: string;
  let requestA: string;
  let requestB: string;
  let campaignA: string;
  let partA: string;
  let partB: string;
  let seq = 0;

  const q = adminPool;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const links = (t = A) => `/api/${t}/figma-links`;
  const reasonOf = (r: { json: () => any }) => r.json().reason as string;
  const errOf = (r: { json: () => any }) => r.json().error as string;

  /** A distinct Figma file key per call, so two links never collide on the unique index by accident. */
  const nextKey = () => `Key${String(++seq).padStart(6, "0")}Abcdefghijklm`;
  const urlOf = (key: string, node?: string) => `https://www.figma.com/design/${key}/Brand-Kit${node ? `?node-id=${node}` : ""}`;

  const create = (as: string, targetKind: string, targetId: string, url: unknown, tenant = A) =>
    call("POST", links(tenant), as, { targetKind, targetId, url });
  async function createOk(as: string, targetKind: string, targetId: string, url: string) {
    const r = await create(as, targetKind, targetId, url);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as any;
  }
  const list = (as: string, targetKind: string, targetId: string, tenant = A) =>
    call("GET", `${links(tenant)}?targetKind=${targetKind}&targetId=${targetId}`, as);
  const listOk = async (as: string, targetKind: string, targetId: string) => {
    const r = await list(as, targetKind, targetId);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { figmaConnected: boolean; items: any[] };
  };
  /** One link of the task's list, by id (so a leftover link from another test can never be mistaken for it). */
  const itemOf = async (id: string) => {
    const found = (await listOk(member, "pm_task", taskA)).items.find((i) => i.id === id);
    expect(found, `link ${id} is listed`).toBeTruthy();
    return found;
  };
  const del = (as: string, id: string, tenant = A) => call("DELETE", `${links(tenant)}/${id}`, as);
  const exportLink = (as: string, id: string, body: unknown, tenant = A) => call("POST", `${links(tenant)}/${id}/export`, as, body);
  const thumb = (as: string, id: string, tenant = A) => call("GET", `${links(tenant)}/${id}/thumbnail`, as);
  const row = async (id: string) => (await q().query(`SELECT * FROM figma_links WHERE id = $1`, [id])).rows[0];
  const liveLinks = async (targetId: string) =>
    Number((await q().query(`SELECT count(*)::int AS n FROM figma_links WHERE target_id = $1 AND deleted_at IS NULL`, [targetId])).rows[0].n);
  const assetCount = async (tenant = A) => Number((await q().query(`SELECT count(*)::int AS n FROM creative_assets WHERE tenant_id = $1`, [tenant])).rows[0].n);
  const ageCache = (id: string) => q().query(`UPDATE figma_links SET cached_at = now() - interval '11 minutes' WHERE id = $1`, [id]);

  const connect = (as: string, token: string, tokenType?: string) =>
    call("PUT", `/api/${A}/integrations/figma`, as, { token, ...(tokenType ? { tokenType } : {}) });
  async function connectOk(token = PAT, tokenType: "pat" | "oauth" = "pat") {
    const r = await connect(admin, token, tokenType);
    expect(r.statusCode, r.body).toBe(200);
  }
  const disconnectOk = async () => {
    const r = await call("DELETE", `/api/${A}/integrations/figma`, admin);
    expect(r.statusCode, r.body).toBe(200);
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    setFigmaClientForTests(createFigmaClient(async (input, init) => stubFetch(input, init)));

    A = await createCompany("Gaia Creative House", ["agency", "pm"]);
    B = await createCompany("Rival Studio", ["agency", "pm"]);
    const users: Array<[string, string]> = [
      ["admin", "Admin"], ["manager", "Manager"], ["member", "Task Member"], ["requester", "Requester"], ["assignee", "Assignee"],
      ["stranger", "Stranger Member"], ["viewer", "Viewer"], ["leadcreative", "Creative Head"], ["leadseo", "SEO Head"],
      ["partowner", "Part Owner"],
    ];
    const ids: Record<string, string> = {};
    for (const [k, name] of users) {
      ids[k] = await createUser(`${k}@dw6k.test`, name);
      await addMembership(A, ids[k]);
    }
    ({ admin, manager, member, requester, assignee, stranger, viewer, leadCreative, leadSeo, partOwner } = {
      admin: ids.admin, manager: ids.manager, member: ids.member, requester: ids.requester, assignee: ids.assignee,
      stranger: ids.stranger, viewer: ids.viewer, leadCreative: ids.leadcreative, leadSeo: ids.leadseo, partOwner: ids.partowner,
    });
    outsider = await createUser("outsider@rival-dw6k.test", "Outsider");
    adminB = await createUser("admin@rival-dw6k.test", "Rival Admin");
    await addMembership(B, outsider);
    await addMembership(B, adminB);

    const adminRole = await createRole("company_admin");
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    const leadRole = await createRole("org_unit_lead");
    await grantRole(admin, adminRole, "company", A);
    await grantRole(manager, managerRole, "company", A);
    for (const u of [member, requester, assignee, stranger, leadCreative, leadSeo, partOwner]) await grantRole(u, memberRole, "company", A);
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(leadCreative, leadRole, "org_unit", "d-creative");
    await grantRole(leadSeo, leadRole, "org_unit", "d-seo");
    await grantRole(adminB, adminRole, "company", B);
    await grantRole(outsider, memberRole, "company", B);

    // The org tree goes through the PRODUCTION writer, so the closure the lead rules read is the real one.
    await withTenants([A], (c) =>
      applyOrgStructure(c, A, sanitizeStructure({
        root: { id: "root", name: "Gaia", kind: "company", children: [dept("d-creative", "Creatives"), dept("d-seo", "SEO")] },
      })),
    );
    await withTenants([B], (c) =>
      applyOrgStructure(c, B, sanitizeStructure({ root: { id: "root", name: "Rival", kind: "company", children: [dept("d-b", "B Design")] } })),
    );

    // The app first: the rows below are made through its own routes.
    app = await buildApp();
    await app.init();

    // Tenant A: a PM task in a project owned by d-seo, an asset request to d-creative (its asker `requester`, its task's
    // responsible person `assignee`), and a campaign part of d-seo owned by `partOwner`.
    projectA = await createProject(A, "Rebrand");
    await q().query(`UPDATE projects SET department_id = 'd-seo' WHERE id = $1`, [projectA]);
    const t = await call("POST", `/api/${A}/pm/tasks`, manager, { projectId: projectA, title: "Design the banner" });
    expect(t.statusCode, t.body).toBe(201);
    taskA = t.json().id;

    const rq = await call("POST", `/api/${A}/requests`, requester, {
      kind: "assets", toUnitId: "d-creative", title: "Banners for the spring push",
      form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 1 }] },
    });
    expect(rq.statusCode, rq.body).toBe(201);
    requestA = rq.json().id;
    const reqTask = rq.json().work.id as string;
    const as = await call("PATCH", `/api/${A}/pm/tasks/${reqTask}`, manager, {
      assignee: { kind: "department", refId: "d-creative", refName: "Creatives", responsibleId: assignee, responsibleName: "Assignee" },
    });
    expect(as.statusCode, as.body).toBe(200);

    const camp = await call("POST", `/api/${A}/modules/agency/campaigns`, manager, { name: "Spring push", projectId: projectA });
    expect(camp.statusCode, camp.body).toBe(201);
    campaignA = camp.json().id;
    const part = await call("POST", `/api/${A}/modules/agency/campaigns/${campaignA}/parts`, manager, { unitId: "d-seo", ownerId: partOwner });
    expect(part.statusCode, part.body).toBe(201);
    partA = part.json().id;

    // Tenant B: a task, a request and a part that A's people must never reach.
    const projectB = await createProject(B, "Rival work");
    const tb = await call("POST", `/api/${B}/pm/tasks`, adminB, { projectId: projectB, title: "Rival task" });
    expect(tb.statusCode, tb.body).toBe(201);
    taskB = tb.json().id;
    const rb = await call("POST", `/api/${B}/requests`, adminB, {
      kind: "assets", toUnitId: "d-b", title: "Rival banners", form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 1 }] },
    });
    expect(rb.statusCode, rb.body).toBe(201);
    requestB = rb.json().id;
    const campB = newId();
    await q().query(`INSERT INTO agency_campaigns (id, tenant_id, project_id, name, origin_site) VALUES ($1, $2, $3, 'B campaign', 'central')`, [campB, B, projectB]);
    partB = newId();
    await q().query(`INSERT INTO agency_campaign_parts (id, tenant_id, campaign_id, unit_id, origin_site) VALUES ($1, $2, $3, 'd-b', 'central')`, [partB, B, campB]);
  });

  afterAll(async () => {
    setFigmaClientForTests(null);
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    fx.mode = "ok";
    fx.render = "ok";
    fx.nodes = { "1:2": "Hero banner", "1:3": "Footer" };
    fx.comments = baseComments();
    fx.seen = [];
  });

  // ═══════════════════════════════════════════ THE CONNECTION (§36.1) ═══════════════════════════════════════════
  describe("the company's connection", () => {
    it("nothing is connected at first, and everyone who reads PM tasks may ask", async () => {
      for (const u of [admin, member, viewer]) {
        const r = await call("GET", `/api/${A}/integrations/figma`, u);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toEqual({ connected: false, tokenType: null });
      }
      expect((await call("GET", `/api/${A}/integrations/figma`, outsider)).statusCode).toBe(403);
    });

    it("the generic connections API admits the provider 'figma' as a mapping row, with no token", async () => {
      const r = await call("POST", `/api/${A}/integrations/connections`, admin, { ownerKind: "company", provider: "figma" });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ provider: "figma", ownerKind: "company", ownerId: A, hasToken: false });
      const l = await call("GET", `/api/${A}/integrations/connections?owner=company&provider=figma`, admin);
      expect(l.statusCode, l.body).toBe(200);
      expect(l.json().map((c: any) => c.provider)).toEqual(["figma"]);
      expect((await call("GET", `/api/${A}/integrations/connections?owner=company&provider=figma`, member)).statusCode).toBe(403);
    });

    it("connecting is company.manage only: a member, a viewer and a stranger are refused and nothing is stored", async () => {
      for (const u of [member, viewer, stranger]) {
        const r = await connect(u, PAT);
        expect(r.statusCode, r.body).toBe(403);
      }
      expect((await connect(outsider, PAT)).statusCode).toBe(403);
      const row0 = (await q().query(`SELECT access_token_enc FROM integration_connections WHERE tenant_id = $1 AND provider = 'figma'`, [A])).rows[0];
      expect(row0?.access_token_enc ?? null).toBeNull();
    });

    it("authorise first, then validate: a manager sending a bad token gets 400, a member sending the same gets 403", async () => {
      expect((await connect(member, "has spaces")).statusCode).toBe(403);
      const blank = await connect(manager, "");
      expect(blank.statusCode).toBe(400);
      expect(reasonOf(blank)).toBe("bad_token");
      expect(errOf(blank).startsWith("bad_token")).toBe(true);
      const spaced = await connect(manager, "two words");
      expect(reasonOf(spaced)).toBe("bad_token");
      const kind = await connect(manager, PAT, "password");
      expect(kind.statusCode).toBe(400);
      expect(reasonOf(kind)).toBe("bad_token_type");
    });

    it("a company admin seals a personal access token: stored encrypted, never returned, never in an activity row", async () => {
      const r = await connect(admin, PAT, "pat");
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ connected: true, tokenType: "pat" });
      expect(r.body).not.toContain(PAT);

      const stored = (await q().query(
        `SELECT owner_kind, owner_id, status, access_token_enc, token_key_version, meta FROM integration_connections WHERE tenant_id = $1 AND provider = 'figma'`, [A],
      )).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ owner_kind: "company", owner_id: A, status: "linked", token_key_version: "v1", meta: { tokenType: "pat" } });
      expect(stored[0].access_token_enc.startsWith("enc:v1:")).toBe(true);
      expect(stored[0].access_token_enc).not.toContain(PAT);

      const act = (await q().query(`SELECT metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'integration_connection' AND verb = 'connected'`, [A])).rows;
      expect(act.length).toBeGreaterThan(0);
      expect(JSON.stringify(act)).not.toContain(PAT);

      // the generic list shows the same row masked, and the status route says connected
      const generic = await call("GET", `/api/${A}/integrations/connections?owner=company&provider=figma`, admin);
      expect(generic.body).not.toContain(PAT);
      expect(generic.json()[0]).toMatchObject({ provider: "figma", hasToken: true, status: "linked" });
      expect((await call("GET", `/api/${A}/integrations/figma`, viewer)).json()).toEqual({ connected: true, tokenType: "pat" });
    });

    it("a personal access token goes to Figma as X-Figma-Token, an OAuth token as a Bearer, and the vault round trip is exact", async () => {
      await connectOk(PAT, "pat");
      const l1 = await createOk(manager, "pm_task", taskA, urlOf(nextKey()));
      expect(l1.stale).toBe(false);
      expect(figma.api().length).toBeGreaterThan(0);
      for (const s of figma.api()) {
        expect(s.headers["X-Figma-Token"]).toBe(PAT);
        expect(s.headers.Authorization).toBeUndefined();
      }
      fx.seen = [];
      await connectOk(OAUTH, "oauth");
      expect((await call("GET", `/api/${A}/integrations/figma`, member)).json()).toEqual({ connected: true, tokenType: "oauth" });
      await createOk(manager, "pm_task", taskA, urlOf(nextKey()));
      for (const s of figma.api()) {
        expect(s.headers.Authorization).toBe(`Bearer ${OAUTH}`);
        expect(s.headers["X-Figma-Token"]).toBeUndefined();
      }
      // replacing the token kept ONE row
      expect(Number((await q().query(`SELECT count(*)::int AS n FROM integration_connections WHERE tenant_id = $1 AND provider = 'figma'`, [A])).rows[0].n)).toBe(1);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
      await connectOk(PAT, "pat");
    });

    it("disconnecting is company.manage only, nulls the token and keeps the row", async () => {
      await connectOk();
      expect((await call("DELETE", `/api/${A}/integrations/figma`, member)).statusCode).toBe(403);
      expect((await call("GET", `/api/${A}/integrations/figma`, member)).json().connected).toBe(true);
      const r = await call("DELETE", `/api/${A}/integrations/figma`, manager);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ disconnected: true });
      const stored = (await q().query(`SELECT status, access_token_enc FROM integration_connections WHERE tenant_id = $1 AND provider = 'figma'`, [A])).rows[0];
      expect(stored).toMatchObject({ status: "revoked", access_token_enc: null });
      expect((await call("GET", `/api/${A}/integrations/figma`, member)).json()).toEqual({ connected: false, tokenType: null });
      // a second disconnect has nothing to do
      expect((await call("DELETE", `/api/${A}/integrations/figma`, manager)).json()).toEqual({ disconnected: false });
      await connectOk();
    });
  });

  // ═══════════════════════════════════ CREATE, LIST, DELETE PER TARGET KIND (§36.7) ═══════════════════════════════════
  describe("create, list and delete per target kind", () => {
    beforeEach(async () => { await connectOk(); fx.seen = []; });

    const cases = [
      { kind: "pm_task", target: () => taskA, writer: () => manager },
      { kind: "work_request", target: () => requestA, writer: () => requester },
      { kind: "campaign_part", target: () => partA, writer: () => partOwner },
    ];
    it.each(cases)("$kind: create caches the title and the open-comment count, list reads it, delete frees the slot", async ({ kind, target, writer }) => {
      const key = nextKey();
      const t = target();
      const url = urlOf(key, "1-2");
      // what is stored: the link normalised (https, the pasted kind, the key, and node-id only; no slug, no tracking params)
      const stored0 = `https://www.figma.com/design/${key}?node-id=1-2`;
      const v = await createOk(writer(), kind, t, `${url}&t=junk123`);
      expect(v).toMatchObject({
        targetKind: kind, targetId: t, fileKey: key, nodeId: "1:2", url: stored0, title: "Brand Kit / Hero banner",
        lastModified: "2026-10-10T08:30:00.000Z", openComments: 1, assetGroupId: null, createdBy: writer(),
        stale: false, refreshError: null,
      });
      expect(v.cachedAt).toBeTruthy();
      expect(JSON.stringify(v)).not.toContain(PAT);

      const stored = await row(v.id);
      expect(stored).toMatchObject({
        tenant_id: A, target_kind: kind, target_id: t, file_key: key, node_id: "1:2", url: stored0, title: "Brand Kit / Hero banner",
        open_comments: 1, created_by: writer(), deleted_at: null,
      });
      expect(stored.cached_at).not.toBeNull();

      // a viewer reads it: `read` on the target is all a list needs
      const got = await listOk(viewer, kind, t);
      expect(got.figmaConnected).toBe(true);
      const mine = got.items.find((i) => i.id === v.id);
      expect(mine).toMatchObject({ fileKey: key, nodeId: "1:2", openComments: 1, stale: false, refreshError: null });

      // the same file and frame twice is refused, and nothing is added
      const dup = await create(writer(), kind, t, url);
      expect(dup.statusCode, dup.body).toBe(409);
      expect(reasonOf(dup)).toBe("link_exists");
      expect(Number((await q().query(`SELECT count(*)::int AS n FROM figma_links WHERE target_id = $1 AND file_key = $2`, [t, key])).rows[0].n)).toBe(1);
      // another frame of the same file is a different link; the whole file is one more
      const other = await createOk(writer(), kind, t, urlOf(key, "1-3"));
      expect(other).toMatchObject({ nodeId: "1:3", title: "Brand Kit / Footer", openComments: 1 });
      const whole = await createOk(writer(), kind, t, urlOf(key));
      expect(whole).toMatchObject({ nodeId: null, title: "Brand Kit", openComments: 3 });
      const wholeAgain = await create(writer(), kind, t, urlOf(key));
      expect(wholeAgain.statusCode).toBe(409); // a NULL frame is one slot, not unlimited
      expect(reasonOf(wholeAgain)).toBe("link_exists");

      // delete
      const d = await del(writer(), v.id);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toEqual({ id: v.id, deleted: true });
      expect((await row(v.id)).deleted_at).not.toBeNull();
      expect((await listOk(viewer, kind, t)).items.map((i) => i.id)).not.toContain(v.id);
      expect((await del(writer(), v.id)).statusCode).toBe(404); // gone is gone
      // the slot is free again
      const again = await createOk(writer(), kind, t, url);
      expect(again.id).not.toBe(v.id);

      const verbs = (await q().query(`SELECT verb FROM activities WHERE target_entity_type = 'figma_link' AND target_entity_id = $1 ORDER BY occurred_at, id`, [v.id])).rows.map((r) => r.verb);
      expect(verbs).toEqual(["created", "deleted"]);
      for (const id of [other.id, whole.id, again.id]) await del(writer(), id);
    });

    it("a target holds a bounded number of links", async () => {
      // 25 live links is the cap; the 26th is refused. Built on the part so the other cases keep their own counts.
      for (let i = 0; i < 25; i++) await createOk(manager, "campaign_part", partA, urlOf(nextKey()));
      const over = await create(manager, "campaign_part", partA, urlOf(nextKey()));
      expect(over.statusCode, over.body).toBe(409);
      expect(reasonOf(over)).toBe("too_many_links");
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [partA]);
    });

    it("two links on one file share one read of the file and of its comments", async () => {
      const key = nextKey();
      const a = await createOk(manager, "pm_task", taskA, urlOf(key, "1-2"));
      const b = await createOk(manager, "pm_task", taskA, urlOf(key, "1-3"));
      await ageCache(a.id);
      await ageCache(b.id);
      fx.seen = [];
      const got = await listOk(manager, "pm_task", taskA);
      expect(got.items.filter((i) => [a.id, b.id].includes(i.id)).every((i) => i.stale === false)).toBe(true);
      expect(figma.file()).toHaveLength(1);
      expect(figma.comments()).toHaveLength(1);
      expect(figma.nodes()).toHaveLength(2); // one frame name each
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });
  });

  // ═══════════════════════════════════ THE WRITE CHECK PER KIND (§36.5) ═══════════════════════════════════
  describe("the write check per target kind", () => {
    beforeEach(async () => { await connectOk(); fx.seen = []; });

    /** One attempt: the status, and whether a row was written. */
    async function attempt(as: string, kind: string, target: string) {
      const before = await liveLinks(target);
      const r = await create(as, kind, target, urlOf(nextKey()));
      const after = await liveLinks(target);
      return { r, wrote: after - before };
    }
    async function cleanUp(target: string) {
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [target]);
    }

    it("pm_task: `update` on the task. Members and managers write; a user outside the company is refused and nothing is written", async () => {
      for (const u of [admin, manager, member]) {
        const a = await attempt(u, "pm_task", taskA);
        expect(a.r.statusCode, a.r.body).toBe(201);
        expect(a.wrote).toBe(1);
      }
      const out = await attempt(outsider, "pm_task", taskA);
      expect(out.r.statusCode).toBe(403);
      expect(out.wrote).toBe(0);
      await cleanUp(taskA);
    });

    it("work_request: `deliver` OR `cancel`. The asker, the receiver's assignee, the receiving lead and a manager write; a stranger, a viewer, another department's lead and an outsider are refused", async () => {
      // cancel: the ASKER. deliver: the task's ASSIGNEE and the lead of the RECEIVING department. Both: a manager.
      for (const [name, u] of [["asker", requester], ["assignee", assignee], ["receiving lead", leadCreative], ["manager", manager], ["admin", admin]] as const) {
        const a = await attempt(u, "work_request", requestA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(201);
        expect(a.wrote, name).toBe(1);
      }
      for (const [name, u] of [["stranger member", stranger], ["viewer", viewer], ["another department's lead", leadSeo], ["outsider", outsider]] as const) {
        const a = await attempt(u, "work_request", requestA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(403);
        expect(a.wrote, name).toBe(0);
      }
      await cleanUp(requestA);
    });

    it("work_request: the same check gates DELETE, and a stranger's refusal leaves the link live", async () => {
      const v = await createOk(requester, "work_request", requestA, urlOf(nextKey()));
      for (const u of [stranger, viewer, leadSeo, outsider]) {
        const r = await del(u, v.id);
        expect(r.statusCode, r.body).toBe(403);
        expect((await row(v.id)).deleted_at).toBeNull();
      }
      // the receiving side deletes what the asker added
      const r = await del(assignee, v.id);
      expect(r.statusCode, r.body).toBe(200);
      expect((await row(v.id)).deleted_at).not.toBeNull();
    });

    it("work_request: reading needs only `read`: a stranger lists, an outsider does not", async () => {
      const v = await createOk(requester, "work_request", requestA, urlOf(nextKey()));
      expect((await listOk(stranger, "work_request", requestA)).items.map((i) => i.id)).toContain(v.id);
      expect((await listOk(viewer, "work_request", requestA)).items.map((i) => i.id)).toContain(v.id);
      expect((await list(outsider, "work_request", requestA)).statusCode).toBe(403);
      await cleanUp(requestA);
    });

    it("campaign_part: `update`. Managers, the part's owner and the lead of its department write; another member, a viewer, another department's lead and an outsider are refused", async () => {
      for (const [name, u] of [["admin", admin], ["manager", manager], ["owner", partOwner], ["lead of d-seo", leadSeo]] as const) {
        const a = await attempt(u, "campaign_part", partA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(201);
        expect(a.wrote, name).toBe(1);
      }
      for (const [name, u] of [["another member", member], ["a viewer", viewer], ["lead of d-creative", leadCreative], ["outsider", outsider]] as const) {
        const a = await attempt(u, "campaign_part", partA);
        expect(a.r.statusCode, `${name}: ${a.r.body}`).toBe(403);
        expect(a.wrote, name).toBe(0);
      }
      // delete follows the same check
      const v = await createOk(partOwner, "campaign_part", partA, urlOf(nextKey()));
      expect((await del(member, v.id)).statusCode).toBe(403);
      expect((await row(v.id)).deleted_at).toBeNull();
      expect((await del(leadSeo, v.id)).statusCode).toBe(200);
      // anyone who may read a part lists its links
      expect((await listOk(member, "campaign_part", partA)).items.length).toBeGreaterThan(0);
      await cleanUp(partA);
    });

    it("authorise first, then validate: a caller refused for the target gets 403 for a bad url, a caller allowed gets 400", async () => {
      const refused = await create(stranger, "work_request", requestA, "https://evil.example.com/design/x");
      expect(refused.statusCode).toBe(403);
      const refusedKind = await call("POST", links(), outsider, { targetKind: "nonsense", targetId: requestA, url: "x" });
      expect(refusedKind.statusCode).toBe(403);

      const bad = await create(requester, "work_request", requestA, "https://evil.example.com/design/x");
      expect(bad.statusCode).toBe(400);
      expect(reasonOf(bad)).toBe("bad_figma_url");
      expect(bad.json().field).toBe("url");
      expect(errOf(bad).startsWith("bad_figma_url")).toBe(true);
      const kind = await call("POST", links(), member, { targetKind: "nonsense", targetId: taskA, url: urlOf(nextKey()) });
      expect(kind.statusCode).toBe(400);
      expect(reasonOf(kind)).toBe("bad_target");
      expect(kind.json().field).toBe("targetKind");
      for (const u of [undefined, 42, "", "not a link", urlOf(nextKey()).replace("www.figma.com", "figma.org")]) {
        const r = await create(manager, "pm_task", taskA, u);
        expect(r.statusCode, `${String(u)}: ${r.body}`).toBe(400);
        expect(reasonOf(r)).toBe("bad_figma_url");
      }
      expect(await liveLinks(taskA)).toBe(0);
      expect(await liveLinks(requestA)).toBe(0);
    });

    it("a bad body to the export is refused only after the write check", async () => {
      const v = await createOk(requester, "work_request", requestA, urlOf(nextKey()));
      expect((await exportLink(stranger, v.id, { format: "gif" })).statusCode).toBe(403);
      const bad = await exportLink(requester, v.id, { format: "gif" });
      expect(bad.statusCode).toBe(400);
      expect(reasonOf(bad)).toBe("bad_export");
      expect(bad.json().field).toBe("format");
      expect((await exportLink(requester, v.id, { format: "png", scale: 4 })).json().field).toBe("scale");
      await cleanUp(requestA);
    });
  });

  // ═══════════════════════════════════ ANOTHER TENANT (§36.5: a target from another tenant answers 404) ═══════════════════════════════════
  describe("another tenant's target and links answer 404", () => {
    beforeEach(async () => { await connectOk(); fx.seen = []; });

    it("creating on a target that belongs to another tenant (or does not exist) is 404 target_not_found, after the kind's tenant-level gate", async () => {
      const cases: Array<[string, string]> = [["pm_task", taskB], ["work_request", requestB], ["campaign_part", partB]];
      for (const [kind, foreign] of cases) {
        // A's admin, on A's route, naming B's row: RLS hides it
        const r = await create(admin, kind, foreign, urlOf(nextKey()));
        expect(r.statusCode, `${kind}: ${r.body}`).toBe(404);
        expect(reasonOf(r)).toBe("target_not_found");
        expect(errOf(r).startsWith("target_not_found")).toBe(true);
        expect(await liveLinks(foreign)).toBe(0);
        // B's admin, on B's route, naming A's row
        const own = kind === "pm_task" ? taskA : kind === "work_request" ? requestA : partA;
        const back = await create(adminB, kind, own, urlOf(nextKey()), B);
        expect(back.statusCode, `${kind}: ${back.body}`).toBe(404);
        expect(reasonOf(back)).toBe("target_not_found");
        expect(await liveLinks(own)).toBe(0);
        // listing is the same answer
        const l = await list(admin, kind, foreign);
        expect(l.statusCode).toBe(404);
        expect(reasonOf(l)).toBe("target_not_found");
      }
      // not a uuid, and a uuid that is nothing
      for (const bad of ["nope", "123", newId()]) {
        const r = await create(admin, "pm_task", bad, urlOf(nextKey()));
        expect(r.statusCode, bad).toBe(404);
        expect(reasonOf(r)).toBe("target_not_found");
      }
      // and a user with no standing in A is refused BEFORE existence is revealed
      expect((await create(outsider, "pm_task", newId(), urlOf(nextKey()))).statusCode).toBe(403);
    });

    it("another tenant's link cannot be read, exported, thumbnailed or deleted through this tenant's routes", async () => {
      const vb = await createOkB(adminB, "pm_task", taskB);
      const before = await assetCount(B);
      for (const r of [
        await del(admin, vb),
        await thumb(admin, vb),
        await exportLink(admin, vb, { format: "png" }),
      ]) {
        expect(r.statusCode, r.body).toBe(404);
        expect(reasonOf(r)).toBe("link_not_found");
      }
      expect((await row(vb)).deleted_at).toBeNull();
      expect(await assetCount(B)).toBe(before);
    });

    /** A link in tenant B (which has no Figma connection: a link is saved anyway, with an empty cache). */
    async function createOkB(as: string, kind: string, target: string): Promise<string> {
      const r = await create(as, kind, target, urlOf(nextKey()), B);
      expect(r.statusCode, r.body).toBe(201); // saved even with no connection: the link is just a link
      return r.json().id as string;
    }
  });

  // ═══════════════════════════════════ THE CACHE (§36.3) ═══════════════════════════════════
  describe("the ten-minute refresh, stale, and never 'no comments'", () => {
    beforeEach(async () => { await connectOk(); fx.seen = []; });

    it("a fresh link is not refreshed on read; an older one is, once, and the numbers move", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      expect(v.openComments).toBe(1);
      fx.seen = [];
      // fresh: three reads, no call to Figma
      for (let i = 0; i < 3; i++) expect((await itemOf(v.id)).stale).toBe(false);
      expect(figma.api()).toHaveLength(0);
      const cachedAt = (await row(v.id)).cached_at as Date;

      // Figma changes; the cache is eleven minutes old: the next read refreshes it, exactly once
      fx.comments = [...baseComments(), onFrame("c6", "1:2"), onFrame("c7", "1:2")];
      fx.nodes = { ...fx.nodes, "1:2": "Hero banner v2" };
      await ageCache(v.id);
      const aged = (await row(v.id)).cached_at as Date;
      expect(aged.getTime()).toBeLessThan(cachedAt.getTime() - 10 * 60 * 1000);
      const got = (await itemOf(v.id));
      expect(got).toMatchObject({ openComments: 3, title: "Brand Kit / Hero banner v2", stale: false, refreshError: null });
      expect(figma.file()).toHaveLength(1);
      expect(figma.nodes()).toHaveLength(1);
      expect(figma.comments()).toHaveLength(1);
      const stored = await row(v.id);
      expect(stored.open_comments).toBe(3);
      expect((stored.cached_at as Date).getTime()).toBeGreaterThan(aged.getTime());
      // and that read made it fresh again
      fx.seen = [];
      await listOk(member, "pm_task", taskA);
      expect(figma.api()).toHaveLength(0);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a refresh that fails keeps the old numbers, says stale, and calls Figma once (no retry loop)", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      await ageCache(v.id);
      const old = await row(v.id);
      fx.mode = "down";
      fx.seen = [];
      const got = (await itemOf(v.id));
      expect(got).toMatchObject({ openComments: 1, title: "Brand Kit / Hero banner", stale: true, refreshError: "figma_unavailable" });
      expect(figma.api()).toHaveLength(1);
      const after = await row(v.id);
      expect(after.open_comments).toBe(old.open_comments);
      expect((after.cached_at as Date).getTime()).toBe((old.cached_at as Date).getTime()); // not freshened by a failure
      // Figma is back: the NEXT read is the retry
      fx.mode = "ok";
      const healed = (await itemOf(v.id));
      expect(healed).toMatchObject({ stale: false, refreshError: null, openComments: 1 });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a 429 keeps the old numbers, says stale, is not retried and stops the rest of that read", async () => {
      const a = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      const b = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-3"));
      await ageCache(a.id);
      await ageCache(b.id);
      fx.mode = "rate_limited";
      fx.seen = [];
      const got = await listOk(member, "pm_task", taskA);
      expect(got.items).toHaveLength(2);
      for (const i of got.items) expect(i).toMatchObject({ stale: true, refreshError: "figma_rate_limited", openComments: 1 });
      expect(figma.api()).toHaveLength(1); // the first link's first call; the second link was not even tried
      expect((await row(a.id)).open_comments).toBe(1);
      expect((await row(b.id)).open_comments).toBe(1);
      fx.mode = "ok";
      const healed = await listOk(member, "pm_task", taskA);
      expect(healed.items.every((i) => i.stale === false)).toBe(true);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a token Figma refuses is figma_refused: stale, the old numbers kept, never zero", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      await ageCache(v.id);
      fx.mode = "refused";
      const got = (await itemOf(v.id));
      expect(got).toMatchObject({ stale: true, refreshError: "figma_refused", openComments: 1, title: "Brand Kit / Hero banner" });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a link first saved while Figma refuses has NO numbers (null), not zero comments", async () => {
      fx.mode = "refused";
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      expect(v).toMatchObject({ openComments: null, title: null, lastModified: null, cachedAt: null, stale: true, refreshError: "figma_refused" });
      const stored = await row(v.id);
      expect(stored.open_comments).toBeNull();
      expect(stored.cached_at).toBeNull();
      fx.mode = "ok";
      expect((await itemOf(v.id))).toMatchObject({ openComments: 1, stale: false });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a frame Figma no longer has is figma_not_found, not a frame with no comments", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      await ageCache(v.id);
      fx.nodes = {};
      const got = (await itemOf(v.id));
      expect(got).toMatchObject({ stale: true, refreshError: "figma_not_found", openComments: 1 });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("with Figma not connected the links still list, with their cached values and the reason", async () => {
      const fresh = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      const old = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-3"));
      await ageCache(old.id);
      await disconnectOk();
      fx.seen = [];
      const got = await listOk(member, "pm_task", taskA);
      expect(got.figmaConnected).toBe(false);
      const byId = new Map(got.items.map((i) => [i.id, i]));
      expect(byId.get(fresh.id)).toMatchObject({ stale: false, refreshError: null, openComments: 1 }); // not due: nothing to refresh
      expect(byId.get(old.id)).toMatchObject({ stale: true, refreshError: "figma_not_connected", openComments: 1 }); // due, cannot
      expect(figma.api()).toHaveLength(0);
      // a link may even be saved with no connection: just a link, with an empty cache, and the reason
      const bare = await createOk(manager, "pm_task", taskA, urlOf(nextKey()));
      expect(bare).toMatchObject({ openComments: null, title: null, stale: true, refreshError: "figma_not_connected" });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
      await connectOk();
    });
  });

  // ═══════════════════════════════════ THE THUMBNAIL (§36.3) ═══════════════════════════════════
  describe("the thumbnail is proxied, never stored", () => {
    beforeEach(async () => { await connectOk(); fx.seen = []; fx.downloaded = []; });

    it("streams the PNG Figma rendered, with the cache header, and stores nothing", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      fx.seen = [];
      const storeBefore = mem.size;
      const assetsBefore = await assetCount();
      const r = await thumb(viewer, v.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["content-type"]).toContain("image/png");
      expect(r.headers["cache-control"]).toBe("private, max-age=600");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(Array.from(r.rawPayload)).toEqual(Array.from(fx.downloaded[fx.downloaded.length - 1]));
      // the render asked Figma for the frame, as a small PNG
      expect(figma.images()).toHaveLength(1);
      expect(figma.images()[0].url).toContain("ids=1%3A2");
      expect(figma.images()[0].url).toContain("format=png");
      expect(figma.images()[0].url).toContain("scale=0.5");
      expect(figma.downloads()).toHaveLength(1);
      // never stored: not in the object store, not in the Asset Library, not on the link
      expect(mem.size).toBe(storeBefore);
      expect(await assetCount()).toBe(assetsBefore);
      expect((await row(v.id)).asset_group_id).toBeNull();
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a whole-file link renders the file's first page", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey()));
      fx.seen = [];
      const r = await thumb(member, v.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(figma.images()[0].url).toContain("ids=0%3A1");
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("read on the target is the gate: a stranger reads a request's thumbnail, an outsider does not; no Figma call on a refusal", async () => {
      const v = await createOk(requester, "work_request", requestA, urlOf(nextKey(), "1-2"));
      fx.seen = [];
      expect((await thumb(stranger, v.id)).statusCode).toBe(200);
      fx.seen = [];
      expect((await thumb(outsider, v.id)).statusCode).toBe(403);
      expect(figma.api()).toHaveLength(0);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [requestA]);
    });

    it("failures are named: not connected 409, refused 409, rate limited 503, a node Figma cannot render 502", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      fx.mode = "refused";
      let r = await thumb(member, v.id);
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "figma_refused"]);
      expect(errOf(r).startsWith("figma_refused")).toBe(true);
      fx.mode = "rate_limited";
      r = await thumb(member, v.id);
      expect([r.statusCode, reasonOf(r)]).toEqual([503, "figma_rate_limited"]);
      fx.mode = "down";
      r = await thumb(member, v.id);
      expect([r.statusCode, reasonOf(r)]).toEqual([502, "figma_unavailable"]);
      fx.mode = "ok";
      fx.render = "null";
      r = await thumb(member, v.id);
      expect([r.statusCode, reasonOf(r)]).toEqual([502, "figma_render_failed"]);
      fx.render = "ok";
      await disconnectOk();
      fx.seen = [];
      r = await thumb(member, v.id);
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "figma_not_connected"]);
      expect(errOf(r).startsWith("figma_not_connected")).toBe(true);
      expect(figma.api()).toHaveLength(0);
      await connectOk();
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });
  });

  // ═══════════════════════════════════ EXPORTS (§36.4) ═══════════════════════════════════
  describe("export into the Asset Library", () => {
    beforeEach(async () => { await connectOk(); fx.seen = []; fx.downloaded = []; });
    const group = async (id: string) =>
      (await q().query(`SELECT * FROM creative_assets WHERE COALESCE(version_group_id, id) = $1 ORDER BY version_no`, [id])).rows;

    it("the first export is version 1 and starts the group on the link; the second is version 2 of that group", async () => {
      const key = nextKey();
      const v = await createOk(manager, "pm_task", taskA, urlOf(key, "1-2"));
      expect(v.assetGroupId).toBeNull();

      const one = await exportLink(member, v.id, { format: "png", scale: 2 });
      expect(one.statusCode, one.body).toBe(201);
      const e1 = one.json();
      expect(e1).toMatchObject({ linkId: v.id, versionNo: 1, assetGroupId: e1.assetId, contentType: "image/png", name: "Brand Kit Hero banner.png" });
      const a1 = (await group(e1.assetId));
      expect(a1).toHaveLength(1);
      expect(a1[0]).toMatchObject({
        id: e1.assetId, tenant_id: A, uploader_id: member, content_type: "image/png", version_group_id: null, version_no: 1,
        supersedes_id: null, department_id: "d-seo", preset_id: "figma", name: "Brand Kit Hero banner.png",
      });
      expect(a1[0].grade).toEqual({ source: "figma", fileKey: key, nodeId: "1:2", lastModified: "2026-10-10T08:30:00Z" });
      expect(mem.get(a1[0].graded_key)?.equals(fx.downloaded[0])).toBe(true); // the bytes are what Figma rendered
      expect(Number(a1[0].graded_byte_size)).toBe(fx.downloaded[0].byteLength);
      expect((await row(v.id)).asset_group_id).toBe(e1.assetId);
      const img = figma.images()[0].url;
      expect(img).toContain("format=png");
      expect(img).toContain("scale=2");
      expect(img).toContain("ids=1%3A2");

      const two = await exportLink(manager, v.id, { format: "svg" });
      expect(two.statusCode, two.body).toBe(201);
      const e2 = two.json();
      expect(e2).toMatchObject({ versionNo: 2, assetGroupId: e1.assetId, contentType: "image/svg+xml", name: "Brand Kit Hero banner.svg" });
      expect(e2.assetId).not.toBe(e1.assetId);
      const rows = await group(e1.assetId);
      expect(rows.map((r) => [r.version_no, r.version_group_id, r.supersedes_id, r.content_type])).toEqual([
        [1, null, null, "image/png"],
        [2, e1.assetId, e1.assetId, "image/svg+xml"],
      ]);
      expect(rows[1].department_id).toBe("d-seo");
      expect((await row(v.id)).asset_group_id).toBe(e1.assetId); // the group never moves
      // v1's file is untouched by v2 (a version's file never changes, §35.2)
      expect(mem.get(rows[0].graded_key)?.equals(fx.downloaded[0])).toBe(true);
      expect(mem.get(rows[1].graded_key)?.equals(fx.downloaded[1])).toBe(true);

      // the Asset Library sees the history through its own route
      const versions = await call("GET", `/api/${A}/creative/assets/${e2.assetId}/versions`, member);
      expect(versions.statusCode, versions.body).toBe(200);
      expect(versions.json().map((x: any) => [x.versionNo, x.id])).toEqual([[2, e2.assetId], [1, e1.assetId]]);
      expect(versions.json()[0].versionGroupId).toBe(e1.assetId);

      const verbs = (await q().query(`SELECT verb FROM activities WHERE target_entity_type = 'figma_link' AND target_entity_id = $1 ORDER BY occurred_at, id`, [v.id])).rows.map((r) => r.verb);
      expect(verbs).toEqual(["created", "exported", "exported"]);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a PDF export carries the PDF content type; a whole-file link exports the file's first page and records it", async () => {
      const key = nextKey();
      const v = await createOk(manager, "pm_task", taskA, urlOf(key));
      const r = await exportLink(manager, v.id, { format: "pdf" });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ contentType: "application/pdf", name: "Brand Kit.pdf" });
      const a = (await group(r.json().assetId))[0];
      expect(a.content_type).toBe("application/pdf");
      expect(a.grade).toEqual({ source: "figma", fileKey: key, nodeId: "0:1", lastModified: "2026-10-10T08:30:00Z" });
      expect(figma.images()[0].url).toContain("ids=0%3A1");
      expect(figma.images()[0].url).toContain("format=pdf");
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("two exports at the same moment never share a version number and never start two groups", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-3"));
      const [a, b] = await Promise.all([exportLink(manager, v.id, { format: "png" }), exportLink(manager, v.id, { format: "png" })]);
      expect(a.statusCode, a.body).toBe(201);
      expect(b.statusCode, b.body).toBe(201);
      expect([a.json().versionNo, b.json().versionNo].sort()).toEqual([1, 2]);
      expect(a.json().assetGroupId).toBe(b.json().assetGroupId);
      const gid = (await row(v.id)).asset_group_id as string;
      expect(gid).toBe(a.json().assetGroupId);
      const rows = await group(gid);
      expect(rows.map((r) => r.version_no)).toEqual([1, 2]);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a group whose every version was deleted starts a fresh one", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      const e1 = (await exportLink(manager, v.id, { format: "png" })).json();
      await q().query(`UPDATE creative_assets SET deleted_at = now() WHERE COALESCE(version_group_id, id) = $1`, [e1.assetId]);
      const r = await exportLink(manager, v.id, { format: "png" });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ versionNo: 1 });
      expect(r.json().assetGroupId).toBe(r.json().assetId);
      expect(r.json().assetGroupId).not.toBe(e1.assetId);
      expect((await row(v.id)).asset_group_id).toBe(r.json().assetId);
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("the write check AND `file` create: a viewer may write a task link but cannot export; an outsider cannot either; nothing is saved", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      const before = await assetCount();
      for (const u of [viewer, outsider]) {
        const r = await exportLink(u, v.id, { format: "png" });
        expect(r.statusCode, r.body).toBe(403);
      }
      expect(await assetCount()).toBe(before);
      expect(figma.images()).toHaveLength(0); // refused before Figma was asked
      expect((await row(v.id)).asset_group_id).toBeNull();
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("a request's link exports with the request's department, and the request is NOT delivered", async () => {
      const v = await createOk(requester, "work_request", requestA, urlOf(nextKey(), "1-2"));
      const before = (await q().query(`SELECT status FROM work_requests WHERE id = $1`, [requestA])).rows[0].status;
      expect(before).toBe("open");
      // the asker (cancel) exports; a stranger and a viewer may not
      expect((await exportLink(stranger, v.id, { format: "png" })).statusCode).toBe(403);
      expect((await exportLink(viewer, v.id, { format: "png" })).statusCode).toBe(403);
      const r = await exportLink(requester, v.id, { format: "png" });
      expect(r.statusCode, r.body).toBe(201);
      const a = (await group(r.json().assetId))[0];
      expect(a.department_id).toBe("d-creative");
      expect((await q().query(`SELECT status FROM work_requests WHERE id = $1`, [requestA])).rows[0].status).toBe("open");
      expect(Number((await q().query(`SELECT count(*)::int AS n FROM work_request_assets WHERE request_id = $1`, [requestA])).rows[0].n)).toBe(0);
      // the receiving side then exports a second version of the same group
      const r2 = await exportLink(assignee, v.id, { format: "png" });
      expect(r2.statusCode, r2.body).toBe(201);
      expect(r2.json()).toMatchObject({ versionNo: 2, assetGroupId: r.json().assetId });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [requestA]);
    });

    it("a part's link exports under the part's department, for the part's owner", async () => {
      const v = await createOk(partOwner, "campaign_part", partA, urlOf(nextKey(), "1-2"));
      expect((await exportLink(member, v.id, { format: "png" })).statusCode).toBe(403);
      const r = await exportLink(partOwner, v.id, { format: "png" });
      expect(r.statusCode, r.body).toBe(201);
      expect((await group(r.json().assetId))[0].department_id).toBe("d-seo");
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [partA]);
    });

    it("figma_not_connected: nothing is saved and Figma is not called", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      await disconnectOk();
      fx.seen = [];
      const before = await assetCount();
      const r = await exportLink(manager, v.id, { format: "png" });
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "figma_not_connected"]);
      expect(errOf(r).startsWith("figma_not_connected")).toBe(true);
      expect(figma.api()).toHaveLength(0);
      expect(await assetCount()).toBe(before);
      expect((await row(v.id)).asset_group_id).toBeNull();
      await connectOk();
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });

    it("figma failures save nothing: refused 409, rate limited 503, no render 502, and the link stays without a group", async () => {
      const v = await createOk(manager, "pm_task", taskA, urlOf(nextKey(), "1-2"));
      const before = await assetCount();
      const storeBefore = mem.size;
      fx.mode = "refused";
      let r = await exportLink(manager, v.id, { format: "png" });
      expect([r.statusCode, reasonOf(r)]).toEqual([409, "figma_refused"]);
      fx.mode = "rate_limited";
      r = await exportLink(manager, v.id, { format: "png" });
      expect([r.statusCode, reasonOf(r)]).toEqual([503, "figma_rate_limited"]);
      fx.mode = "ok";
      fx.render = "null";
      r = await exportLink(manager, v.id, { format: "png" });
      expect([r.statusCode, reasonOf(r)]).toEqual([502, "figma_render_failed"]);
      expect(await assetCount()).toBe(before);
      expect(mem.size).toBe(storeBefore);
      expect((await row(v.id)).asset_group_id).toBeNull();
      fx.render = "ok";
      // and the first good export afterwards is still version 1
      const ok = await exportLink(manager, v.id, { format: "png" });
      expect(ok.json()).toMatchObject({ versionNo: 1 });
      await q().query(`UPDATE figma_links SET deleted_at = now() WHERE target_id = $1`, [taskA]);
    });
  });

  // ═══════════════════════════════════ THE SHARED SAVE PATH ═══════════════════════════════════
  describe("POST /creative/assets still saves through the same path", () => {
    it("a plain upload and a versionOf upload behave as DW-6h specified", async () => {
      const GRADE = { exposure: 0, contrast: 1, temperature: 0, tint: 0, gamma: 1, saturation: 1, vibrance: 0, highlights: 0, shadows: 0 };
      const up = (extra: Record<string, unknown>) =>
        call("POST", `/api/${A}/creative/assets`, member, { name: "u.webp", grade: GRADE, graded: Buffer.from([1, 2, 3]).toString("base64"), ...extra });
      const v1 = await up({ departmentId: "d-creative" });
      expect(v1.statusCode, v1.body).toBe(201);
      expect(v1.json()).toMatchObject({ versionNo: 1, versionGroupId: v1.json().id, supersedesId: null, gradedByteSize: 3, originalByteSize: 0 });
      const v2 = await up({ versionOf: v1.json().id });
      expect(v2.json()).toMatchObject({ versionNo: 2, versionGroupId: v1.json().id, supersedesId: v1.json().id });
      expect((await q().query(`SELECT department_id, content_type FROM creative_assets WHERE id = $1`, [v2.json().id])).rows[0]).toEqual({ department_id: "d-creative", content_type: "image/webp" });
      expect((await up({ versionOf: newId() })).statusCode).toBe(404);
      const noGrade = await call("POST", `/api/${A}/creative/assets`, member, { name: "x", graded: "AQID" });
      expect(noGrade.statusCode).toBe(400);
    });
  });
});
