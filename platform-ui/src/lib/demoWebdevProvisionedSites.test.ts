import { describe, it, expect } from "vitest";
import { webdevProvisionedSitesDemo as demo } from "./demoWebdevProvisionedSites";

// Drives the demo dispatcher directly (same call shape demoFixtures.ts uses), not through
// platformFetch — this file tests the fixture's OWN state machine, which is the thing that has to
// cover "every status including both failure shapes" per the PRV-04 brief. Each test uses its own
// runId/slug so the module-level (globalThis-pinned) store never lets one test's row leak into
// another's assertions.
function get(path: string, params: URLSearchParams = new URLSearchParams()) {
  return demo("GET", path, params, undefined, "demo-hansel");
}
function post(path: string, body: unknown) {
  return demo("POST", path, new URLSearchParams(), JSON.stringify(body), "demo-hansel");
}

const LIST = "/api/co-agency/modules/webdev/provisioned-sites";
const PROVISION = "/api/co-agency/modules/webdev/provision";
const reconcile = (id: string) => `/api/co-agency/modules/webdev/provisioned-sites/${id}/reconcile`;

describe("seeded rows — run-demo-1 / run-demo-2", () => {
  it("run-demo-1 has a 2-row history: an older slug_conflict_foreign, then the live retry, newest first", () => {
    const r = get(LIST, new URLSearchParams({ runId: "run-demo-1" }));
    expect(r?.status).toBe(200);
    const rows = r!.json as Array<{ status: string; failureReason: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("live");
    expect(rows[1]).toEqual(expect.objectContaining({ status: "failed", failureReason: "slug_conflict_foreign" }));
  });

  it("run-demo-2 starts with zero rows — the true empty state", () => {
    const r = get(LIST, new URLSearchParams({ runId: "run-demo-2" }));
    expect(r?.status).toBe(200);
    expect(r!.json).toEqual([]);
  });
});

describe("POST .../provision — request-time refusals", () => {
  it("an invalid slug is a 400 invalid_slug, no row created", () => {
    const runId = "run-test-invalid";
    const r = post(PROVISION, { runId, slug: "Not Valid!" });
    expect(r).toEqual({ status: 400, json: { error: "invalid_slug" } });
    expect((get(LIST, new URLSearchParams({ runId }))!.json as unknown[])).toHaveLength(0);
  });

  it("a slug containing 'taken' is a 409 slug_taken and creates NO row", () => {
    const runId = "run-test-taken";
    const r = post(PROVISION, { runId, slug: "already-taken-name" });
    expect(r).toEqual({ status: 409, json: { error: "slug_taken" } });
    expect((get(LIST, new URLSearchParams({ runId }))!.json as unknown[])).toHaveLength(0);
  });

  it("a slug containing 'conflict' is a 409 slug_conflict_foreign, but the row IS committed failed", () => {
    const runId = "run-test-conflict";
    const r = post(PROVISION, { runId, slug: "someone-elses-conflict-name" });
    expect(r).toEqual({ status: 409, json: { error: "slug_conflict_foreign" } });
    const rows = get(LIST, new URLSearchParams({ runId }))!.json as Array<{ status: string; failureReason: string | null }>;
    expect(rows).toEqual([expect.objectContaining({ status: "failed", failureReason: "slug_conflict_foreign" })]);
  });

  it("a second provision call for a run with an active (non-failed) row returns 200 existing, not a new row", () => {
    const runId = "run-test-idempotent";
    const first = post(PROVISION, { runId, slug: "idempotent-demo-site" });
    expect(first?.status).toBe(201);
    const firstId = (first!.json as { id: string }).id;
    const second = post(PROVISION, { runId, slug: "a-different-slug-would-be-ignored" });
    expect(second?.status).toBe(200);
    expect((second!.json as { id: string }).id).toBe(firstId);
    expect((get(LIST, new URLSearchParams({ runId }))!.json as unknown[])).toHaveLength(1);
  });
});

describe("POST .../provision + reconcile — the normal ladder", () => {
  it("egresses to pending, then each reconcile advances one step to provisioned, then live", () => {
    const runId = "run-test-ladder";
    const created = post(PROVISION, { runId, slug: "ladder-demo-site" });
    expect(created?.status).toBe(201);
    const site = created!.json as { id: string; status: string; repoUrl: string | null; stagingUrl: string | null };
    expect(site.status).toBe("pending");

    const afterFirst = post(reconcile(site.id), {});
    const step1 = afterFirst!.json as { status: string; repoUrl: string | null };
    expect(step1.status).toBe("provisioned");
    expect(step1.repoUrl).toContain("github.com/gaiadabali/ladder-demo-site");

    const step2 = (post(reconcile(site.id), {})!.json) as { status: string; stagingUrl: string | null };
    expect(step2.status).toBe("live");
    expect(step2.stagingUrl).toContain("ladder-demo-site.gaiada.online");
  });
});

describe("the poll_timeout shape — 'honest, not final'", () => {
  it("first reconcile lands failed/poll_timeout; the SECOND flips it forward to live", () => {
    const runId = "run-test-timeout";
    const created = post(PROVISION, { runId, slug: "timeout-demo-site" });
    const site = created!.json as { id: string; status: string };
    expect(site.status).toBe("pending");

    const afterFirst = post(reconcile(site.id), {})!.json as { status: string; failureReason: string | null };
    expect(afterFirst).toEqual(expect.objectContaining({ status: "failed", failureReason: "poll_timeout" }));

    const afterSecond = post(reconcile(site.id), {})!.json as { status: string; failureReason: string | null };
    expect(afterSecond.status).toBe("live");
    expect(afterSecond.failureReason).toBeNull();
  });
});

describe("the crash-resume shape — a row that never egressed", () => {
  it("stays 'requested' until the first reconcile resumes it into 'pending'", () => {
    const runId = "run-test-crash";
    const created = post(PROVISION, { runId, slug: "crash-demo-site" });
    const site = created!.json as { id: string; status: string; providerRef: string | null };
    expect(site.status).toBe("requested");
    expect(site.providerRef).toBeNull();

    const resumed = post(reconcile(site.id), {})!.json as { status: string; providerRef: string | null };
    expect(resumed.status).toBe("pending");
    expect(resumed.providerRef).not.toBeNull();
  });
});

describe("reconcile on an unknown id", () => {
  it("404s", () => {
    expect(post(reconcile("no-such-site"), {})).toEqual({ status: 404, json: { error: "provisioned site not found" } });
  });
});
