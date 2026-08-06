// ASST-18 — `GET :tenantId/assistant/capabilities`: `visibleToolsFor(user) ∩ tenant's module gates`.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-18").
// Design: docs/blueprints/assistant-foundation.md §8.
//
// ── WHAT THESE TESTS ARE INSTRUMENTED TO PROVE ─────────────────────────────────────────────────────
// The tempting assertion is "the endpoint returned something for each user". That would pass even if
// both users got the SAME list (e.g. a broken filter that ignores the OBO envelope entirely). So the
// two-user test asserts the SET DIFFERENCE directly: a tool visible to A but not B is PRESENT for A
// and ABSENT (not present-but-disabled) for B, and vice versa — proving the endpoint actually
// consulted the hub per-principal rather than returning a fixed catalogue.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";
import { agencyModule } from "../agency";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface FakeHub {
  url: string;
  close: () => Promise<void>;
  visibility: Map<string, Array<{ name: string; description: string }>>;
  received: Array<{ oboExternalId: string | undefined }>;
}

async function startFakeHub(): Promise<FakeHub> {
  const visibility = new Map<string, Array<{ name: string; description: string }>>();
  const received: FakeHub["received"] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const oboExternalId = req.headers["x-obo-external-id"] as string | undefined;
        received.push({ oboExternalId });
        const tools = (oboExternalId ? visibility.get(oboExternalId) : undefined) ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())), visibility, received };
}

