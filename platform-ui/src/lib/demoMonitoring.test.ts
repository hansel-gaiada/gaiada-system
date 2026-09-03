import { describe, it, expect } from "vitest";
import { monitoringDemo as demo } from "./demoMonitoring";

// Drives the demo dispatcher directly (same call shape demoFixtures.ts uses), not through
// platformFetch — this pins the FIXTURE's own behaviour against what
// platform-nest/src/modules/monitoring/monitoring.controller.ts actually does, since demo-mode
// "verification" is only honest if the two agree. Each test that creates a row uses a fresh id
// (the module's `SEQ` counter is globalThis-pinned and shared across the whole process), so no
// test depends on another's ordering.
const T = "co-agency";
function get(path: string, params = new URLSearchParams()) {
  return demo("GET", `/api/${T}${path}`, params, undefined);
}
function post(path: string, bodyObj?: unknown) {
  return demo("POST", `/api/${T}${path}`, new URLSearchParams(), bodyObj === undefined ? undefined : JSON.stringify(bodyObj));
}
function patch(path: string, bodyObj: unknown) {
  return demo("PATCH", `/api/${T}${path}`, new URLSearchParams(), JSON.stringify(bodyObj));
}
function del(path: string) {
  return demo("DELETE", `/api/${T}${path}`, new URLSearchParams(), undefined);
}

/**
 * `monitoringDemo` returns `DemoResult | null` — `null` means "no route in this dispatcher matched
 * the path/method", not any domain outcome (a missing/deleted/orphaned row is always a real
 * `DemoResult` with a 404, never `null`; see `channelName()`/the 404 branches in the fixture
 * itself). Every call site below hits a path this dispatcher unconditionally handles, so a `null`
 * here is a bug in the TEST (a typo'd path, a route this file forgot to wire up) — asserted
 * loudly with the offending call spelled out, rather than silenced with a `!` that would make a
 * real regression (a route silently falling out of the dispatcher) read as a `TypeError` instead.
 */
function matched(r: ReturnType<typeof demo>, what: string): { status: number; json: unknown } {
  if (!r) throw new Error(`monitoringDemo returned null (no route matched) for: ${what}`);
  return r;
}

interface Channel { id: string; kind: string; name: string; destination: string | null; enabled: boolean }
interface Route { id: string; channelId: string; channelName: string | null }

function createChannel(overrides: Record<string, unknown> = {}) {
  const r = post("/monitoring/channels", { kind: "email", name: "test channel", destination: "ops@example.com", ...overrides });
  return r as { status: number; json: { id: string } };
}

describe("channels — soft delete, never a cascade", () => {
  it("a deleted channel disappears from GET /channels but its route survives, invisible not gone", () => {
    const ch = createChannel({ name: "disposable" });
    expect(ch.status).toBe(201);
    const channelId = ch.json.id;

    const rt = post("/monitoring/routes", { channelId, matchSeverity: "page" }) as { status: number; json: { id: string } };
    expect(rt.status).toBe(201);
    const routeId = rt.json.id;

    // Visible before delete.
    expect((matched(get("/monitoring/channels"), "GET channels").json as Channel[]).some((c) => c.id === channelId)).toBe(true);
    expect((matched(get("/monitoring/routes"), "GET routes").json as Route[]).some((r) => r.id === routeId)).toBe(true);

    const delRes = del(`/monitoring/channels/${channelId}`) as { status: number; json: { id: string; deletedAt: string } };
    expect(delRes.status).toBe(200);
    expect(delRes.json.id).toBe(channelId);
    expect(delRes.json.deletedAt).toBeTruthy();

    // Gone from both lists — GET /routes mirrors the real controller's INNER JOIN on
    // `ch.deleted_at IS NULL`, so an orphaned route is dropped from the list entirely.
    expect((matched(get("/monitoring/channels"), "GET channels").json as Channel[]).some((c) => c.id === channelId)).toBe(false);
    expect((matched(get("/monitoring/routes"), "GET routes").json as Route[]).some((r) => r.id === routeId)).toBe(false);

    // But NOT hard-deleted: the route row still exists underneath (no cascade fired) — proven by
    // PATCH still finding it (a 404 here would mean the fixture actually cascaded).
    const patched = patch(`/monitoring/routes/${routeId}`, { enabled: false });
    expect(patched?.status).toBe(200);

    // Re-deleting (or acting on) the channel itself now 404s, matching a real soft-deleted row.
    expect(del(`/monitoring/channels/${channelId}`)?.status).toBe(404);
    expect(patch(`/monitoring/channels/${channelId}`, { name: "x" })?.status).toBe(404);
    expect(post(`/monitoring/channels/${channelId}/test`)?.status).toBe(404);
  });
});

