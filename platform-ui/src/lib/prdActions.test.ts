import { describe, it, expect, vi, beforeEach } from "vitest";

// The action is server-only glue: resolve session → create the project → register the briefing.
// Everything it touches is mocked at the module boundary so the ORDER and PAYLOAD of the two writes,
// and what it says when the second one fails, are what's under test.
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-agency") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const platformFetch = vi.fn();
vi.mock("./platform", () => ({
  getMe: vi.fn(async () => ({ id: "u-1", companies: [{ id: "co-agency" }] })),
  platformFetch: (...args: unknown[]) => platformFetch(...args),
  PlatformError: class PlatformError extends Error { constructor(public status: number, message: string) { super(message); } },
}));

const getRecording = vi.fn();
vi.mock("./meetings", () => ({ getRecording: (...a: unknown[]) => getRecording(...a) }));

import { createBriefingAction, startRunManuallyAction } from "./prdActions";
import { PlatformError } from "./platform";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const base = { title: "Northwind — checkout intake", clientId: "cl-1", kind: "video", departmentId: "dept-1" };

beforeEach(() => { platformFetch.mockReset(); getRecording.mockReset(); });

describe("createBriefingAction — a briefing and its project are born together", () => {
  it("default: creates a Web Dev project named after the briefing, then registers the briefing under it", async () => {
    platformFetch
      .mockResolvedValueOnce({ id: "p-new" })                       // POST /projects
      .mockResolvedValueOnce({ id: "rec-new", meetingId: "mtg-x", deduped: false }); // POST /recordings/start
    const r = await createBriefingAction(null, fd({ ...base, projectMode: "new" }));
    expect(r).toEqual({ ok: true, id: "rec-new", projectId: "p-new", projectCreated: true });

    const [projCall, startCall] = platformFetch.mock.calls;
    expect(projCall[0]).toBe("/api/co-agency/projects");
    expect(JSON.parse(projCall[2].body)).toEqual({ name: "Northwind — checkout intake", clientId: "cl-1", departmentId: "dept-1" });
    expect(startCall[0]).toBe("/api/co-agency/meetings/recordings/start");
    expect(JSON.parse(startCall[2].body)).toEqual({ title: "Northwind — checkout intake", kind: "video", clientId: "cl-1", projectId: "p-new", departmentId: "dept-1" });
  });

  it("link mode: no project is created, the briefing is filed under the chosen one", async () => {
    platformFetch.mockResolvedValueOnce({ id: "rec-new" });
    const r = await createBriefingAction(null, fd({ ...base, projectMode: "existing", projectId: "p-web-1" }));
    expect(r).toEqual({ ok: true, id: "rec-new", projectId: "p-web-1", projectCreated: false });
    expect(platformFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(platformFetch.mock.calls[0][2].body).projectId).toBe("p-web-1");
  });

  it("link mode without a project chosen is refused before any write", async () => {
    const r = await createBriefingAction(null, fd({ ...base, projectMode: "existing" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/choose a project/i);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("title and client are required; kind must be audio or video", async () => {
    expect((await createBriefingAction(null, fd({ ...base, title: " " }))).error).toMatch(/title/i);
    expect((await createBriefingAction(null, fd({ ...base, clientId: "" }))).error).toMatch(/client/i);
    expect((await createBriefingAction(null, fd({ ...base, kind: "hologram" }))).error).toMatch(/audio or video/i);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("when the project is created but registering the briefing fails, it says so — the project is not silently orphaned", async () => {
    platformFetch
      .mockResolvedValueOnce({ id: "p-new" })
      .mockRejectedValueOnce(new PlatformError(500, "meetings service unavailable"));
    const r = await createBriefingAction(null, fd({ ...base, projectMode: "new" }));
    expect(r.ok).toBe(false);
    expect(r.projectId).toBe("p-new");
    expect(r.error).toMatch(/project .*was created/i);
    expect(r.error).toMatch(/meetings service unavailable/);
  });

  it("a platform refusal on the project write is returned as its own message", async () => {
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden: project.create"));
    const r = await createBriefingAction(null, fd({ ...base, projectMode: "new" }));
    expect(r).toEqual({ ok: false, error: "forbidden: project.create" });
  });
});

describe("startRunManuallyAction — the PRD run without the AI draft (no n8n / no LLM on this platform)", () => {
  const rec = { id: "rec-1", meeting_id: "mtg-1", title: "Northwind — checkout intake", client_id: "cl-1", project_id: "p-web-1", status: "transcribed", transcript: "words" };

  it("creates the run from the briefing with three pending stages, marks the briefing converted, links it", async () => {
    getRecording.mockResolvedValueOnce({ kind: "ok", data: rec });
    platformFetch
      .mockResolvedValueOnce({ id: "run-9", deduped: false })   // POST /pipeline/runs
      .mockResolvedValueOnce({ id: "rec-1" })                   // PATCH recording status
      .mockResolvedValueOnce({ relinked: 1 });                  // POST relink-orphans (best effort)
    const r = await startRunManuallyAction(null, fd({ id: "rec-1" }));
    expect(r).toEqual({ ok: true, id: "rec-1", runId: "run-9" });

    const [runCall, patchCall, relinkCall] = platformFetch.mock.calls;
    expect(runCall[0]).toBe("/api/co-agency/pipeline/runs");
    const body = JSON.parse(runCall[2].body);
    expect(body).toMatchObject({ sourceMeetingId: "mtg-1", title: "Northwind — checkout intake", clientId: "cl-1", projectId: "p-web-1" });
    expect(body.stages.map((s: { track: string; name: string; status: string }) => `${s.track}/${s.name}/${s.status}`)).toEqual([
      "delivery/prd_extract/pending", "report/report_extract/pending", "scope/scope_extract/pending",
    ]);
    expect(patchCall[0]).toBe("/api/co-agency/meetings/recordings/rec-1");
    expect(JSON.parse(patchCall[2].body)).toEqual({ status: "ingested" });
    expect(relinkCall[0]).toBe("/api/co-agency/meetings/recordings/relink-orphans");
  });

  it("refuses a briefing that has no transcript yet", async () => {
    getRecording.mockResolvedValueOnce({ kind: "ok", data: { ...rec, transcript: null, status: "recording" } });
    const r = await startRunManuallyAction(null, fd({ id: "rec-1" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/transcript/i);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("reuses an existing run when the platform says the meeting already has one", async () => {
    getRecording.mockResolvedValueOnce({ kind: "ok", data: rec });
    platformFetch.mockResolvedValueOnce({ id: "run-old", deduped: true }).mockResolvedValueOnce({ id: "rec-1" }).mockResolvedValueOnce({ relinked: 0 });
    const r = await startRunManuallyAction(null, fd({ id: "rec-1" }));
    expect(r).toEqual({ ok: true, id: "rec-1", runId: "run-old" });
  });

  it("a relink refusal (not company_admin) does not fail the whole thing", async () => {
    getRecording.mockResolvedValueOnce({ kind: "ok", data: rec });
    platformFetch.mockResolvedValueOnce({ id: "run-9" }).mockResolvedValueOnce({ id: "rec-1" }).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    const r = await startRunManuallyAction(null, fd({ id: "rec-1" }));
    expect(r.ok).toBe(true);
  });

  it("surfaces a refused run creation as its own message", async () => {
    getRecording.mockResolvedValueOnce({ kind: "ok", data: rec });
    platformFetch.mockRejectedValueOnce(new PlatformError(403, "forbidden: pipeline_run.create"));
    const r = await startRunManuallyAction(null, fd({ id: "rec-1" }));
    expect(r).toEqual({ ok: false, error: "forbidden: pipeline_run.create" });
  });
});
