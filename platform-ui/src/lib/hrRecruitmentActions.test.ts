import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import {
  createRequisition, updateRequisition, setRequisitionStatus, submitRequisition, createCandidate, requestCandidateErasure,
  createApplication, moveApplicationStage, scheduleInterview, updateInterview, upsertPipelineStage,
  fileScorecard, createOffer, setOfferStatus, convertOffer,
} from "./hrRecruitmentActions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-active") }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  platformFetch: vi.fn(),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [] })),
}));

// DW-7f-2 — the recruitment write actions. Backend: platform-nest recruitment.controller.ts. It refuses a wrong-status
// call as 400, a duplicate candidate email or live application as 409, a missing row as 404, and the policy as 403.

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

function form(base: Record<string, string>, over: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) f.set(k, v);
  return f;
}
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
const lastCall = () => {
  const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
  const req = init as RequestInit;
  return { path, user, init: req, body: req.body ? JSON.parse(String(req.body)) : undefined };
};

const REQ = {
  companyId: "co-a", reference: "REQ-2026-014", title: "Designer", openings: "2", employmentType: "contract",
  contractMonths: "12", workMode: "hybrid", location: "Denpasar", salaryMin: "8000000", salaryMax: "12000000",
  currency: "idr", targetStartOn: "2026-12-01", hiringManagerUserId: "u-hm", description: "Own the brand.",
};
const reqForm = (over: Record<string, string> = {}) => form(REQ, over);

describe("createRequisition", () => {
  it("posts numbers as numbers to requisitions, upper-cases the currency and revalidates the console", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "rq-1", status: "draft" });
    const r = await createRequisition(reqForm());
    expect(r).toMatchObject({ ok: true, id: "rq-1", status: "draft" });
    expect(r.notice).toMatch(/draft/);
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/requisitions");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      reference: "REQ-2026-014", title: "Designer", openings: 2, employmentType: "contract", contractMonths: 12,
      workMode: "hybrid", location: "Denpasar", salaryMin: 8000000, salaryMax: 12000000, currency: "IDR",
      targetStartOn: "2026-12-01", hiringManagerUserId: "u-hm", description: "Own the brand.",
    });
    expect(revalidated()).toContain("/hr/recruitment");
  });

  it("omits empty optional fields, defaults the currency to IDR and falls back to the active company", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "rq-1", status: "draft" });
    await createRequisition(form({ reference: "R1", title: "Cook" }));
    const c = lastCall();
    expect(c.path).toBe("/api/co-active/modules/hr/requisitions");
    expect(c.body).toEqual({ reference: "R1", title: "Cook", currency: "IDR" });
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { reference: " " }, { title: "" }, { employmentType: "forever" }, { workMode: "moon" }, { openings: "0" },
      { openings: "1.5" }, { contractMonths: "61" }, { salaryMin: "-1" }, { salaryMin: "9", salaryMax: "5" },
      { targetStartOn: "01/12/2026" }, { currency: "RUPIAH" },
    ]) {
      expect((await createRequisition(reqForm(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 and 409 sentences back as sent, revalidating nothing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await createRequisition(reqForm())).toEqual({ ok: false, error: "You don't have permission to create requisitions." });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "salaryMax must be >= salaryMin"));
    expect((await createRequisition(reqForm())).error).toBe("salaryMax must be >= salaryMin");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "that requisition reference is already in use"));
    expect((await createRequisition(reqForm())).error).toBe("that requisition reference is already in use");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reads the server's sentence from the raw body when the message is the generic one", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "platform 400", undefined, undefined, undefined, { message: "reference and title required" }));
    expect((await createRequisition(reqForm())).error).toBe("reference and title required");
  });

  it("says so when the server gives no reason at all, and does nothing without a session", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(500, ""));
    expect((await createRequisition(reqForm())).error).toBe("The server refused this (500) without giving a reason.");
    vi.mocked(platformFetch).mockReset();
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await createRequisition(reqForm())).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

