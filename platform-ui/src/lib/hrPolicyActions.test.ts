import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import { createReviewCycle, updateReviewCycle, addReviewParticipants, updateReviewParticipant } from "./hrPolicyActions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-active") }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  platformFetch: vi.fn(),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [] })),
}));

// DW-7f-4 — the review-cycle write actions. Backend: platform-nest hr-policy.controller.ts (Cerbos kind
// hr_policy: create/update/delete for hr_manager and company_admin, ratify for company_admin at high assurance). The routes
// 400 on a missing field, 404 on an unknown id; the database answers overlaps and duplicates in its own words.

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

function form(over: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(over)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}
const lastCall = () => {
  const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
  const req = init as RequestInit;
  return { path, user, init: req, body: req.body ? JSON.parse(String(req.body)) : undefined };
};
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
const BASE = "/api/co-a/modules/hr";

/** The refusals every action shares: a worded 403, the server's own 400/404/409 sentence, the generic fallback, no session. */
function sharedRefusals(name: string, call: () => Promise<{ ok: boolean; error?: string }>, forbidden: string) {
  it(`${name}: words a 403, passes the server's 400, 404 and 409 sentences back as sent, and revalidates nothing`, async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await call()).toEqual({ ok: false, error: `You don't have permission to ${forbidden}.` });
    for (const [status, text] of [[400, "periodEnd must be >= periodStart"], [404, "review cycle not found"], [409, "duplicate key value violates unique constraint"]] as const) {
      vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(status, text));
      expect((await call()).error).toBe(text);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it(`${name}: falls back to the raw body's message when the error text is the generic one`, async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "platform 400", undefined, undefined, undefined, { message: ["name required"] }));
    expect((await call()).error).toBe("name required");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(500, "platform 500"));
    expect((await call()).error).toBe("platform 500");
  });

  it(`${name}: does nothing without a session`, async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await call()).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
}

const refusesAll = async (call: (over: Record<string, string | string[]>) => Promise<{ ok: boolean }>, cases: Record<string, string | string[]>[]) => {
  for (const over of cases) expect((await call(over)).ok, JSON.stringify(over)).toBe(false);
  expect(platformFetch).not.toHaveBeenCalled();
};

// ═══════════════════════════════════════════════════════════ review cycles ═════════════════
describe("createReviewCycle", () => {
  const cycle = (over: Record<string, string> = {}) => form({
    name: "  2026 H2  ", kind: "probation", periodStart: "2026-07-01", periodEnd: "2026-12-31", opensOn: "2027-01-02", closesOn: "2027-01-31", ...over,
  });

  it("posts to review-cycles with the typed values and only the dates that were filled, then revalidates the reviews pages", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1" });
    const r = await createReviewCycle("co-a", cycle());
    expect(r.ok).toBe(true);
    expect(r.id).toBe("c-1");
    expect(r.notice).toContain("draft");
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-cycles`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ name: "2026 H2", kind: "probation", periodStart: "2026-07-01", periodEnd: "2026-12-31", opensOn: "2027-01-02", closesOn: "2027-01-31" });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("omits a blank window, defaults the kind to periodic and falls back to the active company", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1" });
    await createReviewCycle("", cycle({ kind: "", opensOn: "", closesOn: "" }));
    expect(lastCall().path).toBe("/api/co-active/modules/hr/review-cycles");
    expect(lastCall().body).toEqual({ name: "2026 H2", kind: "periodic", periodStart: "2026-07-01", periodEnd: "2026-12-31" });
  });

  it("refuses bad input without calling the server", async () => {
    await refusesAll((o) => createReviewCycle("co-a", cycle(o as Record<string, string>)), [
      { name: "" }, { kind: "yearly" }, { periodStart: "" }, { periodEnd: "31/12/2026" }, { periodEnd: "2026-06-30" },
      { opensOn: "tomorrow" }, { opensOn: "2027-02-01", closesOn: "2027-01-31" },
    ]);
  });
  sharedRefusals("createReviewCycle", () => createReviewCycle("co-a", cycle()), "create review cycles");
});

describe("updateReviewCycle", () => {
  const edit = (over: Record<string, string> = {}) => form({ name: "2026 H2", status: "open", opensOn: "2027-01-02", closesOn: "", ...over });

  it("patches the cycle with name, status and the window, a blank date sent as null to clear it", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateReviewCycle("co-a", "c-1", edit());
    expect(r).toMatchObject({ ok: true, id: "c-1" });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-cycles/c-1`);
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({ name: "2026 H2", status: "open", opensOn: "2027-01-02", closesOn: null });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("accepts every status from any other: the server has no status machine", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    for (const status of ["draft", "open", "closed", "cancelled"]) {
      expect((await updateReviewCycle("co-a", "c-1", edit({ status }))).ok).toBe(true);
    }
  });

  it("refuses bad input without calling the server", async () => {
    await refusesAll((o) => updateReviewCycle("co-a", "c-1", edit(o as Record<string, string>)), [
      { name: "" }, { status: "" }, { status: "archived" }, { opensOn: "soon" }, { opensOn: "2027-02-01", closesOn: "2027-01-31" },
    ]);
    expect((await updateReviewCycle("co-a", "", edit())).ok).toBe(false);
  });
  sharedRefusals("updateReviewCycle", () => updateReviewCycle("co-a", "c-1", edit()), "edit review cycles");
});

