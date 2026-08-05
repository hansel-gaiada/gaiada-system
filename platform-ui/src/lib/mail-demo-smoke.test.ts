import { describe, it, expect } from "vitest";
import { getDemoResponse } from "./demoFixtures";

// MAIL-15 — proves DEMO_MODE serves the mail-surface routes end-to-end with no backend at all
// (list, detail, admin thread, entity-scoped thread, portal thread), and that the portal variant
// still refuses a staff caller exactly like the real portal-scope predicate would.
describe("mail demo smoke", () => {
  it("lists, details, and threads with no backend", () => {
    const list = getDemoResponse("GET", "/api/admin/mail/log", "demo-hansel");
    expect(list.status).toBe(200);
    expect((list.json as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    const detail = getDemoResponse("GET", "/api/admin/mail/log/demo-mail-2", "demo-hansel");
    expect(detail.status).toBe(200);

    const thread = getDemoResponse("GET", "/api/admin/mail/log/demo-mail-2/thread", "demo-hansel");
    expect(thread.status).toBe(200);
    expect((thread.json as { messages: unknown[] }).messages.length).toBeGreaterThan(0);

    const entityThread = getDemoResponse(
      "GET",
      "/api/co-agency/mail/threads?entityType=pipeline_run&entityId=run-demo-1",
      "demo-hansel",
    );
    expect(entityThread.status).toBe(200);
    expect((entityThread.json as { messages: unknown[] }).messages.length).toBeGreaterThan(0);

    // Portal variant is client-only — the demo portal wrapper 403s any staff caller before this
    // route is ever reached, mirroring the real BFF's portal-scope predicate. Call as the demo
    // client (owner of run-demo-1 in the fixtures) to reach the actual handler.
    const portalThread = getDemoResponse(
      "GET",
      "/api/co-agency/portal/mail/threads?runId=run-demo-1",
      "demo-client",
    );
    expect(portalThread.status).toBe(200);
    expect((portalThread.json as { messages: unknown[] }).messages.length).toBeGreaterThan(0);

    const portalThreadAsStaff = getDemoResponse(
      "GET",
      "/api/co-agency/portal/mail/threads?runId=run-demo-1",
      "demo-hansel",
    );
    expect(portalThreadAsStaff.status).toBe(403);

    const missing = getDemoResponse("GET", "/api/admin/mail/log/nope", "demo-hansel");
    expect(missing.status).toBe(404);
  });
});
