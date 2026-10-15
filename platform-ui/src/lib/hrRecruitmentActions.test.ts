import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import {
  createRequisition, updateRequisition, setRequisitionStatus, submitRequisition, createCandidate, requestCandidateErasure,
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
