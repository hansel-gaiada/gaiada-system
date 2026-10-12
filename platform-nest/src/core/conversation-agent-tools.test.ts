// PV4-07 — the agent tools for client Conversation and meeting minutes (`conversation.*`, `meetings.*Minutes`), under
// owner ruling PV-D23: AGENTS DRAFT, STAFF SEND. One GOLDEN CASE per tool, the typed refusals an agent gets, the D14 bar,
// and the activity rows (readiness-bar criteria 3, 5, 6, 7).
//
// ── HOW A TOOL IS DRIVEN HERE ────────────────────────────────────────────────────────────────────
// `callTool()` builds the request FROM THE TOOL DEF, the way mcp-hub does: `validate-args.ts` first applies each property's
// schema `default` and refuses a missing `required` argument, then `callPlatform` fills the `:param` tokens from the args
// (URL-encoded, a missing one is an error), sends the rest as the JSON body for anything but a GET and DROPS the leftovers
// of a GET. The request is injected into the real Nest app, so a wrong path template, a wrong method, a missing required
// arg or a body member the route does not read fails HERE.
//
// Two kinds of caller, because the ticket is about the difference between them:
//   * a HUMAN under their own identity: the OBO envelope the hub sends (`x-obo-provider`, `x-obo-external-id`, plus
//     `x-obo-agent`, the MCP client's name). Cerbos sees a person (`users.kind = 'employee'`).
//   * an AGENT: a staff principal whose `users.kind` is `bot` (or `automation`), reached with `x-user-id`. Cerbos sees the
//     class of principal the PV-D23 DENY refuses.
//
// The hub itself is not in this harness (its gate is not what is under test). The D14 section stubs only the hub's
// transport, to prove that no approval, however it was decided, can make the platform run a barred tool.
//
// Needs DATABASE_URL_TEST + a Cerbos loaded with the current policies (resource_conversation.yaml,
// resource_meeting_recording.yaml). Runs on the Linux gate; the DB part is skipped elsewhere, and a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject, linkIdentity } from "../testing/fixtures";
import { allCoreTools } from "./core-tools";
import {
  CONVERSATION_BARRED_TOOLS, CONVERSATION_BAR_REASON, getBarredExecutable, getExecutable, isBarredExecutable,
  registerExecutableApproval,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";

const svc = { authorization: "Bearer svc-token" };
const AGENT = "agent:pv407";
const defs = new Map(allCoreTools().map((t) => [t.name, t]));

const READS = ["conversation.listThreads", "conversation.getThread", "meetings.getMinutes"];
const LOW = ["conversation.draftReply", "conversation.closeThread", "conversation.reopenThread", "meetings.saveMinutes"];
const MEDIUM = ["conversation.post", "conversation.open", "conversation.sendDraft", "meetings.shareMinutes"];
const ALL_TOOLS = [...READS, ...LOW, ...MEDIUM];

describe("PV4-07 · the conversation and minutes tool defs (no database)", () => {
  it("all eleven are declared", () => {
    for (const n of ALL_TOOLS) expect(defs.has(n), n).toBe(true);
    expect(ALL_TOOLS).toHaveLength(11);
  });

  it("🔴 impact: the four client-reaching writes are MEDIUM, the drafts and thread state LOW, the reads carry none", () => {
    for (const n of MEDIUM) expect({ n, impact: defs.get(n)!.impact, write: defs.get(n)!.write }).toEqual({ n, impact: "medium", write: true });
    for (const n of LOW) expect({ n, impact: defs.get(n)!.impact, write: defs.get(n)!.write }).toEqual({ n, impact: "low", write: true });
    for (const n of READS) {
      expect(defs.get(n)!.write, n).toBeUndefined();
      expect(defs.get(n)!.impact, n).toBeUndefined();
      expect(defs.get(n)!.method, n).toBe("GET");
    }
  });

  it("every one is a verified-caller tool (no n8n 'low assurance' exception)", () => {
    for (const n of ALL_TOOLS) expect(defs.get(n)!.minAssurance, n).toBe("verified");
  });

  it("methods and paths: each tool fronts exactly one real endpoint", () => {
    const shape = (n: string) => `${defs.get(n)!.method} ${defs.get(n)!.pathTemplate}`;
    expect(shape("conversation.getThread")).toBe("GET /api/:tenantId/conversation/:threadId");
    expect(shape("conversation.draftReply")).toBe("POST /api/:tenantId/conversation/:threadId/drafts");
    expect(shape("conversation.post")).toBe("POST /api/:tenantId/conversation/:threadId/messages");
    expect(shape("conversation.open")).toBe("POST /api/:tenantId/conversation");
    expect(shape("conversation.sendDraft")).toBe("POST /api/:tenantId/conversation/drafts/:draftId/send");
    expect(shape("conversation.closeThread")).toBe("PATCH /api/:tenantId/conversation/:threadId");
    expect(shape("conversation.reopenThread")).toBe("PATCH /api/:tenantId/conversation/:threadId");
    expect(shape("meetings.getMinutes")).toBe("GET /api/:tenantId/meetings/:meetingId/minutes");
    expect(shape("meetings.saveMinutes")).toBe("PUT /api/:tenantId/meetings/:meetingId/minutes");
    expect(shape("meetings.shareMinutes")).toBe("POST /api/:tenantId/meetings/:meetingId/minutes/share");
  });

  it("draftReply REQUIRES the idempotency key (criterion 3); the thread-state tools fix their status", () => {
    expect((defs.get("conversation.draftReply")!.inputSchema as { required: string[] }).required).toEqual(
      ["tenantId", "threadId", "body", "idempotencyKey"],
    );
    const status = (n: string) => (defs.get(n)!.inputSchema as { properties: { status: { enum: string[]; default: string } } }).properties.status;
    expect(status("conversation.closeThread")).toMatchObject({ enum: ["closed"], default: "closed" });
    expect(status("conversation.reopenThread")).toMatchObject({ enum: ["open"], default: "open" });
  });

  it("listThreads carries every filter as a defaulted query token (the hub fills every :token; `all` means no filter)", () => {
    const d = defs.get("conversation.listThreads")!;
    const props = (d.inputSchema as { properties: Record<string, { default?: string }> }).properties;
    for (const k of ["clientId", "projectId", "status", "awaitingReply"]) {
      expect(d.pathTemplate, k).toContain(`${k}=:${k}`);
      expect(props[k].default, k).toBe("all");
    }
  });

  it("🔴 the four client-reaching writes are BARRED from D14 auto-execution, with the PV-D23 reason, and have no executor", () => {
    expect([...CONVERSATION_BARRED_TOOLS].sort()).toEqual([...MEDIUM].sort());
    for (const n of MEDIUM) {
      expect(isBarredExecutable(n), `${n} must be barred`).toBe(true);
      expect(getExecutable(n), `${n} must have no executor`).toBeUndefined();
      expect(getBarredExecutable(n)).toMatchObject({ reason: CONVERSATION_BAR_REASON });
      expect(getBarredExecutable(n)!.note).toContain("PV-D23: agents draft, staff send — nothing an agent writes reaches a client until a staff member approves it");
    }
    expect(CONVERSATION_BAR_REASON).toBe("agents_draft_staff_send");
    // The drafts are LOW (they execute directly and never reach the registry), so they are neither barred nor registered.
    for (const n of ["conversation.draftReply", "meetings.saveMinutes", "conversation.closeThread", "conversation.reopenThread"]) {
      expect(isBarredExecutable(n), n).toBe(false);
      expect(getExecutable(n), n).toBeUndefined();
    }
  });

  it("🔴 a later ticket cannot make a barred tool executable: registerExecutableApproval throws for each", () => {
    for (const n of MEDIUM) {
      expect(() => registerExecutableApproval({ toolName: n }), n).toThrow(/BARRED/);
    }
  });

  it("nothing here is on the n8n allow-list: no workflow writes to a conversation in v1", () => {
    const policy = readFileSync(join(__dirname, "..", "..", "..", "mcp-hub", "src", "automation-policy.ts"), "utf8");
    for (const n of ALL_TOOLS) expect(policy.includes(`"${n}"`), `${n} must not be in automation-policy.ts`).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!TEST_URL)("PV4-07 · the conversation and minutes tools through the real endpoints", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let clientB: string;
  let p1: string; // clientA's project
  let admin: string; // company_admin: decides approvals
  let member: string; // a staff person (employee) who uses an MCP client under their own identity
  let member2: string; // a second staff person
  let bot: string; // member role, users.kind = 'bot'
  let automation: string; // member role, users.kind = 'automation'
  let clientUser: string; // authors the client-side messages

  const as = (ext: string) => ({ provider: "platform", externalId: ext });
  const MEMBER = as("pv407-member");
  const MEMBER2 = as("pv407-member2");
  type Who = { provider: string; externalId: string };
  type Caller = { obo: Who } | { userId: string };
  const human = (w: Who): Caller => ({ obo: w });
  const agent = (userId: string): Caller => ({ userId });

  /** mcp-hub's `validate-args` (defaults, then required) followed by `callPlatform` (fill the path, body or not), against the real app. */
  function toolRequest(name: string, input: Record<string, unknown>, caller: Caller) {
    const def = defs.get(name);
    if (!def) throw new Error(`no such tool: ${name}`);
    const schema = def.inputSchema as { properties?: Record<string, { default?: unknown }>; required?: string[] };
    const args: Record<string, unknown> = { ...input };
    for (const [k, p] of Object.entries(schema.properties ?? {})) if (args[k] === undefined && p && "default" in p) args[k] = p.default;
    for (const k of schema.required ?? []) if (args[k] == null || args[k] === "") throw new Error(`${name}: missing required argument: ${k}`);
    const used = new Set<string>();
    const url = def.pathTemplate!.replace(/:([A-Za-z0-9_]+)/g, (_m, n: string) => {
      used.add(n);
      const v = args[n];
      if (v == null || v === "") throw new Error(`missing path parameter: ${n}`);
      return encodeURIComponent(String(v));
    });
    const method = def.method ?? "GET";
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
    const headers = "obo" in caller
      ? { ...svc, "x-obo-provider": caller.obo.provider, "x-obo-external-id": caller.obo.externalId, "x-obo-agent": AGENT }
      : { ...svc, "x-user-id": caller.userId };
    return { method, url, headers, ...(method !== "GET" ? { payload: rest } : {}) };
  }
  const callTool = (name: string, args: Record<string, unknown>, caller: Caller) =>
    app.inject(toolRequest(name, args, caller) as Parameters<typeof app.inject>[0]);
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  const activities = async (entityId: string, verb: string) =>
    (await adminPool().query<{ actor_id: string; metadata: Record<string, unknown> & { via?: { agent?: string } } }>(
      `SELECT actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = $2 ORDER BY occurred_at`, [entityId, verb],
    )).rows;
  const messageRows = async (threadId: string) =>
    (await adminPool().query<{ id: string; author_id: string; author_side: string; drafted_by: string | null; body: string }>(
      `SELECT id, author_id, author_side, drafted_by, body FROM conversation_messages WHERE thread_id = $1 ORDER BY created_at, id`, [threadId],
    )).rows;
  const draftRow = async (id: string) =>
    (await adminPool().query<{ status: string; drafted_by: string; sent_message_id: string | null; decided_by: string | null; thread_id: string }>(
      `SELECT status, drafted_by, sent_message_id, decided_by, thread_id FROM conversation_drafts WHERE id = $1`, [id],
    )).rows[0];
  const threadStatus = async (id: string) =>
    (await adminPool().query<{ status: string }>(`SELECT status FROM conversation_threads WHERE id = $1`, [id])).rows[0]?.status;
  const minutesRow = async (meetingId: string) =>
    (await adminPool().query<{ id: string; status: string; body_md: string; drafted_by: string | null; updated_by: string | null; shared_by: string | null }>(
      `SELECT id, status, body_md, drafted_by, updated_by, shared_by FROM meeting_minutes WHERE meeting_recording_id = $1`, [meetingId],
    )).rows[0];

  const seedMeeting = async (title: string, clientId: string | null, projectId: string | null): Promise<string> => {
    const id = newId();
    await adminPool().query(
      `INSERT INTO meeting_recordings
         (id, tenant_id, meeting_id, client_id, project_id, title, status, started_at, transcript, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'transcribed', '2026-10-05T09:00:00Z', 'the transcript an agent reads', $7)`,
      [id, co, `pv407-${id}`, clientId, projectId, title, config.originSite],
    );
    return id;
  };
  /** A message the CLIENT wrote, straight into the table (the portal routes are PV4-03's suite, not this one's). */
  async function clientSays(threadId: string, body: string): Promise<void> {
    await adminPool().query(
      `INSERT INTO conversation_messages (id, tenant_id, thread_id, author_id, author_side, body, origin_site)
       VALUES ($1, $2, $3, $4, 'client', $5, $6)`,
      [newId(), co, threadId, clientUser, body, config.originSite],
    );
    await adminPool().query(`UPDATE conversation_threads SET last_message_at = now() WHERE id = $1`, [threadId]);
  }

  // threads built up by the golden cases
  let generalA: string;
  let threadP1: string;
  let generalB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "pv407-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    co = await createCompany("PV407 Agency");
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    clientA = await createClient(co, "PV407 Client A");
    clientB = await createClient(co, "PV407 Client B");
    p1 = await createProject(co, "PV407 A Project");
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientA, p1]);

    const staffUser = async (email: string, name: string, role: string) => {
      const u = await createUser(email, name);
      await addMembership(co, u);
      await grantRole(u, role, "company", co);
      return u;
    };
    admin = await staffUser("admin@pv407.test", "Ada Admin", adminRole);
    member = await staffUser("member@pv407.test", "Mia Member", memberRole);
    member2 = await staffUser("member2@pv407.test", "Max Member", memberRole);
    bot = await staffUser("bot@pv407.test", "Reply Bot", memberRole);
    automation = await staffUser("automation@pv407.test", "Flow Bot", memberRole);
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [automation]);
    clientUser = await createUser("contact@client-a.test", "Cleo Client");
    await linkIdentity(member, MEMBER.provider, MEMBER.externalId, true);
    await linkIdentity(member2, MEMBER2.provider, MEMBER2.externalId, true);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── golden cases: one per tool ───────────────────────────────────────────────────────────────

  describe("golden cases", () => {
    it("conversation.open: a person starts the client's general thread, then a project thread; an `posted` activity names the person and the MCP client", async () => {
      const r = await callTool("conversation.open", { tenantId: co, clientId: clientA, body: "Welcome aboard." }, human(MEMBER));
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ created: true });
      generalA = r.json().threadId;
      const msgs = await messageRows(generalA);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ author_id: member, author_side: "staff", drafted_by: null, body: "Welcome aboard." });
      const acts = await activities(generalA, "posted");
      expect(acts).toHaveLength(1);
      expect(acts[0].actor_id).toBe(member);
      expect(acts[0].metadata.via?.agent).toBe(AGENT);

      const proj = await callTool("conversation.open", { tenantId: co, clientId: clientA, projectId: p1, subject: "Launch plan", body: "Kickoff notes." }, human(MEMBER));
      expect(proj.statusCode, proj.body).toBe(201);
      threadP1 = proj.json().threadId;
      expect(threadP1).not.toBe(generalA);
      const b = await callTool("conversation.open", { tenantId: co, clientId: clientB, body: "Hello B." }, human(MEMBER));
      generalB = b.json().threadId;
    });

    it("conversation.listThreads: every filter, by id; `all` is no filter; awaitingReply finds the thread the client spoke on last", async () => {
      await clientSays(generalA, "Can you confirm the date?");
      const ids = async (args: Record<string, unknown>) => {
        const r = await callTool("conversation.listThreads", { tenantId: co, ...args }, human(MEMBER));
        expect(r.statusCode, r.body).toBe(200);
        return (r.json() as { threads: Array<{ id: string }> }).threads.map((t) => t.id);
      };
      const everything = await ids({});
      expect(everything).toEqual(expect.arrayContaining([generalA, threadP1, generalB]));
      const forA = await ids({ clientId: clientA });
      expect(forA).toEqual(expect.arrayContaining([generalA, threadP1]));
      expect(forA).not.toContain(generalB);
      expect(await ids({ clientId: clientA, projectId: p1 })).toEqual([threadP1]);
      const waiting = await ids({ awaitingReply: "true" });
      expect(waiting).toContain(generalA);
      expect(waiting).not.toContain(threadP1); // our message is the last one there
      expect(await ids({ awaitingReply: "false" })).not.toContain(generalA);
      expect(await ids({ status: "closed" })).not.toContain(generalA);
      expect(await ids({ status: "open", clientId: clientA })).toEqual(expect.arrayContaining([generalA, threadP1]));
      // A bad value is a 400, not an empty list; the sentinel is not a loophole for a uuid check.
      const bad = await callTool("conversation.listThreads", { tenantId: co, clientId: "not-a-uuid" }, human(MEMBER));
      expect(bad.statusCode).toBe(400);
      // An agent may read.
      const asBot = await callTool("conversation.listThreads", { tenantId: co }, agent(bot));
      expect(asBot.statusCode, asBot.body).toBe(200);
    });

    it("conversation.draftReply: an AGENT drafts (201, staff-only), the actor is the bot, and a retry with the same key returns the SAME draft", async () => {
      const first = await callTool("conversation.draftReply", { tenantId: co, threadId: generalA, body: "Yes, the 14th works.", idempotencyKey: "pv407-k1" }, agent(bot));
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json()).toMatchObject({ threadId: generalA, status: "pending", replayed: false, clientVisible: false });
      const draftId = first.json().id as string;
      expect(await draftRow(draftId)).toMatchObject({ status: "pending", drafted_by: bot, sent_message_id: null });
      // criterion 6: the activity names the bot as the actor
      const acts = await activities(generalA, "drafted_reply");
      expect(acts).toHaveLength(1);
      expect(acts[0].actor_id).toBe(bot);
      expect(acts[0].metadata.draftId).toBe(draftId);
      // criterion 3: a retry is the same draft, and writes no second row or activity
      const again = await callTool("conversation.draftReply", { tenantId: co, threadId: generalA, body: "Yes, the 14th works.", idempotencyKey: "pv407-k1" }, agent(bot));
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json()).toMatchObject({ id: draftId, replayed: true });
      const n = await adminPool().query(`SELECT count(*)::int AS n FROM conversation_drafts WHERE thread_id = $1 AND idempotency_key = 'pv407-k1'`, [generalA]);
      expect(n.rows[0].n).toBe(1);
      expect(await activities(generalA, "drafted_reply")).toHaveLength(1);
      // the same key on ANOTHER thread is refused, not silently re-used
      const clash = await callTool("conversation.draftReply", { tenantId: co, threadId: threadP1, body: "x", idempotencyKey: "pv407-k1" }, agent(bot));
      expect(clash.statusCode).toBe(409);
      // an automation principal drafts too
      const viaAuto = await callTool("conversation.draftReply", { tenantId: co, threadId: generalA, body: "From a workflow", idempotencyKey: "pv407-k-auto" }, agent(automation));
      expect(viaAuto.statusCode, viaAuto.body).toBe(201);
      expect((await draftRow(viaAuto.json().id)).drafted_by).toBe(automation);
    });

    it("conversation.getThread: the messages (oldest first) AND the pending drafts, drafts marked never client-visible", async () => {
      const r = await callTool("conversation.getThread", { tenantId: co, threadId: generalA }, human(MEMBER));
      expect(r.statusCode, r.body).toBe(200);
      const out = r.json() as {
        thread: { id: string; awaitingReply: boolean; pendingDrafts: number };
        messages: Array<{ body: string; authorSide: string }>;
        drafts: Array<{ body: string; draftedBy: string; status: string; clientVisible: boolean }>;
      };
      expect(out.thread.id).toBe(generalA);
      expect(out.messages.map((m) => m.body)).toEqual(["Welcome aboard.", "Can you confirm the date?"]);
      expect(out.thread.awaitingReply).toBe(true);
      expect(out.thread.pendingDrafts).toBeGreaterThanOrEqual(1);
      const mine = out.drafts.find((d) => d.body === "Yes, the 14th works.")!;
      expect(mine).toMatchObject({ draftedBy: bot, status: "pending", clientVisible: false });
      // the agent reads it too
      expect((await callTool("conversation.getThread", { tenantId: co, threadId: generalA }, agent(bot))).statusCode).toBe(200);
      expect((await callTool("conversation.getThread", { tenantId: co, threadId: newId() }, human(MEMBER))).statusCode).toBe(404);
    });

    it("conversation.sendDraft: a PERSON sends the bot's draft; the author is the person, `drafted_by` is the bot, and both are on record", async () => {
      const d = await callTool("conversation.draftReply", { tenantId: co, threadId: generalA, body: "Confirmed for the 14th.", idempotencyKey: "pv407-k2" }, agent(bot));
      const draftId = d.json().id as string;
      const sent = await callTool("conversation.sendDraft", { tenantId: co, draftId }, human(MEMBER2));
      expect(sent.statusCode, sent.body).toBe(201);
      expect(sent.json()).toMatchObject({ threadId: generalA, draftId, draftedBy: bot, clientVisible: true });
      const msgId = sent.json().id as string;
      const msg = (await messageRows(generalA)).find((m) => m.id === msgId)!;
      expect(msg).toMatchObject({ author_id: member2, author_side: "staff", drafted_by: bot, body: "Confirmed for the 14th." });
      expect(await draftRow(draftId)).toMatchObject({ status: "sent", sent_message_id: msgId, decided_by: member2 });
      const acts = (await activities(generalA, "sent_draft")).filter((a) => a.metadata.draftId === draftId);
      expect(acts).toHaveLength(1);
      expect(acts[0].actor_id).toBe(member2);
      expect(acts[0].metadata.draftedBy).toBe(bot);
      // a second send is refused: nothing is sent twice
      const twice = await callTool("conversation.sendDraft", { tenantId: co, draftId }, human(MEMBER2));
      expect(twice.statusCode).toBe(409);
      expect((await messageRows(generalA)).filter((m) => m.body === "Confirmed for the 14th.")).toHaveLength(1);
    });

    it("conversation.post: a person replies on a thread as themselves, with an activity naming them", async () => {
      const r = await callTool("conversation.post", { tenantId: co, threadId: threadP1, body: "Here is the plan." }, human(MEMBER));
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ threadId: threadP1, clientVisible: true });
      const msg = (await messageRows(threadP1)).find((m) => m.id === r.json().id)!;
      expect(msg).toMatchObject({ author_id: member, author_side: "staff", drafted_by: null, body: "Here is the plan." });
      const acts = (await activities(threadP1, "posted")).filter((a) => a.metadata.messageId === r.json().id);
      expect(acts).toHaveLength(1);
      expect(acts[0].actor_id).toBe(member);
      expect(acts[0].metadata.via?.agent).toBe(AGENT);
    });

    it("conversation.closeThread / conversation.reopenThread: a person closes and reopens; each change writes one activity; a repeat writes none", async () => {
      const close = await callTool("conversation.closeThread", { tenantId: co, threadId: threadP1 }, human(MEMBER));
      expect(close.statusCode, close.body).toBe(200);
      expect(close.json()).toMatchObject({ id: threadP1, status: "closed" });
      expect(await threadStatus(threadP1)).toBe("closed");
      const closed = await activities(threadP1, "closed");
      expect(closed).toHaveLength(1);
      expect(closed[0].actor_id).toBe(member);
      // closed means closed: a draft and a post are both refused
      const noDraft = await callTool("conversation.draftReply", { tenantId: co, threadId: threadP1, body: "x", idempotencyKey: "pv407-closed" }, agent(bot));
      expect(noDraft.statusCode).toBe(409);
      expect((await callTool("conversation.post", { tenantId: co, threadId: threadP1, body: "x" }, human(MEMBER))).statusCode).toBe(409);
      // a repeat is a no-op
      expect((await callTool("conversation.closeThread", { tenantId: co, threadId: threadP1 }, human(MEMBER))).statusCode).toBe(200);
      expect(await activities(threadP1, "closed")).toHaveLength(1);

      const reopen = await callTool("conversation.reopenThread", { tenantId: co, threadId: threadP1 }, human(MEMBER));
      expect(reopen.statusCode, reopen.body).toBe(200);
      expect(reopen.json()).toMatchObject({ status: "open" });
      expect(await threadStatus(threadP1)).toBe("open");
      const reopened = await activities(threadP1, "reopened");
      expect(reopened).toHaveLength(1);
      expect(reopened[0].actor_id).toBe(member);
      expect((await callTool("conversation.reopenThread", { tenantId: co, threadId: threadP1 }, human(MEMBER))).statusCode).toBe(200);
      expect(await activities(threadP1, "reopened")).toHaveLength(1);
    });
  });

  // ── PV-D23: an agent is refused, with a TYPED reason that names what to do instead ─────────────

  describe("an agent is refused with a typed reason (criterion 5), and nothing reaches the client", () => {
    type Refusal = { error: string; reason?: string };

    it("🔴 a bot's conversation.post: 403 `agents_draft_staff_send`, the message names conversation.draftReply, no message is written", async () => {
      const before = (await messageRows(generalA)).length;
      const r = await callTool("conversation.post", { tenantId: co, threadId: generalA, body: "agent speaking" }, agent(bot));
      expect(r.statusCode, r.body).toBe(403);
      const j = r.json() as Refusal;
      expect(j.reason).toBe("agents_draft_staff_send");
      expect(j.error).toContain("conversation.draftReply");
      expect(j.error).toContain("cerbos denied post on conversation"); // Cerbos is still the decider, and its reason is kept
      expect((await messageRows(generalA)).length).toBe(before);
    });

    it("🔴 a bot's conversation.open: the same typed refusal, and no thread or message is created", async () => {
      const freshClient = await createClient(co, "PV407 Client C");
      const r = await callTool("conversation.open", { tenantId: co, clientId: freshClient, body: "agent opening" }, agent(bot));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ reason: "agents_draft_staff_send" });
      expect((r.json() as Refusal).error).toContain("conversation.draftReply");
      const n = await adminPool().query(`SELECT count(*)::int AS n FROM conversation_threads WHERE client_id = $1`, [freshClient]);
      expect(n.rows[0].n).toBe(0);
    });

    it("🔴 a bot's conversation.sendDraft: typed refusal, the draft stays pending and nothing is sent", async () => {
      const d = await callTool("conversation.draftReply", { tenantId: co, threadId: generalA, body: "Please hold this.", idempotencyKey: "pv407-k3" }, agent(bot));
      const draftId = d.json().id as string;
      const before = (await messageRows(generalA)).length;
      const r = await callTool("conversation.sendDraft", { tenantId: co, draftId }, agent(bot));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ reason: "agents_draft_staff_send" });
      expect((r.json() as Refusal).error).toContain("conversation.draftReply");
      expect(await draftRow(draftId)).toMatchObject({ status: "pending", sent_message_id: null });
      expect((await messageRows(generalA)).length).toBe(before);
    });

    it("an AUTOMATION principal is refused the same way (post and sendDraft)", async () => {
      const post = await callTool("conversation.post", { tenantId: co, threadId: generalA, body: "from a workflow" }, agent(automation));
      expect(post.statusCode).toBe(403);
      expect(post.json()).toMatchObject({ reason: "agents_draft_staff_send" });
      const d = await callTool("conversation.draftReply", { tenantId: co, threadId: generalA, body: "wf draft", idempotencyKey: "pv407-k4" }, agent(automation));
      const send = await callTool("conversation.sendDraft", { tenantId: co, draftId: d.json().id }, agent(automation));
      expect(send.statusCode).toBe(403);
      expect(send.json()).toMatchObject({ reason: "agents_draft_staff_send" });
    });

    it("🔴 a bot's closeThread and reopenThread: typed `agents_cannot_manage_conversation`, the thread is untouched", async () => {
      const close = await callTool("conversation.closeThread", { tenantId: co, threadId: generalA }, agent(bot));
      expect(close.statusCode, close.body).toBe(403);
      expect(close.json()).toMatchObject({ reason: "agents_cannot_manage_conversation" });
      expect((close.json() as Refusal).error).toContain("conversation.draftReply");
      expect(await threadStatus(generalA)).toBe("open");
      const reopen = await callTool("conversation.reopenThread", { tenantId: co, threadId: generalA }, agent(bot));
      expect(reopen.statusCode).toBe(403);
      expect(reopen.json()).toMatchObject({ reason: "agents_cannot_manage_conversation" });
    });

    it("a human refused for lacking the role gets the ordinary 403, NOT the agent reason (the code is not a catch-all)", async () => {
      const viewerRole = await createRole("viewer");
      const viewer = await createUser("viewer@pv407.test", "Vic Viewer");
      await addMembership(co, viewer);
      await grantRole(viewer, viewerRole, "company", co);
      const r = await app.inject({
        method: "POST", url: `/api/${co}/conversation/${generalA}/messages`, headers: asUser(viewer), payload: { body: "nope" },
      });
      expect(r.statusCode).toBe(403);
      expect((r.json() as Refusal).reason).toBeUndefined();
    });

    it("the Cerbos wall holds on its own: a bot reaching the plain route with no tool is refused the same way", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/conversation/${generalA}/messages`, headers: asUser(bot), payload: { body: "direct" },
      });
      expect(r.statusCode).toBe(403);
      expect((r.json() as Refusal).reason).toBe("agents_draft_staff_send");
    });
  });

  // ── minutes ──────────────────────────────────────────────────────────────────────────────────

  describe("meeting minutes: an agent drafts, a person shares", () => {
    let meeting: string;
    let noClientMeeting: string;

    beforeAll(async () => {
      meeting = await seedMeeting("Quarterly review", clientA, p1);
      noClientMeeting = await seedMeeting("Internal retro", null, null);
    });

    it("meetings.getMinutes: `minutes` is null until some were saved", async () => {
      const r = await callTool("meetings.getMinutes", { tenantId: co, meetingId: meeting }, human(MEMBER));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ meetingId: meeting, clientId: clientA, minutes: null, shareable: false });
      expect((await callTool("meetings.getMinutes", { tenantId: co, meetingId: newId() }, human(MEMBER))).statusCode).toBe(404);
    });

    it("meetings.saveMinutes: an AGENT drafts them; `drafted_by` is the bot, the actor is on record, a repeat replaces in place", async () => {
      const r = await callTool("meetings.saveMinutes", { tenantId: co, meetingId: meeting, bodyMd: "## Review\n- date agreed: the 14th" }, agent(bot));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().minutes).toMatchObject({ status: "draft", draftedBy: bot, updatedBy: bot, clientVisible: false });
      expect(await minutesRow(meeting)).toMatchObject({ status: "draft", drafted_by: bot, updated_by: bot });
      const acts = await activities(meeting, "saved_minutes");
      expect(acts).toHaveLength(1);
      expect(acts[0].actor_id).toBe(bot);
      expect(acts[0].metadata).toMatchObject({ byAgent: true });
      expect(JSON.stringify(acts[0].metadata)).not.toContain("date agreed"); // never the text
      // idempotent: the same save is the same state, still one minutes row
      const again = await callTool("meetings.saveMinutes", { tenantId: co, meetingId: meeting, bodyMd: "## Review\n- date agreed: the 14th" }, agent(bot));
      expect(again.statusCode).toBe(200);
      expect(again.json().minutes.id).toBe(r.json().minutes.id);
      const n = await adminPool().query(`SELECT count(*)::int AS n FROM meeting_minutes WHERE meeting_recording_id = $1`, [meeting]);
      expect(n.rows[0].n).toBe(1);
      // and the reader sees the draft, flagged as not client-visible
      const got = await callTool("meetings.getMinutes", { tenantId: co, meetingId: meeting }, human(MEMBER));
      expect(got.json()).toMatchObject({ shareable: true, minutes: { status: "draft", draftedBy: bot, clientVisible: false } });
    });

    it("🔴 a bot's meetings.shareMinutes: typed `agents_draft_staff_send`, the message names meetings.saveMinutes, the minutes stay a draft", async () => {
      const r = await callTool("meetings.shareMinutes", { tenantId: co, meetingId: meeting }, agent(bot));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ reason: "agents_draft_staff_send" });
      expect((r.json() as { error: string }).error).toContain("meetings.saveMinutes");
      expect((r.json() as { error: string }).error).toContain("cerbos denied share_minutes on meeting_recording");
      expect(await minutesRow(meeting)).toMatchObject({ status: "draft", shared_by: null });
      const auto = await callTool("meetings.shareMinutes", { tenantId: co, meetingId: meeting }, agent(automation));
      expect(auto.statusCode).toBe(403);
      expect(auto.json()).toMatchObject({ reason: "agents_draft_staff_send" });
    });

    it("meetings.shareMinutes: a PERSON shares the bot's draft; `shared_by` is the person, `drafted_by` stays the bot; a shared draft is frozen", async () => {
      const r = await callTool("meetings.shareMinutes", { tenantId: co, meetingId: meeting }, human(MEMBER));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ meetingId: meeting, status: "shared", sharedBy: member });
      expect(await minutesRow(meeting)).toMatchObject({ status: "shared", drafted_by: bot, shared_by: member });
      const acts = await activities(meeting, "shared_minutes");
      expect(acts).toHaveLength(1);
      expect(acts[0].actor_id).toBe(member);
      expect(acts[0].metadata.via?.agent).toBe(AGENT);
      // frozen: an agent's later save is refused, a repeat share is refused
      const late = await callTool("meetings.saveMinutes", { tenantId: co, meetingId: meeting, bodyMd: "rewritten" }, agent(bot));
      expect(late.statusCode).toBe(409);
      expect((await minutesRow(meeting)).body_md).toContain("date agreed");
      expect((await callTool("meetings.shareMinutes", { tenantId: co, meetingId: meeting }, human(MEMBER))).statusCode).toBe(409);
    });

    it("a meeting with no client cannot have its minutes shared, even by a person (nobody to share with)", async () => {
      expect((await callTool("meetings.saveMinutes", { tenantId: co, meetingId: noClientMeeting, bodyMd: "internal notes" }, human(MEMBER))).statusCode).toBe(200);
      const r = await callTool("meetings.shareMinutes", { tenantId: co, meetingId: noClientMeeting }, human(MEMBER));
      expect(r.statusCode, r.body).toBe(409);
    });
  });

  // ── the D14 bar: approving an agent's request can never run a barred tool ──────────────────────

  describe("D14: approving an agent's request for a barred tool executes nothing", () => {
    const realFetch = globalThis.fetch;
    let hubCalls = 0;

    beforeEach(() => {
      hubCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: unknown) => {
        if (!String(url).startsWith("http://hub.test")) return realFetch(url as never, init as never);
        hubCalls++;
        throw new Error("the hub must never be called for a barred tool");
      }) as unknown as typeof fetch);
    });
    afterEach(() => vi.restoreAllMocks());

    const args = (tool: string): Record<string, unknown> => {
      switch (tool) {
        case "conversation.post": return { tenantId: co, threadId: generalA, body: "approved agent words" };
        case "conversation.open": return { tenantId: co, clientId: clientA, body: "approved agent words" };
        case "conversation.sendDraft": return { tenantId: co, draftId: newId() };
        default: return { tenantId: co, meetingId: newId() };
      }
    };
    async function file(tool: string, status: "pending" | "approved"): Promise<string> {
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          status === "pending"
            ? `INSERT INTO automation_approvals
                 (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, agent_name, origin_site)
               VALUES ($1,$2,'wf:pv407-agent',$3,$4,'medium',$5,'agent',$6,'main')`
            : `INSERT INTO automation_approvals
                 (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
                  origin, origin_site, execution_status)
               VALUES ($1,$2,'wf:pv407-agent',$3,$4,'medium','approved',$5,$6,now(),'agent','main','pending')`,
          status === "pending"
            ? [id, co, tool, JSON.stringify(args(tool)), bot, AGENT]
            : [id, co, tool, JSON.stringify(args(tool)), bot, admin],
        ),
      );
      return id;
    }
    const rowOf = async (id: string) =>
      (await adminPool().query<{ status: string; execution_status: string; execution_error: string | null }>(
        `SELECT status, execution_status, execution_error FROM automation_approvals WHERE id = $1`, [id],
      )).rows[0];

    it("🔴 a human APPROVES the agent's request for each barred tool: the row is approved but never becomes executable, and the executor skips it", async () => {
      const before = (await messageRows(generalA)).length;
      for (const tool of MEDIUM) {
        const a = await file(tool, "pending");
        const d = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${a}/decide`, headers: asUser(admin), payload: { decision: "approved" } });
        expect(d.statusCode, `${tool}: ${d.body}`).toBe(200);
        // Approved, and left at `not_applicable` FOREVER: no registry entry, so nothing was queued to run.
        expect(await rowOf(a), tool).toMatchObject({ status: "approved", execution_status: "not_applicable" });
        expect(await executeApprovedAutomationWrite(co, a), tool).toEqual({ status: "skipped", reason: "not_pending" });
      }
      expect(hubCalls).toBe(0);
      expect((await messageRows(generalA)).length).toBe(before);
    });

    it("🔴 even a row forced to `execution_status='pending'` FAILS CLOSED with not_executable, and the hub is never called", async () => {
      const before = (await messageRows(generalA)).length;
      for (const tool of MEDIUM) {
        const a = await file(tool, "approved");
        const out = await executeApprovedAutomationWrite(co, a);
        expect(out, tool).toMatchObject({ status: "failed" });
        expect((out as { error: string }).error, tool).toMatch(/^not_executable: no executable registry entry/);
        expect((await rowOf(a)).execution_status, tool).toBe("failed");
      }
      expect(hubCalls).toBe(0);
      expect((await messageRows(generalA)).length).toBe(before);
    });
  });
});