describe.skipIf(!TEST_URL)("Assistant capabilities (ASST-18) — live PG + Cerbos", () => {
  let app: NestFastifyApplication;
  let hub: FakeHub;
  let A: string; // tenant WITH agency enabled
  let B: string; // tenant WITHOUT agency enabled (same assistant module though)
  let owner: string; // sees projects.list + agency.pendingApprovals
  let restricted: string; // sees only clients.list (an ungated, but hub-restricted, tool)
  let unlisted: string; // absent from the hub's visibility map entirely — deny-by-default probe

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);
    registerModule(agencyModule);

    A = await createCompany("Capabilities Tenant A", ["assistant", "agency"]);
    B = await createCompany("Capabilities Tenant B (no agency)", ["assistant"]);

    owner = await createUser("owner@asst-caps.test");
    restricted = await createUser("restricted@asst-caps.test");
    unlisted = await createUser("unlisted@asst-caps.test");

    for (const u of [owner, restricted, unlisted]) {
      await addMembership(A, u);
      await addMembership(B, u);
    }
    const memberRole = await createRole("member");
    for (const u of [owner, restricted, unlisted]) {
      await grantRole(u, memberRole, "company", A);
      await grantRole(u, memberRole, "company", B);
    }

    hub = await startFakeHub();
    // `owner` sees a MODULE-gated tool (agency.pendingApprovals) + an ungated one (projects.list).
    // `restricted` sees ONLY a different ungated tool. `unlisted` is absent from the map entirely.
    hub.visibility.set(owner, [
      { name: "projects.list", description: "List projects" },
      { name: "agency.pendingApprovals", description: "Approvals waiting" },
    ]);
    hub.visibility.set(restricted, [{ name: "clients.list", description: "List clients" }]);

    config.services.hub = { url: hub.url, token: "hub-token", assuranceToken: "" };

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await hub.close();
    await teardownTestDb();
  });

  async function getCapabilities(tenantId: string, userId: string) {
    const r = await app.inject({ method: "GET", url: `/api/${tenantId}/assistant/capabilities`, headers: asUser(userId) });
    expect(r.statusCode).toBe(200);
    return r.json() as { tools: Array<{ name: string; description: string; module: string | null }>; hubConfigured: boolean };
  }

  it("THE SET DIFFERENCE: two users of differing hub-visibility get DISJOINT capability lists — an unauthorized tool is ABSENT, not greyed", async () => {
    const ownerCaps = await getCapabilities(A, owner);
    const restrictedCaps = await getCapabilities(A, restricted);

    const ownerNames = new Set(ownerCaps.tools.map((t) => t.name));
    const restrictedNames = new Set(restrictedCaps.tools.map((t) => t.name));

    // Owner sees BOTH tools the hub granted them.
    expect(ownerNames).toEqual(new Set(["agency.pendingApprovals", "projects.list"]));
    // Restricted sees ONLY their own tool.
    expect(restrictedNames).toEqual(new Set(["clients.list"]));

    // The actual set-difference assertion: what owner has that restricted does not, and vice versa.
    const ownerOnly = [...ownerNames].filter((n) => !restrictedNames.has(n));
    const restrictedOnly = [...restrictedNames].filter((n) => !ownerNames.has(n));
    expect(new Set(ownerOnly)).toEqual(new Set(["agency.pendingApprovals", "projects.list"]));
    expect(new Set(restrictedOnly)).toEqual(new Set(["clients.list"]));

    // ABSENCE, not a disabled/greyed entry: no tool in either list carries any kind of
    // "unavailable"/"denied" marker — the tool object for a tool the user cannot call simply does
    // not exist in the array at all.
    expect(JSON.stringify(ownerCaps.tools)).not.toContain("clients.list");
    expect(JSON.stringify(restrictedCaps.tools)).not.toContain("agency.pendingApprovals");
    expect(JSON.stringify(restrictedCaps.tools)).not.toContain("projects.list");

    // Descriptions came through (the whole reason ASST-18 needed a def-returning fetch, not just names).
    const approvals = ownerCaps.tools.find((t) => t.name === "agency.pendingApprovals");
    expect(approvals?.description).toBe("Approvals waiting");
  });

  it("a user absent from the hub's map entirely (deny-by-default) sees ZERO capabilities — a clean empty list, not an error", async () => {
    const caps = await getCapabilities(A, unlisted);
    expect(caps.tools).toEqual([]);
    expect(caps.hubConfigured).toBe(true);
  });

  it("MODULE GATING: the module-owned tool disappears for a tenant that doesn't have that module enabled — the ungated tool does not", async () => {
    // Same USER (owner), same hub visibility map entry, but a DIFFERENT tenant (B) that has
    // 'assistant' but NOT 'agency' enabled. `agency.pendingApprovals` is owned by the agency
    // ModuleContract (see capabilities.ts's header) — it must be filtered out here even though the
    // hub said this user may call it, because the OWNING MODULE is off for this tenant.
    const capsB = await getCapabilities(B, owner);
    const namesB = new Set(capsB.tools.map((t) => t.name));
    expect(namesB.has("agency.pendingApprovals")).toBe(false);
    // The ungated platform-core tool is untouched by the module toggle.
    expect(namesB.has("projects.list")).toBe(true);

    // And the SAME user, SAME hub answer, on tenant A (agency enabled) sees both again — proving
    // the difference between A and B is the module gate, not something about the user or the hub.
    const capsA = await getCapabilities(A, owner);
    expect(new Set(capsA.tools.map((t) => t.name))).toEqual(new Set(["agency.pendingApprovals", "projects.list"]));

    // The `module` field correctly attributes ownership for the UI's grouping.
    const approvalsA = capsA.tools.find((t) => t.name === "agency.pendingApprovals");
    expect(approvalsA?.module).toBe("agency");
    const projectsA = capsA.tools.find((t) => t.name === "projects.list");
    expect(projectsA?.module).toBeNull();
  });

  it("FAILS CLOSED: an unreachable hub yields an empty capability list (never a cached or optimistic one), and `hubConfigured` still reports the hub as configured", async () => {
    const saved = config.services.hub;
    config.services.hub = { url: "http://127.0.0.1:1", token: "hub-token", assuranceToken: "" }; // nothing listens there
    try {
      const caps = await getCapabilities(A, owner);
      expect(caps.tools).toEqual([]);
      expect(caps.hubConfigured).toBe(true); // configured — just unreachable right now
    } finally {
      config.services.hub = saved;
    }
  });

  it("the hub not being configured AT ALL is reported honestly via `hubConfigured: false`", async () => {
    const saved = config.services.hub;
    config.services.hub = { url: "", token: "", assuranceToken: "" };
    try {
      const caps = await getCapabilities(A, owner);
      expect(caps.tools).toEqual([]);
      expect(caps.hubConfigured).toBe(false);
    } finally {
      config.services.hub = saved;
    }
  });

  it("consulted the hub under EACH caller's own OBO envelope — never a fixed/shared identity", async () => {
    const before = hub.received.length;
    await getCapabilities(A, owner);
    await getCapabilities(A, restricted);
    const calls = hub.received.slice(before);
    expect(calls.map((c) => c.oboExternalId)).toEqual([owner, restricted]);
  });
});
