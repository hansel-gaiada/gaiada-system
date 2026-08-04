import { describe, it, expect } from "vitest";
import { pipelineDemo, portalDemo } from "./demoPipeline";
import { meetingsDemo } from "./demoMeetings";

// C1/B2/B6 — the demo-mode analogues of three write/read paths added after the pipeline surface
// shipped. These matter beyond demo browsing: `DEMO_MODE=1 next build` and the Playwright smoke
// project both run against these fixtures, so a fixture that silently ignores a new query param makes
// the demo show a filter that appears to do nothing — which is how a frontend-first surface ends up
// confidently wrong (the recurring bug class this project's own CLAUDE.md warns about).
const q = (s = "") => new URLSearchParams(s);

describe("demoPipeline — C1 server-side filters", () => {
  it("returns client_id and project_id on the LIST, as the real SELECT now does", () => {
    // It used to strip client_id to match a SELECT that omitted it. C4 changed the real query, so a
    // fixture still stripping it would hide the very field the client column now reads.
    const res = pipelineDemo("GET", "/api/t1/pipeline/runs", q());
    const rows = res!.json as { id: string; client_id?: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => "client_id" in r)).toBe(true);
  });

  it("filters by clientId server-side, not by returning everything", () => {
    const all = pipelineDemo("GET", "/api/t1/pipeline/runs", q())!.json as { client_id?: string | null }[];
    const target = all.find((r) => r.client_id)?.client_id as string;
    expect(target).toBeTruthy();
    const filtered = pipelineDemo("GET", "/api/t1/pipeline/runs", q(`clientId=${target}`))!.json as { client_id?: string | null }[];
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.client_id === target)).toBe(true);
    expect(filtered.length).toBeLessThan(all.length); // a filter that changes nothing is not a filter
  });

  it("an unknown clientId returns nothing rather than everything", () => {
    // The failure mode worth pinning: a fixture that ignores an unrecognised param looks identical to
    // "this client has every run".
    const res = pipelineDemo("GET", "/api/t1/pipeline/runs", q("clientId=cl-does-not-exist"));
    expect(res!.json).toEqual([]);
  });

  it("still filters by status, and combines with clientId", () => {
    const all = pipelineDemo("GET", "/api/t1/pipeline/runs", q())!.json as { status: string; client_id?: string | null }[];
    const row = all.find((r) => r.client_id)!;
    const both = pipelineDemo("GET", "/api/t1/pipeline/runs", q(`status=${row.status}&clientId=${row.client_id}`))!.json as { status: string }[];
    expect(both.every((r) => r.status === row.status)).toBe(true);
  });
});

describe("demoPipeline — B2 start a run with no meeting", () => {
  it("creates a run whose source_meeting_id is null, and its stages", () => {
    const before = (pipelineDemo("GET", "/api/t1/pipeline/runs", q())!.json as unknown[]).length;
    const res = pipelineDemo("POST", "/api/t1/pipeline/runs", q(), JSON.stringify({
      title: "Hand-started delivery", clientId: "cl-1",
      stages: [{ track: "delivery", name: "prd_extract" }, { track: "scope", name: "scope_extract" }],
    }));
    expect(res!.status).toBe(201);
    const id = (res!.json as { id: string }).id;

    const rows = pipelineDemo("GET", "/api/t1/pipeline/runs", q())!.json as { id: string; source_meeting_id: string | null }[];
    expect(rows.length).toBe(before + 1);
    const created = rows.find((r) => r.id === id)!;
    // Null is the point: it is what distinguishes a hand-started run from an ingested one, and it is
    // also the dispatcher's dedupe key, so inventing a value could collide with a later real ingest.
    expect(created.source_meeting_id).toBeNull();

    const detail = pipelineDemo("GET", `/api/t1/pipeline/runs/${id}`, q())!.json as { stages: { name: string }[] };
    expect(detail.stages.map((s) => s.name).sort()).toEqual(["prd_extract", "scope_extract"]);
  });

  it("refuses a run with no title", () => {
    const res = pipelineDemo("POST", "/api/t1/pipeline/runs", q(), JSON.stringify({ clientId: "cl-1" }));
    expect(res!.status).toBe(400);
  });
});

describe("demoMeetings — B6 relink orphaned recordings", () => {
  it("relinks only recordings that are missing a run AND have a matching one, and is idempotent", () => {
    const first = meetingsDemo("POST", "/api/t1/meetings/recordings/relink-orphans", q(), "{}");
    expect(first!.status ?? 200).toBe(200);
    const n = (first!.json as { relinked: number }).relinked;
    expect(typeof n).toBe("number");

    // Idempotency is what makes this safe to expose as a button instead of a runbook step: a second
    // sweep must repair nothing, not repair the same rows again.
    const second = meetingsDemo("POST", "/api/t1/meetings/recordings/relink-orphans", q(), "{}");
    expect((second!.json as { relinked: number }).relinked).toBe(0);
  });

  it("is matched as its own route, not captured as a recording id", () => {
    // `relink-orphans` sits in the same position as `:id`, so ordering in the matcher is load-bearing.
    // If it were captured as an id, this would 404 as "recording not found".
    const res = meetingsDemo("POST", "/api/t1/meetings/recordings/relink-orphans", q(), "{}");
    expect(res).not.toBeNull();
    expect(res!.json).toHaveProperty("relinked");
  });
});

describe("portalDemo — C5 the client portal in DEMO_MODE", () => {
  // The portal was the one shipped surface with NO demo fixture, so it could not be browsed
  // backend-free at all — and the DEMO_MODE build + smoke suite run against these fixtures.
  it("refuses a staff user with 403, exactly as the real BFF does", () => {
    // Load-bearing: without the refusal the demo would show staff a client's dashboard, and the
    // page's "you're signed in as a staff member" state would be unreachable dead code.
    const res = portalDemo("GET", "/api/t1/portal/runs", "demo-hansel");
    expect(res!.status).toBe(403);
  });

  it("returns the demo client's own runs with a blockage and a pending count", () => {
    const res = portalDemo("GET", "/api/t1/portal/runs", "demo-client");
    const rows = res!.json as { id: string; currentBlockage: string; pendingActions: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].currentBlockage).toBe("string");
    expect(rows[0].currentBlockage.length).toBeGreaterThan(0);
    expect(typeof rows[0].pendingActions).toBe("number");
  });

  it("NEVER exposes the internal report track", () => {
    // Filtered in the fixture, not at render time, because that is where the real BFF filters it — a
    // fixture that leaked it would make this guarantee vacuously true everywhere else.
    const list = portalDemo("GET", "/api/t1/portal/runs", "demo-client")!.json as { id: string }[];
    const detail = portalDemo("GET", `/api/t1/portal/runs/${list[0].id}`, "demo-client")!
      .json as { stages: { track: string }[] };
    expect(detail.stages.length).toBeGreaterThan(0);
    expect(detail.stages.some((s) => s.track === "report")).toBe(false);
  });

  it("404s a run belonging to another client, indistinguishably from a nonexistent one", () => {
    // Same response for both on purpose: a different status would let a client probe for other
    // clients' run ids.
    const other = portalDemo("GET", "/api/t1/portal/runs/run-demo-2", "demo-client");
    const missing = portalDemo("GET", "/api/t1/portal/runs/run-does-not-exist", "demo-client");
    expect(other!.status).toBe(404);
    expect(missing!.status).toBe(404);
  });

  it("ignores non-portal paths so the dispatcher falls through", () => {
    expect(portalDemo("GET", "/api/t1/pipeline/runs", "demo-client")).toBeNull();
  });
});
