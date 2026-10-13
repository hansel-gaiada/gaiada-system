import { describe, it, expect } from "vitest";
import { portalDashboardDemo } from "./demoPortal";

// PV4-08 — the demo store's fidelity for Conversation and meeting notes. DEMO_MODE is what the axe sweep and the portal
// specs run against, so the fixture must refuse and limit the way the BFF does (§29): body 1..10,000, 5 files, 10 MB,
// messages are permanent (PV-D34: no edit, no retract route), closed threads refuse posts, a thread outside scope is a 404.
const T = (p: string) => `/api/co-agency/portal/${p}`;
const CLIENT = "demo-client";
const call = (m: string, p: string, body?: unknown, user = CLIENT) => portalDashboardDemo(m, T(p), user, body === undefined ? undefined : JSON.stringify(body));

describe("demo conversation", () => {
  it("refuses a staff caller", () => {
    expect(call("GET", "conversation", undefined, "demo-hansel")?.status).toBe(403);
    expect(call("GET", "meetings", undefined, "demo-hansel")?.status).toBe(403);
  });

  it("lists threads with unread counts, General included, and the overview carries conversationUnread", () => {
    const r = call("GET", "conversation")!.json as { threads: Array<{ id: string; general: boolean; unreadCount: number }>; canUseGeneral: boolean };
    expect(r.canUseGeneral).toBe(true);
    expect(r.threads.some((t) => t.general)).toBe(true);
    expect(r.threads.find((t) => t.id === "th-site")!.unreadCount).toBeGreaterThanOrEqual(0);
    const o = call("GET", "overview")!.json as { conversationUnread: number };
    expect(typeof o.conversationUnread).toBe("number");
  });

  it("opening a thread marks it read and returns messages oldest first, with no edit/retract fields on the wire", () => {
    const r = call("GET", "conversation/th-site")!.json as { messages: Array<Record<string, unknown> & { createdAt: string }> };
    const times = r.messages.map((m) => m.createdAt);
    expect([...times].sort()).toEqual(times);
    for (const m of r.messages) for (const k of ["edited", "editedAt", "retracted", "editableUntil"]) expect(m).not.toHaveProperty(k);
    const list = call("GET", "conversation")!.json as { threads: Array<{ id: string; unreadCount: number }> };
    expect(list.threads.find((t) => t.id === "th-site")!.unreadCount).toBe(0);
  });

  it("a new message is mine and permanent: PATCH and DELETE are 404 for anyone, and the message is unchanged", () => {
    const posted = call("POST", "conversation/th-general/messages", { body: "hello" })!;
    expect(posted.status).toBe(201);
    const id = (posted.json as { id: string }).id;
    const find = () => (call("GET", "conversation/th-general")!.json as { messages: Array<Record<string, unknown>> }).messages.find((m) => m.id === id)!;
    expect(find()).toMatchObject({ mine: true, body: "hello" });
    expect(call("PATCH", `conversation/messages/${id}`, { body: "hello again" })!.status).toBe(404);
    expect(call("DELETE", `conversation/messages/${id}`)!.status).toBe(404);
    expect(call("PATCH", "conversation/messages/msg-s2", { body: "x" })!.status).toBe(404);
    expect(find()).toMatchObject({ mine: true, body: "hello" });
  });

  it("no seeded message is retracted: every message has its body", () => {
    for (const t of ["th-general", "th-site", "th-brand"]) {
      const r = call("GET", `conversation/${t}`)!.json as { messages: Array<{ body: unknown }> };
      expect(r.messages.length).toBeGreaterThan(0);
      for (const m of r.messages) expect(typeof m.body).toBe("string");
    }
  });

  it("a closed thread refuses a post with 409", () => {
    expect(call("POST", "conversation/th-brand/messages", { body: "hi" })!.status).toBe(409);
  });

  it("enforces the body and attachment limits", () => {
    expect(call("POST", "conversation/th-site/messages", { body: "   " })!.status).toBe(400);
    expect(call("POST", "conversation/th-site/messages", { body: "x".repeat(10_001) })!.status).toBe(400);
    const file = { filename: "a.txt", contentType: "text/plain", content: "QQ==" };
    expect(call("POST", "conversation/th-site/messages", { body: "x", attachments: Array(6).fill(file) })!.status).toBe(400);
    const big = { filename: "b.bin", contentType: "application/octet-stream", content: "A".repeat(Math.ceil((10 * 1024 * 1024 + 4) * 4 / 3)) };
    expect(call("POST", "conversation/th-site/messages", { body: "x", attachments: [big] })!.status).toBe(400);
  });

  it("starts a thread on a project; an unknown project is a 404", () => {
    const r = call("POST", "conversation", { projectId: "proj-nw-site", subject: "New topic", body: "Hi" })!;
    expect(r.status).toBe(201);
    expect(call("POST", "conversation", { projectId: "nope", body: "Hi" })!.status).toBe(404);
  });

  it("an unknown thread is a 404", () => {
    expect(call("GET", "conversation/th-nope")!.status).toBe(404);
  });
});

describe("demo meeting notes and amendments", () => {
  it("lists shared minutes for a project and reads one, with exactly the contract's keys", () => {
    const list = call("GET", "meetings?projectId=proj-nw-site")!.json as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(Object.keys(list[0]).sort()).toEqual(["bodyMd", "id", "meetingDate", "sharedAt", "sharedBy", "title"]);
    expect(call("GET", "meetings?projectId=proj-nw-brand")!.json).toEqual([]);
    expect(call("GET", `meetings/${String(list[0].id)}`)!.status).toBe(200);
    expect(call("GET", "meetings/nope")!.status).toBe(404);
  });

  it("an amendment carries kind, amendsReference and changeRequestId on the list and the detail", () => {
    const list = call("GET", "contracts")!.json as Array<{ id: string; kind: string; amendsReference: string | null; changeRequestId: string | null }>;
    const a = list.find((k) => k.kind === "amendment")!;
    expect(a).toMatchObject({ amendsReference: "GDA-2026-004", changeRequestId: "wcr-seed-1" });
    const d = call("GET", `contracts/${a.id}`)!.json as { kind: string; amendsId: string };
    expect(d).toMatchObject({ kind: "amendment", amendsId: "ctr-msa-2026" });
    expect(list.filter((k) => k.kind === "agreement").every((k) => k.amendsReference === null)).toBe(true);
  });
});
