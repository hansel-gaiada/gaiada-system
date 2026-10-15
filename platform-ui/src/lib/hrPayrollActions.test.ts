import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import {
  createPayrollRun, calculatePayrollRun, approvePayrollRun, publishPayrollRun, markPayrollRunPaid,
} from "./hrPayrollActions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-active") }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  platformFetch: vi.fn(),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [] })),
}));

// DW-7f-1 — the payroll write actions. Backend: platform-nest payroll.controller.ts. It refuses a
// wrong-status call as 400 (create alone uses 409), so the tests carry the server's sentence on
// every status the controller can use.

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

function form(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    companyId: "co-a", reference: "PAY-2026-10", kind: "regular", periodStart: "2026-10-01",
    periodEnd: "2026-10-31", payDate: "2026-10-28", currency: "idr", ...over,
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
}
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
const lastCall = () => {
  const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
  const req = init as RequestInit;
  return { path, user, init: req, body: req.body ? JSON.parse(String(req.body)) : undefined };
};

describe("createPayrollRun", () => {
  it("posts the run to payroll-runs, upper-cases the currency, and revalidates the page and the Pulse home", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "run-1", status: "draft" });
    const r = await createPayrollRun(form());
    expect(r).toMatchObject({ ok: true, id: "run-1", status: "draft" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/payroll-runs");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      reference: "PAY-2026-10", kind: "regular", periodStart: "2026-10-01", periodEnd: "2026-10-31",
      currency: "IDR", payDate: "2026-10-28",
    });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/payroll", "/hr"]));
  });

  it("omits an empty pay date and falls back to the active company without a companyId", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "run-1", status: "draft" });
    await createPayrollRun(form({ payDate: "", companyId: "" }));
    expect(lastCall().path).toBe("/api/co-active/modules/hr/payroll-runs");
    expect(lastCall().body).not.toHaveProperty("payDate");
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { reference: "  " }, { kind: "weekly" }, { periodStart: "" }, { periodEnd: "2026-09-30" },
      { payDate: "28/10/2026" }, { currency: "RUPIAH" },
    ]) {
      expect((await createPayrollRun(form(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403, and passes the server's 409 sentences back as sent, revalidating nothing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await createPayrollRun(form())).toEqual({ ok: false, error: "You don't have permission to create payroll runs." });
    const dup = "a regular payroll run already exists for that period — use kind=correction for an off-cycle adjustment";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, dup));
    expect(await createPayrollRun(form())).toEqual({ ok: false, error: dup });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "that run reference is already in use"));
    expect((await createPayrollRun(form())).error).toBe("that run reference is already in use");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(422, "periodEnd must be >= periodStart"));
    expect((await createPayrollRun(form())).error).toBe("periodEnd must be >= periodStart");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does nothing without a session", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await createPayrollRun(form())).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

