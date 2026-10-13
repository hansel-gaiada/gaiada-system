import { describe, it, expect } from "vitest";
import {
  attachmentProblem, CONVERSATION_MAX_BYTES, groupThreads, linkifyText, threadTitle,
  type PortalThread,
} from "./portal";

// PV4-08 — the pure rules behind the Conversation screens (FRONTEND-BFF-CONTRACT §29).

const t = (over: Partial<PortalThread>): PortalThread => ({
  id: "t", clientId: "c1", clientName: "Northwind", projectId: "p1", projectName: "Website relaunch", general: false,
  subject: null, status: "open", createdSide: "client", lastMessageAt: "2026-10-10T10:00:00Z", createdAt: "2026-10-01T10:00:00Z",
  unreadCount: 0, ...over,
});

describe("groupThreads", () => {
  const threads = [
    t({ id: "g", general: true, projectId: null, projectName: null, subject: null, lastMessageAt: "2026-10-01T00:00:00Z" }),
    t({ id: "a1", projectId: "p1", projectName: "Website relaunch", lastMessageAt: "2026-10-12T00:00:00Z", unreadCount: 2 }),
    t({ id: "a2", projectId: "p1", projectName: "Website relaunch", lastMessageAt: "2026-10-11T00:00:00Z" }),
    t({ id: "b1", projectId: "p2", projectName: "Brand refresh", lastMessageAt: "2026-10-13T00:00:00Z" }),
  ];

  it("groups threads by project, most recently active project first, newest thread first inside it", () => {
    const { projects } = groupThreads(threads, true);
    expect(projects.map((g) => g.title)).toEqual(["Brand refresh", "Website relaunch"]);
    expect(projects[1].threads.map((x) => x.id)).toEqual(["a1", "a2"]);
  });

  it("pins the client-wide thread as General when the caller canUseGeneral", () => {
    const { general, projects } = groupThreads(threads, true);
    expect(general.map((x) => x.id)).toEqual(["g"]);
    expect(projects.flatMap((p) => p.threads).map((x) => x.id)).not.toContain("g");
  });

  it("shows NO General for a caller who may not use it, even if a client-wide row arrives (PV4-Q1)", () => {
    const { general, projects } = groupThreads(threads, false);
    expect(general).toEqual([]);
    expect(projects.flatMap((p) => p.threads).map((x) => x.id)).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps one General per client for a contact of several clients", () => {
    const two = [
      t({ id: "g1", general: true, projectId: null, projectName: null, clientId: "c1", clientName: "Northwind" }),
      t({ id: "g2", general: true, projectId: null, projectName: null, clientId: "c2", clientName: "Contoso" }),
    ];
    expect(groupThreads(two, true).general).toHaveLength(2);
  });
});

describe("threadTitle", () => {
  it("prefers the subject, then General (named by client when there are several), then the project", () => {
    expect(threadTitle(t({ subject: "Logo question" }))).toBe("Logo question");
    expect(threadTitle(t({ general: true, projectId: null, projectName: null }))).toBe("General");
    expect(threadTitle(t({ general: true, projectId: null, projectName: null, clientName: "Contoso" }), true)).toBe("General: Contoso");
    expect(threadTitle(t({}))).toBe("Website relaunch");
  });
});

describe("attachmentProblem (client-side, before sending)", () => {
  const f = (name: string, size: number) => ({ name, size });
  it("accepts up to 5 files totalling 10 MB", () => {
    expect(attachmentProblem([])).toBeNull();
    expect(attachmentProblem(Array.from({ length: 5 }, (_, i) => f(`a${i}`, 1000)))).toBeNull();
    expect(attachmentProblem([f("big", CONVERSATION_MAX_BYTES)])).toBeNull();
  });
  it("refuses a 6th file in plain words", () => {
    expect(attachmentProblem(Array.from({ length: 6 }, (_, i) => f(`a${i}`, 10)))).toMatch(/up to 5 files/i);
  });
  it("refuses more than 10 MB in total, however many files", () => {
    expect(attachmentProblem([f("a", CONVERSATION_MAX_BYTES), f("b", 1)])).toMatch(/10 MB in total/i);
  });
  it("refuses an empty file by name", () => {
    expect(attachmentProblem([f("notes.txt", 0)])).toMatch(/notes\.txt is empty/);
  });
});

describe("linkifyText", () => {
  it("makes http(s) URLs links and leaves everything else as text, trailing punctuation outside", () => {
    expect(linkifyText("See https://example.com/a?b=1, then reply.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { kind: "text", text: ", then reply." },
    ]);
  });
  it("never links a non-http scheme", () => {
    expect(linkifyText("javascript:alert(1) and ftp://x.test")).toEqual([{ kind: "text", text: "javascript:alert(1) and ftp://x.test" }]);
  });
  it("returns markup-looking text as plain text parts", () => {
    const parts = linkifyText('<img src=x onerror="alert(1)">');
    expect(parts).toEqual([{ kind: "text", text: '<img src=x onerror="alert(1)">' }]);
  });
});
