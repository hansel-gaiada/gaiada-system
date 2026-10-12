import { describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";

// PV4-09 — the demo twin of the staff conversation + minutes routes: the e2e hub specs run against it, so its rules
// (awaiting reply, drafts staff-only, send authored by the CALLER, minutes freeze) have to match the BFF contract.
const U = "demo-hansel";
const T = "co-agency";
const call = (method: string, path: string, body?: unknown) =>
  getDemoResponse(method, `/api/${T}${path}`, U, body === undefined ? undefined : JSON.stringify(body));
type J = Record<string, any>;

describe("demo conversation", () => {
  it("lists a client's threads with awaitingReply and pendingDrafts, and every row carries clientVisible", () => {
    const r = call("GET", "/conversation?clientId=cl-1");
    expect(r.status).toBe(200);
    const threads = (r.json as { threads: J[] }).threads;
    const t1 = threads.find((t) => t.id === "cv-thread-1")!;
    expect(t1).toMatchObject({ awaitingReply: true, pendingDrafts: 1, clientVisible: true, general: false });
    expect(threads.find((t) => t.id === "cv-thread-2")).toMatchObject({ awaitingReply: false, general: true });
  });

  it("drafts are clientVisible:false and the overview lists the waiting thread, from the same store", () => {
    const d = (call("GET", "/conversation/cv-thread-1/drafts").json as { drafts: J[] }).drafts;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "pending", clientVisible: false, draftedByName: "Atlas" });
    const o = call("GET", "/clients/cl-1/overview").json as J;
    expect(o.conversationsAwaitingReply).toBeGreaterThanOrEqual(1);
    expect(o.needsUs.find((i: J) => i.kind === "conversation")).toMatchObject({ id: "cv-thread-1", href: "/clients/cl-1/work/conversation/cv-thread-1" });
  });

  it("sending a draft authors the message as the CALLER with draftedBy = the agent, and clears awaiting", () => {
    const r = call("POST", "/conversation/drafts/cv-draft-1/send");
    expect(r.status).toBe(201);
    const id = (r.json as J).id as string;
    const detail = call("GET", "/conversation/cv-thread-1").json as { thread: J; messages: J[] };
    const sent = detail.messages.find((m) => m.id === id)!;
    expect(sent).toMatchObject({ authorId: U, authorName: "Clement Hansel", authorSide: "staff", draftedBy: "agent-atlas", mine: true });
    expect(detail.thread.awaitingReply).toBe(false);
    const all = (call("GET", "/conversation/cv-thread-1/drafts?status=all").json as { drafts: J[] }).drafts;
    expect(all[0]).toMatchObject({ status: "sent", sentMessageId: id });
    // a second send is refused
    expect(call("POST", "/conversation/drafts/cv-draft-1/send").status).toBe(409);
  });

  it("a closed thread refuses a post with 409", () => {
    expect(call("PATCH", "/conversation/cv-thread-2", { status: "closed" }).status).toBe(200);
    expect(call("POST", "/conversation/cv-thread-2/messages", { body: "hi" }).status).toBe(409);
    expect(call("PATCH", "/conversation/cv-thread-2", { status: "open" }).status).toBe(200);
    expect(call("POST", "/conversation/cv-thread-2/messages", { body: "hi" }).status).toBe(201);
  });
});

describe("demo meeting minutes", () => {
  it("saves as a draft, shares once, then freezes (PUT -> 409)", () => {
    expect(call("GET", "/meetings/rec-demo-1/minutes").json).toMatchObject({ clientId: "cl-1", minutes: null });
    const saved = call("PUT", "/meetings/rec-demo-1/minutes", { bodyMd: "Decisions: ship Friday." }).json as J;
    expect(saved.minutes).toMatchObject({ status: "draft", clientVisible: false });
    const shared = call("POST", "/meetings/rec-demo-1/minutes/share");
    expect(shared.status).toBe(200);
    const after = call("GET", "/meetings/rec-demo-1/minutes").json as J;
    expect(after.minutes).toMatchObject({ status: "shared", sharedByName: "Clement Hansel", clientVisible: true });
    expect(call("PUT", "/meetings/rec-demo-1/minutes", { bodyMd: "late" }).status).toBe(409);
    expect(call("POST", "/meetings/rec-demo-1/minutes/share").status).toBe(409);
  });

  it("a meeting with no client cannot be shared", () => {
    call("PUT", "/meetings/rec-demo-4/minutes", { bodyMd: "internal notes" });
    expect(call("POST", "/meetings/rec-demo-4/minutes/share").status).toBe(409);
  });
});