describe("updateRequisition", () => {
  it("PATCHes only the fields given and revalidates the requisition's own page", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateRequisition("co-a", "rq-1", form({ title: "Senior Designer", openings: "3", location: "", description: "" }));
    expect(r).toMatchObject({ ok: true, id: "rq-1" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/requisitions/rq-1");
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({ title: "Senior Designer", openings: 3 });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/recruitment", "/hr/recruitment/rq-1"]));
  });

  it("refuses an empty change and a salary range that is backwards, without calling the server", async () => {
    expect((await updateRequisition("co-a", "rq-1", form({ title: "" }))).error).toBe("Change at least one field.");
    expect((await updateRequisition("co-a", "rq-1", form({ salaryMin: "10", salaryMax: "2" }))).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and carries the server's 400 and 404", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await updateRequisition("co-a", "rq-1", form({ title: "x" }))).error).toBe("You don't have permission to edit this requisition.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "requisition not found"));
    expect((await updateRequisition("co-a", "rq-1", form({ title: "x" }))).error).toBe("requisition not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setRequisitionStatus", () => {
  it("PATCHes the status and reports it", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await setRequisitionStatus("co-a", "rq-1", "on_hold");
    expect(r).toMatchObject({ ok: true, status: "on_hold", notice: "Requisition set to on hold." });
    expect(lastCall().body).toEqual({ status: "on_hold" });
    expect(lastCall().init.method).toBe("PATCH");
    expect(revalidated()).toContain("/hr/recruitment/rq-1");
  });

  it("never sends open or pending_approval (the approval flow owns them), and passes the server's 400 through", async () => {
    for (const s of ["open", "pending_approval", "bogus"]) {
      expect((await setRequisitionStatus("co-a", "rq-1", s)).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
    const words = "status 'open' is set by the approval flow, not by PATCH — use POST /requisitions/:id/submit";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, words));
    expect((await setRequisitionStatus("co-a", "rq-1", "closed")).error).toBe(words);
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await setRequisitionStatus("co-a", "rq-1", "closed")).error).toBe("You don't have permission to change this requisition's status.");
  });
});

describe("submitRequisition", () => {
  it("posts to submit and returns the approval the server raised", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "rq-1", approvalId: "ap-9", status: "pending_approval" });
    const r = await submitRequisition("co-a", "rq-1");
    expect(r).toMatchObject({ ok: true, status: "pending_approval", approvalId: "ap-9" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/requisitions/rq-1/submit");
    expect(c.init.method).toBe("POST");
    expect(c.init.body).toBeUndefined();
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/recruitment", "/hr/recruitment/rq-1"]));
  });

  it("words a 403 and carries the server's 400 for a requisition that is not a draft", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await submitRequisition("co-a", "rq-1")).error).toBe("You don't have permission to submit requisitions.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "requisition is 'open', not draft"));
    expect(await submitRequisition("co-a", "rq-1")).toEqual({ ok: false, error: "requisition is 'open', not draft" });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "requisition not found"));
    expect((await submitRequisition("co-a", "rq-1")).error).toBe("requisition not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

const CAND = {
  companyId: "co-a", fullName: "Ayu Lestari", email: "ayu@example.com", phone: "+62 811", headline: "Designer",
  location: "Ubud", source: "referral", sourceDetail: "Referred by Made", consentGivenAt: "2026-10-01",
  retentionUntil: "2027-10-01", notes: "Strong portfolio.",
};

describe("createCandidate", () => {
  it("posts the candidate to candidates and revalidates the console", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "cd-1" });
    const r = await createCandidate(form(CAND));
    expect(r).toMatchObject({ ok: true, id: "cd-1" });
    expect(r.notice).toContain("Ayu Lestari");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/candidates");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      fullName: "Ayu Lestari", source: "referral", email: "ayu@example.com", phone: "+62 811", headline: "Designer",
      location: "Ubud", sourceDetail: "Referred by Made", notes: "Strong portfolio.",
      consentGivenAt: "2026-10-01", retentionUntil: "2027-10-01",
    });
    expect(revalidated()).toContain("/hr/recruitment");
  });

  it("defaults the source to direct and refuses bad input without calling the server", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "cd-1" });
    await createCandidate(form({ fullName: "Ayu" }));
    expect(lastCall().body).toEqual({ fullName: "Ayu", source: "direct" });
    vi.mocked(platformFetch).mockReset();
    for (const over of <Record<string, string>[]>[
      { fullName: " " }, { source: "billboard" }, { email: "not-an-email" }, { consentGivenAt: "yesterday" }, { retentionUntil: "2027" },
    ]) {
      expect((await createCandidate(form(CAND, over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 409 duplicate-email sentence through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await createCandidate(form(CAND))).error).toBe("You don't have permission to add candidates.");
    const dup = "a candidate with this email already exists in the pool";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, dup));
    expect(await createCandidate(form(CAND))).toEqual({ ok: false, error: dup });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("requestCandidateErasure", () => {
  it("posts to erasure-request and says it is a request, not a deletion", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await requestCandidateErasure("co-a", "cd-1");
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/not deleted now/);
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/candidates/cd-1/erasure-request");
    expect(c.init.method).toBe("POST");
    expect(revalidated()).toContain("/hr/recruitment");
  });

  it("words a 403 and carries the server's 404", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await requestCandidateErasure("co-a", "cd-1")).error).toBe("You don't have permission to request erasure of candidate data.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "candidate not found"));
    expect((await requestCandidateErasure("co-a", "cd-1")).error).toBe("candidate not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- applications, stages, interviews

describe("createApplication", () => {
  const APP = { companyId: "co-a", requisitionId: "rq-1", candidateId: "cd-1", stageKey: "screen", appliedOn: "2026-10-05" };

  it("posts the application and revalidates the console, the requisition page and the application pages", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "ap-1", stageKey: "screen", status: "active" });
    const r = await createApplication(form(APP));
    expect(r).toMatchObject({ ok: true, id: "ap-1", status: "active" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/applications");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ requisitionId: "rq-1", candidateId: "cd-1", stageKey: "screen", appliedOn: "2026-10-05" });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/recruitment", "/hr/recruitment/rq-1", "/hr/recruitment/[requisitionId]"]));
  });

  it("leaves the stage and date to the server when blank", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "ap-1", stageKey: "applied", status: "active" });
    await createApplication(form(APP, { stageKey: "", appliedOn: "" }));
    expect(lastCall().body).toEqual({ requisitionId: "rq-1", candidateId: "cd-1" });
  });

  it("refuses missing ids and a bad date without calling the server", async () => {
    for (const over of <Record<string, string>[]>[{ requisitionId: "" }, { candidateId: "" }, { appliedOn: "5 Oct" }]) {
      expect((await createApplication(form(APP, over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 409 live-application sentence through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await createApplication(form(APP))).error).toBe("You don't have permission to add applications.");
    const dup = "this candidate already has a live application for that requisition";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, dup));
    expect(await createApplication(form(APP))).toEqual({ ok: false, error: dup });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("moveApplicationStage", () => {
  it("posts the stage with the note and reports the move the server made", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ from: "screen", to: "interview", status: "active" });
    const r = await moveApplicationStage("co-a", "ap-1", form({ stageKey: "interview", note: " good call " }));
    expect(r).toMatchObject({ ok: true, id: "ap-1", status: "active", notice: "Moved from screen to interview." });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/applications/ap-1/stage");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ stageKey: "interview", note: "good call" });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/recruitment", "/hr/recruitment/applications/ap-1"]));
  });

  it("says when the move ended the application, from the server's status, and sends the rejection reason", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ from: "interview", to: "rejected", status: "rejected" });
    const r = await moveApplicationStage("co-a", "ap-1", form({ stageKey: "rejected", rejectionReason: "Not a fit" }));
    expect(r.notice).toContain("the application is now rejected");
    expect(lastCall().body).toEqual({ stageKey: "rejected", rejectionReason: "Not a fit" });
  });

  it("refuses an empty stage without calling the server", async () => {
    expect((await moveApplicationStage("co-a", "ap-1", form({ stageKey: " " }))).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and carries the server's 400 for a closed application and an unknown stage", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await moveApplicationStage("co-a", "ap-1", form({ stageKey: "x" }))).error).toBe("You don't have permission to move this application.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "application is 'hired' and cannot be moved"));
    expect((await moveApplicationStage("co-a", "ap-1", form({ stageKey: "x" }))).error).toBe("application is 'hired' and cannot be moved");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "unknown pipeline stage 'x'"));
    expect((await moveApplicationStage("co-a", "ap-1", form({ stageKey: "x" }))).error).toBe("unknown pipeline stage 'x'");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("scheduleInterview", () => {
  const IV = {
    kind: "technical", timezone: "Asia/Makassar", scheduledStart: "2026-10-20T09:00", scheduledEnd: "2026-10-20T10:00",
    location: "Room 2", meetingUrl: "https://meet.example.com/x",
  };

  it("converts the times typed in the zone to exact instants, sends the panelists, and says they were notified", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "iv-1" });
    const f = form(IV);
    f.append("panelists", "u-a");
    f.append("panelists", "u-b");
    f.append("panelists", "u-a");
    const r = await scheduleInterview("co-a", "ap-1", f);
    expect(r).toMatchObject({ ok: true, id: "iv-1" });
    expect(r.notice).toBe("Interview scheduled. 2 panelist(s) were notified.");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/applications/ap-1/interviews");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      kind: "technical", scheduledStart: "2026-10-20T01:00:00.000Z", scheduledEnd: "2026-10-20T02:00:00.000Z",
      timezone: "Asia/Makassar", location: "Room 2", meetingUrl: "https://meet.example.com/x",
      panelists: [{ userId: "u-a" }, { userId: "u-b" }],
    });
    expect(revalidated()).toContain("/hr/recruitment/applications/ap-1");
  });

  it("defaults the type and zone, and omits empty optional fields and panelists", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "iv-1" });
    const r = await scheduleInterview("co-a", "ap-1", form({ scheduledStart: "2026-10-20T09:00", scheduledEnd: "2026-10-20T10:00" }));
    expect(r.notice).toBe("Interview scheduled.");
    expect(lastCall().body).toEqual({
      kind: "interview", scheduledStart: "2026-10-20T01:00:00.000Z", scheduledEnd: "2026-10-20T02:00:00.000Z", timezone: "Asia/Makassar",
    });
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { kind: "party" }, { timezone: "Mars/Olympus" }, { scheduledStart: "" }, { scheduledEnd: "2026-10-20T09:00" },
      { scheduledEnd: "2026-10-20T08:00" }, { meetingUrl: "meet.example.com" },
    ]) {
      expect((await scheduleInterview("co-a", "ap-1", form(IV, over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 and 404 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await scheduleInterview("co-a", "ap-1", form(IV))).error).toBe("You don't have permission to schedule interviews.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "scheduledEnd must be after scheduledStart"));
    expect((await scheduleInterview("co-a", "ap-1", form(IV))).error).toBe("scheduledEnd must be after scheduledStart");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "application not found"));
    expect((await scheduleInterview("co-a", "ap-1", form(IV))).error).toBe("application not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateInterview", () => {
  it("PATCHes the status and outcome, and revalidates the application page", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateInterview("co-a", "ap-1", "iv-1", form({ status: "completed", outcome: "advance" }));
    expect(r).toMatchObject({ ok: true, id: "iv-1", notice: "Interview updated." });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/interviews/iv-1");
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({ status: "completed", outcome: "advance" });
    expect(revalidated()).toContain("/hr/recruitment/applications/ap-1");
  });

  it("converts new times in the interview's own zone, and needs both or neither", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    await updateInterview("co-a", "ap-1", "iv-1", form({ timezone: "Asia/Makassar", scheduledStart: "2026-10-21T14:00", scheduledEnd: "2026-10-21T15:00" }));
    expect(lastCall().body).toEqual({ scheduledStart: "2026-10-21T06:00:00.000Z", scheduledEnd: "2026-10-21T07:00:00.000Z" });
    vi.mocked(platformFetch).mockReset();
    for (const over of <Record<string, string>[]>[
      { scheduledStart: "2026-10-21T14:00" }, { scheduledStart: "2026-10-21T14:00", scheduledEnd: "2026-10-21T13:00" },
      { status: "teleported" }, { outcome: "maybe" }, {},
    ]) {
      expect((await updateInterview("co-a", "ap-1", "iv-1", form({ timezone: "Asia/Makassar" }, over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 404 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await updateInterview("co-a", "ap-1", "iv-1", form({ status: "completed" }))).error).toBe("You don't have permission to edit this interview.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "interview not found"));
    expect((await updateInterview("co-a", "ap-1", "iv-1", form({ status: "completed" }))).error).toBe("interview not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("upsertPipelineStage", () => {
  const ST = { companyId: "co-a", key: "tech_interview", label: "Technical interview", sortOrder: "3", terminalKind: "", requiresInterview: "on" };

  it("posts one stage in the stages array and revalidates the console and HR settings", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ upserted: 1 });
    const r = await upsertPipelineStage(form(ST));
    expect(r).toMatchObject({ ok: true, id: "tech_interview" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/pipeline-stages");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ stages: [{ key: "tech_interview", label: "Technical interview", sortOrder: 3, isTerminal: false, requiresInterview: true }] });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/recruitment", "/hr/settings"]));
  });

  it("a terminal kind makes the stage terminal", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ upserted: 1 });
    await upsertPipelineStage(form(ST, { key: "rejected", label: "Rejected", terminalKind: "rejected", requiresInterview: "" }));
    expect(lastCall().body.stages[0]).toMatchObject({ isTerminal: true, terminalKind: "rejected", requiresInterview: false });
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { key: "Tech Interview" }, { key: "" }, { label: " " }, { sortOrder: "-1" }, { terminalKind: "vanished" },
    ]) {
      expect((await upsertPipelineStage(form(ST, over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await upsertPipelineStage(form(ST))).error).toBe("You don't have permission to change the pipeline stages.");
    const words = "stage 'x' is terminal and needs terminalKind (hired|rejected|withdrawn)";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, words));
    expect((await upsertPipelineStage(form(ST))).error).toBe(words);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- scorecards, offers, convert

describe("fileScorecard", () => {
  it("posts the scorecard with numbers as numbers and reports the rating the server computed", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "sc-1", applicationRating: "4.25" });
    const r = await fileScorecard("co-a", "ap-1", form({ interviewId: "iv-1", overall: "4.5", recommendation: "yes", notes: " Sharp. " }));
    expect(r).toMatchObject({ ok: true, id: "sc-1" });
    expect(r.notice).toBe("Scorecard filed. The application's rating is now 4.25.");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/applications/ap-1/scorecards");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ interviewId: "iv-1", overall: 4.5, recommendation: "yes", notes: "Sharp." });
    expect(c.body).not.toHaveProperty("reviewerUserId");
    expect(revalidated()).toContain("/hr/recruitment/applications/ap-1");
  });

  it("a scorecard of notes alone is allowed, and says nothing about a rating the server did not return", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "sc-1", applicationRating: null });
    const r = await fileScorecard("co-a", "ap-1", form({ notes: "Late." }));
    expect(r.notice).toBe("Scorecard filed.");
    expect(lastCall().body).toEqual({ notes: "Late." });
  });

  it("refuses an empty scorecard, a score outside 0 to 5 and an unknown recommendation without calling the server", async () => {
    for (const f of [form({}), form({ overall: "6" }), form({ overall: "-1" }), form({ overall: "abc" }), form({ recommendation: "maybe" })]) {
      expect((await fileScorecard("co-a", "ap-1", f)).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 (a reader who is not on the panel) and passes the server's 400 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await fileScorecard("co-a", "ap-1", form({ overall: "3" }))).error).toBe("You don't have permission to file scorecards on this application.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "overall must be a number between 0 and 5"));
    expect((await fileScorecard("co-a", "ap-1", form({ overall: "3" }))).error).toBe("overall must be a number between 0 and 5");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createOffer", () => {
  const OFFER = {
    baseAmount: "11000000", currency: "idr", rateBasis: "monthly", employmentType: "permanent", probationMonths: "3",
    startOn: "2026-12-01", expiresOn: "2026-11-20",
  };

  it("posts the offer as a draft with numbers as numbers", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "of-1", status: "draft" });
    const r = await createOffer("co-a", "ap-1", form(OFFER));
    expect(r).toMatchObject({ ok: true, id: "of-1", status: "draft" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/applications/ap-1/offers");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      baseAmount: 11000000, currency: "IDR", rateBasis: "monthly", employmentType: "permanent", probationMonths: 3,
      startOn: "2026-12-01", expiresOn: "2026-11-20",
    });
    expect(revalidated()).toContain("/hr/recruitment/applications/ap-1");
  });

  it("refuses bad input without calling the server, including an expiry after the start", async () => {
    for (const over of <Record<string, string>[]>[
      { baseAmount: "" }, { baseAmount: "0" }, { baseAmount: "-5" }, { currency: "RUPIAH" }, { rateBasis: "fortnightly" },
      { employmentType: "forever" }, { probationMonths: "13" }, { contractMonths: "61" }, { startOn: "1 Dec" },
      { expiresOn: "2026-12-02" },
    ]) {
      expect((await createOffer("co-a", "ap-1", form(OFFER, over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's band-ceiling 400 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await createOffer("co-a", "ap-1", form(OFFER))).error).toBe("You don't have permission to make offers.");
    const ceiling = "offer of 11000000 exceeds the requisition's approved maximum of 10000000 — raise the requisition band first";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, ceiling));
    expect(await createOffer("co-a", "ap-1", form(OFFER))).toEqual({ ok: false, error: ceiling });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setOfferStatus", () => {
  it("posts the status to offers/:id/status and reports it", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, status: "sent", applicationId: "ap-1" });
    const r = await setOfferStatus("co-a", "ap-1", "of-1", "sent");
    expect(r).toMatchObject({ ok: true, id: "of-1", status: "sent", notice: "Offer marked sent." });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/offers/of-1/status");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ status: "sent" });
    expect(revalidated()).toContain("/hr/recruitment/applications/ap-1");
  });

  it("sends the decline reason only with a decline, trimmed", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, status: "declined" });
    await setOfferStatus("co-a", "ap-1", "of-1", "declined", "  Took another job  ");
    expect(lastCall().body).toEqual({ status: "declined", declineReason: "Took another job" });
    vi.mocked(platformFetch).mockClear();
    await setOfferStatus("co-a", "ap-1", "of-1", "withdrawn", "ignored");
    expect(lastCall().body).toEqual({ status: "withdrawn" });
  });

  it("never sends converted or an unknown status (converting is its own route)", async () => {
    for (const s of ["converted", "draft", "pending_approval", "bogus"]) {
      expect((await setOfferStatus("co-a", "ap-1", "of-1", s)).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 404 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await setOfferStatus("co-a", "ap-1", "of-1", "sent")).error).toBe("You don't have permission to change this offer's status.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "offer not found (or already converted)"));
    expect((await setOfferStatus("co-a", "ap-1", "of-1", "withdrawn")).error).toBe("offer not found (or already converted)");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("convertOffer", () => {
  it("posts to convert, says what the server created, and revalidates People and the application", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, employeeId: "emp-1", applicationId: "ap-1", hireDate: "2026-12-01", employmentStatus: "pending_start" });
    const r = await convertOffer("co-a", "ap-1", "of-1", form({ hireDate: "2026-12-01", workEmail: "budi@gaiada.com" }));
    expect(r).toMatchObject({ ok: true, id: "of-1", employeeId: "emp-1", status: "pending_start" });
    expect(r.notice).toContain("Employee record created, starting 2026-12-01, with the status pending start.");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/offers/of-1/convert");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ hireDate: "2026-12-01", workEmail: "budi@gaiada.com" });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/recruitment/applications/ap-1", "/hr/people", "/hr"]));
  });

  it("sends an empty body when no hire date is given, leaving the server to use the offer's start date", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, employeeId: "emp-1", hireDate: "2026-12-01", employmentStatus: "pending_start" });
    await convertOffer("co-a", "ap-1", "of-1", form({}));
    expect(lastCall().body).toEqual({});
  });

  it("refuses a bad date or email without calling the server", async () => {
    expect((await convertOffer("co-a", "ap-1", "of-1", form({ hireDate: "1 Dec" }))).ok).toBe(false);
    expect((await convertOffer("co-a", "ap-1", "of-1", form({ workEmail: "nope" }))).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("a 403 says it needs a high-assurance sign-in too, and the server's 400 and 409 sentences pass through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await convertOffer("co-a", "ap-1", "of-1", form({}))).error)
      .toBe("You don't have permission to convert offers into employees. Converting an offer also needs a high-assurance sign-in.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "offer is 'sent' — only an accepted offer can be converted"));
    expect((await convertOffer("co-a", "ap-1", "of-1", form({}))).error).toBe("offer is 'sent' — only an accepted offer can be converted");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "hireDate required (the offer carries no startOn)"));
    expect((await convertOffer("co-a", "ap-1", "of-1", form({}))).error).toBe("hireDate required (the offer carries no startOn)");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "offer is already converted"));
    expect((await convertOffer("co-a", "ap-1", "of-1", form({}))).error).toBe("offer is already converted");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