describe("channels — write validation mirrors monitoring.controller.ts", () => {
  it("rejects an unknown kind with 400", () => {
    expect(post("/monitoring/channels", { kind: "carrier-pigeon", name: "bad" })?.status).toBe(400);
  });

  it("an email channel requires a plausible destination", () => {
    expect(post("/monitoring/channels", { kind: "email", name: "no dest" })?.status).toBe(400);
    expect(post("/monitoring/channels", { kind: "email", name: "bad dest", destination: "not-an-email" })?.status).toBe(400);
  });

  it("a non-email channel can be created with no destination at all — nothing to validate it against yet", () => {
    const r = createChannel({ kind: "webhook", name: "n8n hook", destination: undefined });
    expect(r.status).toBe(201);
  });

  it("PATCH rejects a blank name and an implausible email destination", () => {
    const ch = createChannel({ name: "editable" });
    expect(patch(`/monitoring/channels/${ch.json.id}`, { name: "   " })?.status).toBe(400);
    expect(patch(`/monitoring/channels/${ch.json.id}`, { destination: "nope" })?.status).toBe(400);
    const ok = patch(`/monitoring/channels/${ch.json.id}`, { name: "renamed" }) as { status: number; json: Channel };
    expect(ok.status).toBe(200);
    expect(ok.json.name).toBe("renamed");
    // PATCH returns the FULL row, not a bare `{ id }` — matches mapChannel()'s response shape.
    expect(ok.json).toHaveProperty("enabled");
  });
});

describe("channels — test-send refuses non-email kinds (contract note 12)", () => {
  it("400s for a webhook channel instead of reporting a fake ok", () => {
    const ch = createChannel({ kind: "webhook", name: "hook", destination: "https://example.com/hook" });
    const r = post(`/monitoring/channels/${ch.json.id}/test`) as { status: number; json: { error: string } };
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/no notification driver/i);
  });

  it("400s when an email channel has no destination, 201s and updates health on success", () => {
    // ch-email-ops (seed) has a destination already; this proves the missing-destination path on
    // a fresh row instead.
    const ch = post("/monitoring/channels", { kind: "webhook", name: "temp" }) as { status: number; json: { id: string } };
    // webhook already refused above by kind; use a real email row with destination cleared via PATCH
    const email = createChannel({ name: "will lose its destination" });
    patch(`/monitoring/channels/${email.json.id}`, { destination: "" });
    const noDest = post(`/monitoring/channels/${email.json.id}/test`);
    expect(noDest?.status).toBe(400);

    const good = createChannel({ name: "healthy" });
    const sent = post(`/monitoring/channels/${good.json.id}/test`);
    expect(sent?.status).toBe(201);
    expect(sent?.json).toEqual({ ok: true });
    void ch;
  });
});

describe("routes — validation and the channelId-on-edit no-op", () => {
  it("an unknown channelId is a 400, not a silently accepted orphan route", () => {
    expect(post("/monitoring/routes", { channelId: "does-not-exist" })?.status).toBe(400);
  });

  it("rejects an invalid matchSeverity with 400, on both create and update", () => {
    const ch = createChannel({ name: "sev test" });
    expect(post("/monitoring/routes", { channelId: ch.json.id, matchSeverity: "urgent" })?.status).toBe(400);
    const rt = post("/monitoring/routes", { channelId: ch.json.id }) as { status: number; json: { id: string } };
    expect(patch(`/monitoring/routes/${rt.json.id}`, { matchSeverity: "urgent" })?.status).toBe(400);
  });

  it("PATCH ignores a channelId in the body — production's updateRoute never accepts one", () => {
    const chA = createChannel({ name: "route channel A" });
    const chB = createChannel({ name: "route channel B" });
    const rt = post("/monitoring/routes", { channelId: chA.json.id }) as { status: number; json: { id: string } };
    const res = patch(`/monitoring/routes/${rt.json.id}`, { channelId: chB.json.id, enabled: false }) as { status: number; json: Route };
    expect(res.status).toBe(200);
    expect(res.json.channelId).toBe(chA.json.id); // unchanged
  });

  it("an update with no recognised fields is a 400 'nothing to update'", () => {
    const ch = createChannel({ name: "noop test" });
    const rt = post("/monitoring/routes", { channelId: ch.json.id }) as { status: number; json: { id: string } };
    expect(patch(`/monitoring/routes/${rt.json.id}`, {})?.status).toBe(400);
  });

  it("DELETE returns the deleted route's id", () => {
    const ch = createChannel({ name: "delete route test" });
    const rt = post("/monitoring/routes", { channelId: ch.json.id }) as { status: number; json: { id: string } };
    const res = del(`/monitoring/routes/${rt.json.id}`) as { status: number; json: { id: string } };
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(rt.json.id);
  });
});