describe("calculatePayrollRun", () => {
  it("posts to calculate and reports the server's account: count, skipped people, and the statutory warning", async () => {
    vi.mocked(platformFetch).mockResolvedValue({
      id: "run-1", status: "calculated", employeeCount: 11,
      skipped: [{ name: "Budi", reason: "no compensation record in force for this period" }],
      statutoryWarning: "the statutory parameter set in force for this period is NOT ratified",
    });
    const r = await calculatePayrollRun("co-a", "run-1");
    expect(r.ok).toBe(true);
    expect(r.status).toBe("calculated");
    expect(r.notice).toContain("Calculated 11 employee(s).");
    expect(r.notice).toContain("1 skipped: Budi (no compensation record in force for this period)");
    expect(r.notice).toContain("NOT ratified");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/payroll-runs/run-1/calculate");
    expect(c.init.method).toBe("POST");
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/payroll", "/hr"]));
  });

  it("words a 403 and carries the server's 400 for a frozen run", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await calculatePayrollRun("co-a", "run-1")).error).toBe("You don't have permission to calculate payroll runs.");
    const frozen = "run is 'approved' — an approved or paid run is frozen; raise a kind=correction run instead";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, frozen));
    expect(await calculatePayrollRun("co-a", "run-1")).toEqual({ ok: false, error: frozen });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "payroll run not found"));
    expect((await calculatePayrollRun("co-a", "run-1")).error).toBe("payroll run not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("approvePayrollRun", () => {
  it("approves a ratified run without an override and reports the server's status", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, status: "approved", overrodeUnratified: false });
    const r = await approvePayrollRun("co-a", "run-1");
    expect(r).toMatchObject({ ok: true, status: "approved" });
    expect(r.notice).toMatch(/not yet visible to employees/);
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/payroll-runs/run-1/approve");
    expect(c.body).toEqual({ overrideUnratified: false });
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/payroll", "/hr"]));
  });

  it("sends the override with the trimmed reason, and says it was recorded only when the server confirms it", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, status: "approved", overrodeUnratified: true });
    const r = await approvePayrollRun("co-a", "run-1", { overrideUnratified: true, overrideReason: "  Owner signed off by email.  " });
    expect(lastCall().body).toEqual({ overrideUnratified: true, overrideReason: "Owner signed off by email." });
    expect(r.notice).toMatch(/recorded on the run/);
  });

  it("refuses an override with no reason without calling the server", async () => {
    for (const overrideReason of [undefined, "", "   "]) {
      const r = await approvePayrollRun("co-a", "run-1", { overrideUnratified: true, overrideReason });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/reason/);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 (naming the high-assurance sign-in) and passes the server's 400, 409 and 422 back as sent", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    const denied = await approvePayrollRun("co-a", "run-1");
    expect(denied.error).toMatch(/^You don't have permission to approve payroll runs\./);
    expect(denied.error).toMatch(/high-assurance sign-in/);
    const unratified = "the statutory parameter set this run used is NOT ratified. Ratify it, or re-send with overrideUnratified=true and an overrideReason";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, unratified));
    expect(await approvePayrollRun("co-a", "run-1")).toEqual({ ok: false, error: unratified });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "you calculated this run; another approver must approve it"));
    expect((await approvePayrollRun("co-a", "run-1")).error).toBe("you calculated this run; another approver must approve it");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(422, "run is 'draft' — only a calculated run can be approved"));
    expect((await approvePayrollRun("co-a", "run-1")).error).toBe("run is 'draft' — only a calculated run can be approved");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("publishPayrollRun", () => {
  it("posts to publish and reports how many slips the server published", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, published: 11 });
    const r = await publishPayrollRun("co-a", "run-1");
    expect(r).toMatchObject({ ok: true });
    expect(r.notice).toBe("11 payslip(s) published to their employees.");
    expect(lastCall().path).toBe("/api/co-a/modules/hr/payroll-runs/run-1/publish");
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/payroll", "/hr"]));
  });

  it("words a 403 and carries the server's refusal for a run that is not approved", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await publishPayrollRun("co-a", "run-1")).error).toMatch(/^You don't have permission to publish payslips\./);
    const msg = "run is 'calculated' — only an approved run's payslips may be published";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, msg));
    expect(await publishPayrollRun("co-a", "run-1")).toEqual({ ok: false, error: msg });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, "payslips are being rebuilt"));
    expect((await publishPayrollRun("co-a", "run-1")).error).toBe("payslips are being rebuilt");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("markPayrollRunPaid", () => {
  it("posts to paid and reports the server's status", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, status: "paid" });
    const r = await markPayrollRunPaid("co-a", "run-1");
    expect(r).toMatchObject({ ok: true, status: "paid" });
    expect(lastCall().path).toBe("/api/co-a/modules/hr/payroll-runs/run-1/paid");
    expect(lastCall().init.method).toBe("POST");
    expect(revalidated()).toEqual(expect.arrayContaining(["/hr/payroll", "/hr"]));
  });

  it("words a 403 and carries the server's refusal for a run that is not approved", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await markPayrollRunPaid("co-a", "run-1")).error).toMatch(/^You don't have permission to mark payroll runs paid\./);
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "run not found, or not in the approved state"));
    expect(await markPayrollRunPaid("co-a", "run-1")).toEqual({ ok: false, error: "run not found, or not in the approved state" });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(422, "bank file not exported"));
    expect((await markPayrollRunPaid("co-a", "run-1")).error).toBe("bank file not exported");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says the server gave no reason when it gave none, rather than guessing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(500, ""));
    const r = await markPayrollRunPaid("co-a", "run-1");
    expect(r.error).toMatch(/without giving a reason/);
  });

  it("does nothing without a session or a run", async () => {
    expect((await markPayrollRunPaid("co-a", "")).ok).toBe(false);
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await markPayrollRunPaid("co-a", "run-1")).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
