// Server-side thread-title derivation + the sendMessage titling side-effect (2026-08-07 owner fix
// — see thread-title.ts's header for the full "why"). Two halves:
//   - `deriveServerThreadTitle` pure-function cases (no DB — always run, never skipped).
//   - the `sendMessage` integration behaviour (DB-gated, skips without DATABASE_URL_TEST/CERBOS_URL,
//     same idiom as assistant.test.ts): first message titles a null-titled thread, a manual rename
//     always wins, a second message never re-titles, and the ASST-22 page-context preamble is
//     stripped before deriving — never baked into the title.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";
import { deriveServerThreadTitle } from "./thread-title";

describe("deriveServerThreadTitle (pure)", () => {
  it("returns null for empty/whitespace-only input", () => {
    expect(deriveServerThreadTitle("")).toBeNull();
    expect(deriveServerThreadTitle("   \n\t  ")).toBeNull();
  });

  it("collapses internal whitespace (a pasted multi-line brief must not become a garbled title)", () => {
    expect(deriveServerThreadTitle("Please   review\n\nthe   Q3   budget")).toBe("Please review the Q3 budget");
  });

  it("returns short input untouched (no ellipsis under the 60-char cap)", () => {
    expect(deriveServerThreadTitle("Hi there")).toBe("Hi there");
  });

  it("breaks on a word boundary when that leaves a reasonable amount of text", () => {
    const long = "Please review the Q3 budget numbers before the board meeting tomorrow afternoon";
    const title = deriveServerThreadTitle(long);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(61); // <=60 chars + the ellipsis char
    expect(title!.endsWith("…")).toBe(true);
    expect(long.startsWith(title!.slice(0, -1))).toBe(true); // boundary text is a real prefix
    expect(title!.slice(0, -1).endsWith(" ")).toBe(false); // trimmed, no trailing space before …
  });

  it("hard-truncates at the char limit for a single long unbroken token (pasted URL/token)", () => {
    const url = "https://example.com/" + "a".repeat(80);
    const title = deriveServerThreadTitle(url);
    expect(title).toBe(url.slice(0, 60) + "…");
  });

  it("strips the ASST-22 page-context preamble before deriving", () => {
    const withPrefix = "[Context: Project Phoenix (project:abc-123)]\n\nWhat is the current status?";
    expect(deriveServerThreadTitle(withPrefix)).toBe("What is the current status?");
  });

  it("a preamble-only message (no real text after it) derives to null, not the boilerplate", () => {
    expect(deriveServerThreadTitle("[Context: Project Phoenix (project:abc-123)]\n\n")).toBeNull();
    expect(deriveServerThreadTitle("[Context: Project Phoenix (project:abc-123)]\n\n   ")).toBeNull();
  });
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("Assistant thread titling — sendMessage side-effect", () => {
  let app: NestFastifyApplication;
  let A: string;
  let owner: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("Assistant Titling Tenant", ["assistant"]);
    owner = await createUser("owner@asst-title.test");
    await addMembership(A, owner);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  async function createThread(payload: Record<string, unknown> = {}): Promise<string> {
    const created = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload,
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  async function getThreadTitle(threadId: string): Promise<string | null> {
    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    expect(got.statusCode).toBe(200);
    return (got.json() as { thread: { title: string | null } }).thread.title;
  }

  it("the FIRST message on a null-titled thread derives and persists a title, in the same transaction", async () => {
    const threadId = await createThread(); // no title supplied — starts null
    expect(await getThreadTitle(threadId)).toBeNull();

    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "Can you help me plan the Q4 launch checklist?" },
    });
    expect(sent.statusCode).toBe(201);

    expect(await getThreadTitle(threadId)).toBe("Can you help me plan the Q4 launch checklist?");
  });

  it("a manual title (set at create time) always wins — the first message never overwrites it", async () => {
    const threadId = await createThread({ title: "Hand-picked title" });
    expect(await getThreadTitle(threadId)).toBe("Hand-picked title");

    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "This text must never become the title." },
    });
    expect(sent.statusCode).toBe(201);

    expect(await getThreadTitle(threadId)).toBe("Hand-picked title");
  });

  it("a SECOND message never re-derives a title that the first message already set", async () => {
    const threadId = await createThread();
    const first = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "First message sets the title." },
    });
    expect(first.statusCode).toBe(201);
    expect(await getThreadTitle(threadId)).toBe("First message sets the title.");

    // finalize the pending assistant placeholder so a second send is not refused by the
    // "one in-flight generation per thread" precondition (assistant.controller.ts's own 409 guard)
    // — unrelated to titling, but required to reach the SECOND sendMessage call at all.
    await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/stop`, headers: asUser(owner),
    });

    const second = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "Second message must not change the title." },
    });
    expect(second.statusCode).toBe(201);
    expect(await getThreadTitle(threadId)).toBe("First message sets the title.");
  });

  it("titles from the RAW first message, never the ASST-22 page-context-prefixed variant", async () => {
    const threadId = await createThread();
    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "[Context: Project Phoenix (project:abc-123)]\n\nWhat is the current status?" },
    });
    expect(sent.statusCode).toBe(201);

    expect(await getThreadTitle(threadId)).toBe("What is the current status?");
  });

  it("a blank first message (whitespace only, after trim) leaves the thread untitled — refused as 400", async () => {
    const threadId = await createThread();
    const sent = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads/${threadId}/messages`, headers: asUser(owner),
      payload: { content: "   " },
    });
    // sendMessage itself refuses empty-after-trim content — titling code never even runs, and the
    // thread correctly stays untitled either way.
    expect(sent.statusCode).toBe(400);
    expect(await getThreadTitle(threadId)).toBeNull();
  });
});