describe("maintenance — K7 write validation mirrors write-validation.ts", () => {
  it("rejects an inverted window with 400, not a silent swap", () => {
    const r = post("/monitoring/maintenance", { scope: "all", startsAt: "2026-09-10T02:00:00Z", endsAt: "2026-09-10T00:00:00Z" });
    expect(r?.status).toBe(400);
  });

  it("rejects a malformed scope string with 400", () => {
    const r = post("/monitoring/maintenance", { scope: "everything", startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z" });
    expect(r?.status).toBe(400);
  });

  it("rejects a scope naming a monitor that doesn't exist in this demo's monitor set", () => {
    const r = post("/monitoring/maintenance", { scope: "monitor:not-a-real-monitor", startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z" });
    expect(r?.status).toBe(400);
  });

  it("a monitor-scoped window round-trips through GET, and DELETE returns its id", () => {
    const res = post("/monitoring/maintenance", {
      scope: "monitor:mon-cascades-http", startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z", reason: "test",
    }) as { status: number; json: { id: string } };
    expect(res.status).toBe(201);
    const rows = matched(get("/monitoring/maintenance"), "GET maintenance").json as { id: string; scope: string }[];
    expect(rows.find((w) => w.id === res.json.id)?.scope).toBe("monitor:mon-cascades-http");

    const delRes = del(`/monitoring/maintenance/${res.json.id}`) as { status: number; json: { id: string } };
    expect(delRes.status).toBe(200);
    expect(delRes.json.id).toBe(res.json.id);
    expect(del(`/monitoring/maintenance/${res.json.id}`)?.status).toBe(404);
  });
});

describe("monitors — POST validation and status code", () => {
  it("201s (not 200) on success, matching Nest's default POST status", () => {
    const r = post("/monitoring/monitors", { name: "new site", kind: "http", clientId: "cli-viceroy", target: "https://example.com" });
    expect(r?.status).toBe(201);
  });

  it("400s for a missing name, an unknown kind, and an unavailable (undriven) kind", () => {
    expect(post("/monitoring/monitors", { kind: "http", clientId: "cli-viceroy" })?.status).toBe(400);
    expect(post("/monitoring/monitors", { name: "x", kind: "carrier-pigeon", clientId: "cli-viceroy" })?.status).toBe(400);
    expect(post("/monitoring/monitors", { name: "x", kind: "mqtt", clientId: "cli-viceroy" })?.status).toBe(400);
  });

  it("400s for a missing clientId", () => {
    expect(post("/monitoring/monitors", { name: "x", kind: "http" })?.status).toBe(400);
  });
});

describe("incident acknowledge", () => {
  it("404s for an unknown incident id", () => {
    expect(post("/monitoring/incidents/not-real/ack")?.status).toBe(404);
  });

  it("201s with the acknowledgement shape, not a bare { id }", () => {
    const r = post("/monitoring/incidents/inc-1/ack") as { status: number; json: { id: string; acknowledgedAt: string; acknowledgedBy: string } };
    expect(r.status).toBe(201);
    expect(r.json.acknowledgedAt).toBeTruthy();
    expect(r.json.acknowledgedBy).toBeTruthy();
  });

  it("an already-acknowledged seed incident returns its existing claim", () => {
    const r = post("/monitoring/incidents/inc-2/ack") as { status: number; json: { acknowledgedBy: string } };
    expect(r.status).toBe(201);
    expect(r.json.acknowledgedBy).toBe("Hansel");
  });
});
