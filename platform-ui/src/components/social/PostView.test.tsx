import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";

// SCP-1e (BFF §63.6.2): the server half of the post page, mounted by the full page and by the drawer. It reads the post and its thread through the BFF and says each refusal as
// itself: a 403 is "no access", a 404 is a 404 page, a Composer post (409) is said and linked, anything else is "cannot tell", and a failed secondary read (the thread, the
// Asset Library) is said beside its section while the post stays. The readers are replaced, so what is proved is what the page does with each answer.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/demoMode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("@/lib/socialPipeline-data", () => ({ readPipelinePost: vi.fn(), readPostComments: vi.fn(), readAssetChoices: vi.fn(), readPostMetrics: vi.fn() }));
vi.mock("@/lib/collabActions", () => ({ postEntityComment: vi.fn() }));
vi.mock("@/lib/socialPipelineActions", () => ({
  runPostAction: vi.fn(), savePostFields: vi.fn(), saveSuggestion: vi.fn(), dropSuggestion: vi.fn(), addPostDesign: vi.fn(), removePostDesign: vi.fn(),
  enterPostMetrics: vi.fn(), loadPostMetrics: vi.fn(),
}));

import { getDepartment } from "@/lib/departments";
import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { asPipelinePost, type PipelinePost } from "@/lib/socialPipeline";
import { readAssetChoices, readPipelinePost, readPostComments, readPostMetrics } from "@/lib/socialPipeline-data";
import type { PostMetrics } from "@/lib/socialMetrics";
import type { ReadResult } from "@/lib/readResult";
import { PostView } from "./PostView";

const postFor = (title: string, user: string): PipelinePost => asPipelinePost(demoPipelineRead(PIPE_POSTS.find((p) => p.title === title)!.id, user).json);
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const mount = async (chrome: "page" | "drawer" = "page", deptId = "d-soc", postId = "p-1") => render(await PostView({ deptId, postId, chrome }));

beforeEach(() => {
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(readPipelinePost).mockReset().mockResolvedValue(ok(postFor("Wool care in three steps", "u-social")));
  vi.mocked(readPostComments).mockReset().mockResolvedValue(ok([]));
  vi.mocked(readAssetChoices).mockReset().mockResolvedValue(ok([]));
  vi.mocked(readPostMetrics).mockReset().mockResolvedValue(ok<PostMetrics>({ latest: null, engagementRate: null, accountAverageRate: null, boostCandidate: false, simulated: false }));
});

describe("what is asked of the platform", () => {
  it("reads the post and its thread for the signed-in person, in the active company", async () => {
    await mount("page", "d-soc", "p-9");
    expect(readPipelinePost).toHaveBeenCalledWith("u-1", "co-a", "p-9");
    expect(readPostComments).toHaveBeenCalledWith("u-1", "co-a", "p-9");
    expect(screen.getByRole("heading", { level: 1, name: "Wool care in three steps" })).toBeInTheDocument();
  });

  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount("page", "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount("page", "nope")).rejects.toThrow("notFound");
    expect(readPipelinePost).not.toHaveBeenCalled();
  });

  it("reads the Asset Library only for the post's designer", async () => {
    await mount();
    expect(readAssetChoices).not.toHaveBeenCalled(); // the officer
    vi.mocked(readPipelinePost).mockResolvedValue(ok(postFor("Banquet room open day", "u-creative")));
    await mount();
    expect(readAssetChoices).toHaveBeenCalledWith("u-1", "co-a");
  });
});

describe("each answer in its own words", () => {
  it("a 403 says there is no access, never an empty post", async () => {
    vi.mocked(readPipelinePost).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to this post\./)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
  });

  it("a 404 is a 404 page", async () => {
    vi.mocked(readPipelinePost).mockResolvedValue({ kind: "unavailable", reason: "post_not_found" });
    await expect(mount()).rejects.toThrow("notFound");
  });

  it("a Composer post (409) says so and links to the Composer, without a redirect", async () => {
    vi.mocked(readPipelinePost).mockResolvedValue({ kind: "unavailable", reason: "not_a_pipeline_post" });
    await mount("page", "d-soc", "p-composer");
    expect(screen.getByRole("link", { name: "Open it in the Composer" })).toHaveAttribute("href", "/departments/d-soc/composer/p-composer");
    expect(screen.getByText(/not in the content pipeline/)).toBeInTheDocument();
  });

  it("any other failure is 'cannot tell', with the server's words, and not a statement about the post", async () => {
    vi.mocked(readPipelinePost).mockResolvedValue({ kind: "unavailable", reason: "platform 502" });
    await mount();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("platform 502")).toBeInTheDocument();
  });

  it("a thread that could not be read is said beside its section, and the post stays", async () => {
    vi.mocked(readPostComments).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/The comments could not be read/)).toBeInTheDocument();
    expect(screen.queryByText("No comments yet.")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Wool care in three steps" })).toBeInTheDocument();
  });

  it("a forbidden thread is also 'could not be read', not an empty thread", async () => {
    vi.mocked(readPostComments).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/The comments could not be read/)).toBeInTheDocument();
  });

  it("the drawer's body is the same page, with a level 2 heading", async () => {
    await mount("drawer");
    expect(screen.getByRole("heading", { level: 2, name: "Wool care in three steps" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

describe("a live post's metrics (SCP-3c, BFF §63.10)", () => {
  const live = () => vi.mocked(readPipelinePost).mockResolvedValue(ok(postFor("A day in the warehouse", "u-social")));

  it("reads them for a live post only, for the signed-in person, and draws the block", async () => {
    await mount("page", "d-soc", "p-1");
    expect(readPostMetrics).not.toHaveBeenCalled(); // Wool care in three steps is at proofread
    expect(screen.queryByRole("region", { name: "Metrics" })).toBeNull();
    live();
    vi.mocked(readPostMetrics).mockResolvedValue(ok<PostMetrics>({
      latest: { reach: 3000, impressions: null, likes: 200, comments: 10, shares: 5, saves: 25, clicks: null, videoViews: null, source: "manual", capturedAt: "2026-10-15T08:00:00.000Z" },
      engagementRate: 0.08, accountAverageRate: 0.04, boostCandidate: true, simulated: false,
    }));
    await mount("page", "d-soc", "p-live");
    expect(readPostMetrics).toHaveBeenCalledWith("u-1", "co-a", "p-live");
    expect(screen.getByRole("region", { name: "Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Boost candidate")).toBeInTheDocument();
    expect(screen.getByText("8.0%")).toBeInTheDocument();
    // The signed-in person (u-1) is not this client's officer: no form is offered.
    expect(screen.queryByRole("button", { name: /Enter metrics/ })).toBeNull();
  });

  it("a metrics read that failed is said beside its section, and the post stays", async () => {
    live();
    for (const answer of [{ kind: "unavailable", reason: "platform 500" }, { kind: "forbidden" }] as const) {
      vi.mocked(readPostMetrics).mockResolvedValue(answer);
      const { unmount } = await mount();
      expect(screen.getByText(/The numbers could not be read/)).toBeInTheDocument();
      expect(screen.queryByText("Engagement rate")).toBeNull();
      expect(screen.getByRole("heading", { level: 1, name: "A day in the warehouse" })).toBeInTheDocument();
      unmount();
    }
  });
});
