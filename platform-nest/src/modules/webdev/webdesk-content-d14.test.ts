// WSK-59 done-when 7 — an AGENT calling `webdesk.content.unpublish` (and `.delete`) unattended SUSPENDS (D14), and on
// approval it RE-DRIVES as the ORIGINAL principal: the requester's identity, never the approver's, over the real
// executor (`executeApprovedAutomationWrite`), the real BFF route and the real Cerbos policies.
//
// The hub itself is a stub (the d14-09 convention: a live hub would hide the platform's half behind a 200/403),
// but it is a FAITHFUL one: on `tools/call` it looks the tool up in the module's REAL `mcpTools` declaration, fills
// the path template from the arguments exactly as `mcp-hub/src/module-tools.ts` does (path args consumed, the rest
// are the JSON body for a non-GET), and calls the platform with the OBO headers the executor sent. So the whole
// loop (registry entry → precondition → grant → hub → BFF route → editorial assertion → Zone B) is exercised; only
// the hub's own suspend decision is proved separately, in `mcp-hub/src/webdesk-content-tools.test.ts`.
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../../testing/fixtures";
import { getExecutable } from "../../core/approval-executables";
import { executeApprovedAutomationWrite } from "../../core/approval-execute";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { webdevModule } from "./index";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const GRANT_SECRET = "wsk59-d14-test-secret-not-a-real-one";
const HUB = "http://hub.wsk59.test";
const REQUESTER_LINK = "tg:wsk59-publisher";

const realFetch = globalThis.fetch;
const sse = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