describe("addReviewParticipants", () => {
  const people = (over: Record<string, string | string[]> = {}) => form({ subjectUserId: ["u-a", "u-b", "u-a"], reviewerUserId: "u-r", dueOn: "2027-01-15", ...over });

  it("posts the ticked people once each, with the reviewer and due date on every one, and counts what the server added", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ cycleId: "c-1", added: 2 });
    const r = await addReviewParticipants("co-a", "c-1", people());
    expect(r).toMatchObject({ ok: true, id: "c-1", notice: "2 people added." });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-cycles/c-1/participants`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ participants: [
      { subjectUserId: "u-a", reviewerUserId: "u-r", dueOn: "2027-01-15" },
      { subjectUserId: "u-b", reviewerUserId: "u-r", dueOn: "2027-01-15" },
    ] });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("omits a blank reviewer and due date", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ cycleId: "c-1", added: 1 });
    await addReviewParticipants("co-a", "c-1", people({ subjectUserId: "u-a", reviewerUserId: "", dueOn: "" }));
    expect(lastCall().body).toEqual({ participants: [{ subjectUserId: "u-a" }] });
  });

  it("says when the server skipped people already in the cycle, and when it added nobody", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce({ cycleId: "c-1", added: 1 });
    expect((await addReviewParticipants("co-a", "c-1", people())).notice).toBe("1 of 2 added; the rest were already in this cycle.");
    vi.mocked(platformFetch).mockResolvedValueOnce({ cycleId: "c-1", added: 0 });
    expect((await addReviewParticipants("co-a", "c-1", people())).notice).toBe("Nobody was added: all of them are already in this cycle.");
    vi.mocked(platformFetch).mockResolvedValueOnce({ cycleId: "c-1", added: 0 });
    expect((await addReviewParticipants("co-a", "c-1", people({ subjectUserId: "u-a" }))).notice).toBe("Nobody was added: that person is already in this cycle.");
    vi.mocked(platformFetch).mockResolvedValueOnce({});
    expect((await addReviewParticipants("co-a", "c-1", people())).notice).toContain("did not say how many");
  });

  it("refuses an empty selection and a bad due date without calling the server", async () => {
    await refusesAll((o) => addReviewParticipants("co-a", "c-1", people(o)), [{ subjectUserId: [] }, { subjectUserId: ["", " "] }, { dueOn: "next week" }]);
  });
  sharedRefusals("addReviewParticipants", () => addReviewParticipants("co-a", "c-1", people()), "add review participants");
});

describe("updateReviewParticipant", () => {
  const upd = (over: Record<string, string> = {}) => form({ participantId: "p-1", status: "submitted", outcome: "pass", outcomeNote: " Solid ", reviewerUserId: "", ...over });

  it("patches only the filled fields, and says the server records the submission time", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateReviewParticipant("co-a", upd());
    expect(r).toMatchObject({ ok: true, id: "p-1" });
    expect(r.notice).toContain("submission time");
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-participants/p-1`);
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({ status: "submitted", outcome: "pass", outcomeNote: "Solid" });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("can change just the reviewer", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateReviewParticipant("co-a", upd({ status: "", outcome: "", outcomeNote: "", reviewerUserId: "u-r" }));
    expect(r.notice).toBe("Participant updated.");
    expect(lastCall().body).toEqual({ reviewerUserId: "u-r" });
  });

  it("refuses a missing participant, an unknown status or outcome (the database would 500), and a change of nothing", async () => {
    await refusesAll((o) => updateReviewParticipant("co-a", upd(o as Record<string, string>)), [
      { participantId: "" }, { status: "done" }, { outcome: "great" },
      { status: "", outcome: "", outcomeNote: "", reviewerUserId: "" },
    ]);
  });
  sharedRefusals("updateReviewParticipant", () => updateReviewParticipant("co-a", upd()), "update review participants");
});
