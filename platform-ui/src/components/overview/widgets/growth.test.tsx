import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { Learning } from "./Learning";
import { Appraisal } from "./Appraisal";
import { me as meFixture, member } from "@/lib/workspaceFixtures";
import { PlatformError } from "@/lib/platform";
import * as lms from "@/lib/lms";
import * as appraisals from "@/lib/appraisals-data";

vi.mock("@/lib/lms", async (orig) => ({ ...(await orig<typeof import("@/lib/lms")>()), getMyLearning: vi.fn() }));
vi.mock("@/lib/appraisals-data", () => ({ getMyAppraisals: vi.fn() }));

const person = meFixture([member()]);
const myLearning = vi.mocked(lms.getMyLearning);
const myAppraisals = vi.mocked(appraisals.getMyAppraisals);

const props = (key: string): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key, band: "growth", label: key },
});

const enrol = (id: string, over: Record<string, unknown> = {}) => ({
  id, pathId: id, pathKey: id, title: `Path ${id}`, isMandatory: false, status: "assigned", source: "x", dueOn: null,
  completedAt: null, overdue: false, startedAt: null, coursesRequired: 1, coursesCompleted: 0, ...over,
});
const pack = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, cycleName: `Cycle ${id}`, status, composite: null, submittedAt: "2026-06-01T00:00:00Z", finalizedAt: null, createdAt: "2026-05-01T00:00:00Z", ...over,
});

beforeEach(() => { myLearning.mockReset(); myAppraisals.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe("the Growth blocks are wired into the host (DW-3g)", () => {
  it("has a component for each of the two", () => {
    for (const k of ["learning", "appraisal"]) expect(hasOverviewWidget(k, OVERVIEW_WIDGETS)).toBe(true);
  });
});

describe("Learning (widget)", () => {
  it("reads as the signed-in person with the tenant, and shows counts, the overdue flag and the next due", async () => {
    myLearning.mockResolvedValue({
      enrolments: [enrol("a", { overdue: true, dueOn: "2026-08-18", title: "Security awareness" }), enrol("b", { status: "in_progress" }), enrol("c", { status: "completed" })],
      certifications: [],
    } as never);
    render(await Learning(props("learning")));
    expect(myLearning).toHaveBeenCalledWith("u-1", "co-a");
    const block = screen.getByRole("region", { name: "Learning" });
    expect(block).toHaveTextContent("2 outstanding, 1 in progress");
    expect(block.querySelector("[data-flag=overdue]")).toHaveTextContent("1 overdue");
    expect(block).toHaveTextContent("Next due: Security awareness, 18 Aug 2026 (overdue)");
    expect(screen.getByRole("link", { name: "My learning" })).toHaveAttribute("href", "/me/learning");
  });

  it("says Nothing due for dated-less work, and only an ok empty read says nothing outstanding", async () => {
    myLearning.mockResolvedValue({ enrolments: [enrol("a")], certifications: [] } as never);
    const first = render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Learning" })).toHaveTextContent("Nothing due");
    expect(screen.queryByText(/overdue/)).toBeNull();
    first.unmount();
    myLearning.mockResolvedValue({ enrolments: [], certifications: [] } as never);
    render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Learning" })).toHaveTextContent("Nothing outstanding.");
  });

  it("says Unavailable when the read failed and No access when it was refused, never 0 or nothing assigned", async () => {
    myLearning.mockRejectedValue(new Error("down"));
    const first = render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Learning" })).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/Nothing outstanding|outstanding|Nothing due/)).toBeNull();
    first.unmount();
    myLearning.mockRejectedValue(new PlatformError(403, "no"));
    render(await Learning(props("learning")));
    expect(screen.getByRole("region", { name: "Learning" })).toHaveTextContent("No access");
    expect(screen.queryByText(/Nothing outstanding|outstanding|Nothing due/)).toBeNull();
  });
});

describe("Appraisal (widget)", () => {
  it("reads with the tenant first and then the user", async () => {
    myAppraisals.mockResolvedValue({ appraisals: [] });
    render(await Appraisal(props("appraisal")));
    expect(myAppraisals).toHaveBeenCalledWith("co-a", "u-1");
  });

  it("shows the current pack's status and next step, and the last finalized result with its cycle", async () => {
    myAppraisals.mockResolvedValue({ appraisals: [
      pack("fin", "finalized", { composite: 4.2, finalizedAt: "2026-01-10T00:00:00Z" }),
      pack("cur", "submitted"),
    ] } as never);
    render(await Appraisal(props("appraisal")));
    const block = screen.getByRole("region", { name: "Appraisal" });
    expect(block).toHaveTextContent("Cycle cur: Submitted to you");
    expect(block).toHaveTextContent("My next step: Read it, then acknowledge or dispute it");
    expect(block).toHaveTextContent("Last result: 4.20 of 5, Cycle fin");
    expect(screen.getByRole("link", { name: "My appraisals" })).toHaveAttribute("href", "/appraisals/mine");
  });

  it("shows no next step for a status that gives the subject none", async () => {
    myAppraisals.mockResolvedValue({ appraisals: [pack("cur", "disputed")] } as never);
    render(await Appraisal(props("appraisal")));
    const block = screen.getByRole("region", { name: "Appraisal" });
    expect(block).toHaveTextContent("Cycle cur: Disputed");
    expect(block.querySelector("[data-next-step]")).toBeNull();
    expect(block).not.toHaveTextContent("Last result");
  });

  it("says No appraisal yet only for a successful empty read", async () => {
    myAppraisals.mockResolvedValue({ appraisals: [] });
    render(await Appraisal(props("appraisal")));
    expect(screen.getByRole("region", { name: "Appraisal" })).toHaveTextContent("No appraisal yet");
  });

  it("says Unavailable or No access, never No appraisal yet", async () => {
    myAppraisals.mockRejectedValue(new Error("down"));
    const first = render(await Appraisal(props("appraisal")));
    expect(screen.getByRole("region", { name: "Appraisal" })).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/No appraisal yet/)).toBeNull();
    first.unmount();
    myAppraisals.mockRejectedValue(new PlatformError(403, "no"));
    render(await Appraisal(props("appraisal")));
    expect(screen.getByRole("region", { name: "Appraisal" })).toHaveTextContent("No access");
    expect(screen.queryByText(/No appraisal yet/)).toBeNull();
  });
});