describe.skipIf(!live)("WSK-59 · D14: an unattended agent's unpublish/delete suspends, and re-drives as the original principal", () => {
  let app: NestFastifyApplication;
  let A: string;
  let admin: string; // the APPROVER (company_admin): must never be the executing principal
  let requester: string; // the original requester: a publisher (webdev_manager) with a verified identity link
  let zb: FakeZoneB;
  const signer = makeTestSigner();
  let hubCalls: Array<{ name: string; args: Record<string, unknown>; headers: Record<string, string> }> = [];
  let hubAgentHeader: string | null = "agent:wsk59-ops";
  let liveItem: FakeItem;
  let draftItem: FakeItem;

  /** The hub's `callPlatform`, restated against the module's real tool declaration. */
  async function platformCall(name: string, args: Record<string, unknown>, headers: Record<string, string>) {
    const def = webdevModule.mcpTools.find((t) => t.name === name);
    if (!def || !def.pathTemplate) throw new Error(`no callable tool ${name}`);
    const used = new Set<string>();
    const path = def.pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => {
      used.add(p);
      return encodeURIComponent(String(args[p]));
    });
    const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
    return app.inject({
      method: (def.method ?? "GET") as "GET" | "POST" | "PATCH",
      url: path,
      headers: {
        authorization: "Bearer svc-token",
        "x-obo-provider": headers["x-obo-provider"],
        "x-obo-external-id": headers["x-obo-external-id"],
        ...(hubAgentHeader ? { "x-obo-agent": hubAgentHeader } : {}),
        "content-type": "application/json",
      },
      payload: def.method === "GET" ? undefined : JSON.stringify(rest),
    });
  }

  function installHubStub(): void {
    hubCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      if (!String(url).startsWith(HUB)) return realFetch(url as never, init as never);
      const rpc = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
      hubCalls.push({ name: rpc.params.name, args: rpc.params.arguments, headers: init.headers });
      const res = await platformCall(rpc.params.name, rpc.params.arguments, init.headers);
      const text = res.statusCode >= 200 && res.statusCode < 300 ? res.body : (res.json() as { error?: string }).error ?? `platform ${res.statusCode}`;
      const result = { content: [{ type: "text", text }], ...(res.statusCode >= 300 ? { isError: true } : {}) };
      return { ok: true, status: 200, text: async () => sse({ jsonrpc: "2.0", id: 1, result }) };
    }) as unknown as typeof fetch);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: HUB, token: "hub-token", assuranceToken: "" };
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-59 D14 Co", ["webdev"]);
    admin = await createUser("wsk59-d14-admin@ex.test");
    requester = await createUser("wsk59-d14-publisher@ex.test");
    await addMembership(A, admin);
    await addMembership(A, requester);
    await grantRole(admin, await createRole("company_admin"), "company", A);
    await grantRole(requester, await createRole("webdev_manager"), "company", A);
    await linkIdentity(requester, "telegram", REQUESTER_LINK, true);
    zb = new FakeZoneB(A, "00000000-0000-4000-8000-00000000000b");
    app = await buildApp();
  }, 120_000);

  beforeEach(() => {
    zb.reset();
    signer.calls.length = 0;
    hubAgentHeader = "agent:wsk59-ops";
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    liveItem = zb.seedItem({ siteId: GAIADA_SITE, slug: "d14.live", publishedVersion: 1, publishState: "published" });
    draftItem = zb.seedItem({ siteId: GAIADA_SITE, slug: "d14.draft" });
    installHubStub();
  });
  afterEach(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const argsFor = (tool: "unpublish" | "delete", it: FakeItem) => ({
    tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, itemId: it.itemId,
    ...(tool === "unpublish" ? { expectedPublishedVersion: 1 } : { baseVersion: 1 }),
  });

  /** What mcp-hub does when it SUSPENDS an unattended call: files an origin='agent' row for the requester. */
  async function suspend(tool: "unpublish" | "delete", args: Record<string, unknown>): Promise<string> {
    const filed = await app.inject({
      method: "POST",
      url: `/api/${A}/automation-approvals`,
      headers: { authorization: "Bearer svc-token", "x-obo-provider": "telegram", "x-obo-external-id": REQUESTER_LINK },
      payload: {
        workflowId: "wsk59-agent", toolName: `webdesk.content.${tool}`, toolArgs: args, impact: "medium",
        reason: `agent asked to ${tool} a page`, origin: "agent", agentName: "wsk59-ops",
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    return (filed.json() as { id: string }).id;
  }
  const decide = (id: string) =>
    app.inject({
      method: "POST", url: `/api/${A}/automation-approvals/${id}/decide`,
      headers: { authorization: "Bearer svc-token", "x-user-id": admin }, payload: { decision: "approved" },
    });
  async function row(id: string) {
    const { rows } = await adminPool().query<{ status: string; execution_status: string; execution_error: string | null; executed_by: string | null; decided_by: string | null }>(
      `SELECT status, execution_status, execution_error, executed_by, decided_by FROM automation_approvals WHERE id = $1`, [id],
    );
    return rows[0];
  }

  it("the registry carries BOTH tools, so an approval is `pending` for execution — not the silent `not_applicable`", async () => {
    for (const tool of ["unpublish", "delete"] as const) {
      expect(getExecutable(`webdesk.content.${tool}`), tool).toBeDefined();
      const id = await suspend(tool, argsFor(tool, tool === "unpublish" ? liveItem : draftItem));
      expect((await decide(id)).statusCode).toBe(200);
      expect((await row(id)).execution_status, tool).toBe("pending");
    }
    expect(hubCalls).toHaveLength(0); // nothing ran at approval time
  });

  it("🔴 unpublish: approve → ONE hub call → ONE Zone B unpublish, signed for the REQUESTER (never the approver), pk=agent", async () => {
    const id = await suspend("unpublish", argsFor("unpublish", liveItem));
    expect((await decide(id)).statusCode).toBe(200);
    const out = await executeApprovedAutomationWrite(A, id);
    expect(out.status).toBe("executed");

    // the hub leg went out under the REQUESTER's OBO envelope
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].name).toBe("webdesk.content.unpublish");
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe(REQUESTER_LINK);

    // exactly one write reached Zone B, and the editorial assertion's `sub` is the requester
    expect(zb.writes).toHaveLength(1);
    expect(zb.writes[0]).toMatchObject({ command: "content.unpublish", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, itemId: liveItem.itemId }, body: { expectedPublishedVersion: 1 } });
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]).toMatchObject({ sub: requester, pk: "agent", agt: "agent:wsk59-ops", cmd: "content.unpublish" });
    expect(signer.calls[0].sub).not.toBe(admin);
    expect(signer.calls[0]).not.toHaveProperty("apr");
    expect(liveItem.publishState).toBe("unpublished");

    const r = await row(id);
    expect(r).toMatchObject({ status: "approved", execution_status: "executed", executed_by: requester, decided_by: admin });

    // the ledger resolves the opaque `sub`: both rows are the requester's
    const { rows } = await adminPool().query<{ actor_id: string; metadata: { outcome?: string } }>(
      `SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = 'webdesk.content.unpublish' ORDER BY occurred_at, id`, [A],
    );
    expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
    expect(rows.every((x) => x.actor_id === requester)).toBe(true);
  });

  it("delete: the same loop, as the requester", async () => {
    const id = await suspend("delete", argsFor("delete", draftItem));
    await decide(id);
    expect((await executeApprovedAutomationWrite(A, id)).status).toBe("executed");
    expect(zb.writes).toHaveLength(1);
    expect(zb.writes[0]).toMatchObject({ command: "content.delete" });
    expect(signer.calls[0]).toMatchObject({ sub: requester, cmd: "content.delete" });
    expect(draftItem.deletedAt).not.toBeNull();
  });

  it("🔴 a role revoked between approval and execution FAILS the row closed: Zone B receives nothing (no fallback to the approver)", async () => {
    const id = await suspend("unpublish", argsFor("unpublish", liveItem));
    await decide(id);
    await adminPool().query(`DELETE FROM user_roles WHERE user_id = $1`, [requester]);
    try {
      const out = await executeApprovedAutomationWrite(A, id);
      expect(out.status).toBe("failed");
      expect(zb.writes).toHaveLength(0);
      expect(signer.calls).toHaveLength(0);
      const r = await row(id);
      expect(r.execution_status).toBe("failed");
      expect(r.executed_by).not.toBe(admin);
      expect(r.execution_error).toMatch(/hub_denied|not authorized/i);
      expect(liveItem.publishState).toBe("published");
    } finally {
      await grantRole(requester, await createRole("webdev_manager"), "company", A);
    }
  });

  it("a malformed row fails the structural precondition: the hub is called ZERO times and no grant is spent", async () => {
    const id = await suspend("unpublish", { ...argsFor("unpublish", liveItem), itemId: "not-a-uuid" });
    await decide(id);
    const out = await executeApprovedAutomationWrite(A, id);
    expect(out.status).toBe("failed");
    expect(hubCalls).toHaveLength(0);
    expect((await row(id)).execution_error).toMatch(/precondition_failed.*item_id_invalid/);
  });

  it("the world moved since filing: Zone B's own guard is the atomic re-check (typed 409 → row failed, the item untouched)", async () => {
    const id = await suspend("unpublish", { ...argsFor("unpublish", liveItem), expectedPublishedVersion: 3 });
    await decide(id);
    const out = await executeApprovedAutomationWrite(A, id);
    expect(out.status).toBe("failed");
    expect(liveItem.publishState).toBe("published");
    expect((await row(id)).execution_error).toMatch(/409|published-version-changed|platform/);
  });
});
