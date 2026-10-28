import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-3c (BFF §63.10 "Metrics"): the Metrics block of a live post and the officer's Enter metrics form. The writes are the demo store's (the twin DEMO_MODE serves): the actions module
// is replaced by one that calls `socialDemo`, the server's order of checks, so what the form posts is checked by the same rules the server applies and the block shows what comes back.
// The store seeds from the day it is first touched, so the clock is pinned to mid-month before it is imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }) }));
const persona = vi.hoisted(() => ({ user: "demo-hansel" }));
vi.mock("@/lib/socialPipelineActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { asPostMetrics, asStoredMetrics } = await import("@/lib/socialMetrics");
  const { refusalFromBody, refusalText } = await import("@/lib/socialPipeline");
  const call = (method: string, tail: string, body?: unknown) =>
    socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), persona.user)!;
  return {
    enterPostMetrics: vi.fn(async (variantId: string, body: unknown) => {
      const r = call("POST", `variants/${variantId}/metrics`, body);
      const j = r.json as Record<string, unknown>;
      if (r.status < 300) return { ok: true as const, stored: asStoredMetrics(j) };
      const refusal = refusalFromBody(r.status, String(j.error), j, typeof j.field === "string" ? j.field : undefined);
      return { ok: false as const, refusal, message: refusalText(refusal) };
    }),
    loadPostMetrics: vi.fn(async (postId: string) => {
      const r = call("GET", `posts/${postId}/metrics`);
      return r.status < 300 ? asPostMetrics(r.json) : null;
    }),
  };
});

import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { socialDemo } from "@/lib/demoSocial";
import { asPostMetrics } from "@/lib/socialMetrics";
import { asPipelinePost, type PipelinePost } from "@/lib/socialPipeline";
import { enterPostMetrics, loadPostMetrics } from "@/lib/socialPipelineActions";
import { PostMetricsSection, type PostMetricsSectionProps } from "./PostMetrics";
import { PostPage } from "./PostPage";

const postOf = (title: string) => PIPE_POSTS.find((p) => p.title === title)!;
const read = (title: string, user = "demo-hansel"): PipelinePost => asPipelinePost(demoPipelineRead(postOf(title).id, user).json);
const metricsOf = (title: string) => asPostMetrics(socialDemo("GET", `/api/co-agency/modules/social/posts/${postOf(title).id}/metrics`, new URLSearchParams(), undefined, "demo-hansel")!.json);

/** The block for one of the demo's posts, drawn for `viewer` (the officer by default). */
function mount(title: string, o: { viewer?: string | null; metrics?: PostMetricsSectionProps["metrics"]; onSaved?: () => void } = {}) {
  const post = read(title);
  const viewer = o.viewer === undefined ? post.officer!.id : o.viewer;
  persona.user = viewer ?? "demo-hansel";
  const metrics = "metrics" in o ? o.metrics : metricsOf(title);
  const r = render(<PostMetricsSection post={post} metrics={metrics} viewerId={viewer} onSaved={o.onSaved} />);
  return { post, ...r };
}
const block = () => within(screen.getByRole("region", { name: "Metrics" }));
const cell = (label: string) => screen.getByText(label, { selector: "dt" }).closest("div")!;

beforeEach(() => vi.clearAllMocks());

describe("the block draws the read", () => {
  it("a boost candidate: the numbers, the rate as a percentage, the client's average, the chip, the source and when it was captured", () => {
    mount("A day in the warehouse");
    expect(screen.getByRole("heading", { name: "Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Boost candidate")).toHaveClass("scp-chip");
    expect(screen.queryByText("SIMULATED")).toBeNull();
    expect(within(cell("Engagement rate")).getByText(/^7\.\d%$/)).toBeInTheDocument();
    expect(within(cell("This client's average, last 90 days")).getByText(/^3\.\d%$/)).toBeInTheDocument();
    for (const label of ["Reach", "Likes", "Comments", "Shares", "Saves", "Clicks", "Video views"]) expect(screen.getByText(label, { selector: "dt" }), label).toBeInTheDocument();
    expect(within(cell("Reach")).getByText(/^[\d,]+$/)).toBeInTheDocument();
    expect(within(cell("Clicks")).getByText("Not reported")).toBeInTheDocument(); // never 0
    expect(screen.getByText(/Source:/).textContent).toMatch(/Source: Typed in, captured \d{2} \w{3}/);
  });

  it("a simulated post carries the SIMULATED chip and its source says Simulated; it is no candidate and has no average", () => {
    mount("Weekend brunch is back");
    expect(screen.getByRole("img", { name: "Simulated" })).toHaveClass("scp-sim-mark"); // SCP-Sf: the one mark
    expect(screen.queryByText("Boost candidate")).toBeNull();
    expect(screen.getByText(/Source:/).textContent).toMatch(/Source: Simulated, captured/);
    expect(within(cell("This client's average, last 90 days")).getByText("Not known")).toBeInTheDocument();
    expect(screen.getByText("No other live post of this client has a rate yet.")).toBeInTheDocument();
  });

  it("a pulled post with no reach says Pulled, shows the rate as not known and the reach as not reported", () => {
    mount("Open until late tonight");
    expect(screen.getByText(/Source:/).textContent).toMatch(/Source: Pulled, captured/);
    expect(within(cell("Engagement rate")).getByText("Not known")).toBeInTheDocument();
    expect(screen.getByText("It needs a reach.")).toBeInTheDocument();
    expect(within(cell("Reach")).getByText("Not reported")).toBeInTheDocument();
    expect(screen.queryByText("Boost candidate")).toBeNull();
  });

  it("a live post with no numbers says so (not a row of zeros)", () => {
    mount("Sunday reset ritual", { metrics: { latest: null, engagementRate: null, accountAverageRate: null, boostCandidate: false, simulated: false } });
    expect(screen.getByText("No numbers for this post yet.")).toBeInTheDocument();
    expect(screen.queryByText("Source:", { exact: false })).toBeNull();
  });

  it("a read that failed says it cannot tell, and is not a statement that there are none", () => {
    mount("A day in the warehouse", { metrics: null });
    expect(screen.getByRole("status")).toHaveTextContent("The numbers could not be read, so they are not shown here. This is not a statement that there are none.");
    expect(screen.queryByText("Engagement rate")).toBeNull();
  });

  it("draws nothing when the metrics were not asked for, or the post is not live", () => {
    const a = mount("A day in the warehouse", { metrics: undefined });
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = mount("Five ways to style a scarf", { metrics: metricsOf("Five ways to style a scarf") });
    expect(b.container).toBeEmptyDOMElement();
  });
});

describe("who is offered the form", () => {
  it("the client's officer gets one Enter metrics button per network, each named by its network", () => {
    mount("Sunday reset ritual");
    expect(block().getByRole("button", { name: "Enter metrics for Instagram" })).toHaveAttribute("aria-expanded", "false");
    expect(block().getByRole("button", { name: "Enter metrics for Facebook" })).toBeInTheDocument();
  });

  it("nobody else is: a copywriter, a designer, a signed-out page", () => {
    for (const viewer of ["u-copy", "u-social-design", null]) {
      const { unmount } = mount("Sunday reset ritual", { viewer });
      expect(screen.queryByRole("button", { name: /Enter metrics/ }), String(viewer)).toBeNull();
      unmount();
    }
  });
});

describe("the Enter metrics form", () => {
  const open = (network: string) => fireEvent.click(block().getByRole("button", { name: `Enter metrics for ${network}` }));
  const form = (network: string) => within(screen.getByRole("group", { name: `Enter metrics for ${network}` }));
  const type = (network: string, label: string, v: string) => fireEvent.change(form(network).getByLabelText(label), { target: { value: v } });

  it("opens with a labelled field for the capture time and every counter, reach marked required", () => {
    mount("Closing hours reminder");
    open("Instagram");
    expect(block().getByRole("button", { name: "Close the Instagram form" })).toHaveAttribute("aria-expanded", "true");
    for (const label of ["Captured at", "Reach (required)", "Impressions", "Likes", "Comments", "Shares", "Saves", "Video views", "Clicks"]) {
      expect(form("Instagram").getByLabelText(label), label).toBeInTheDocument();
    }
    expect((form("Instagram").getByLabelText("Captured at") as HTMLInputElement).type).toBe("datetime-local");
    expect((form("Instagram").getByLabelText("Captured at") as HTMLInputElement).value).toMatch(/^2026-10-16T\d{2}:\d{2}$/);
    fireEvent.click(block().getByRole("button", { name: "Close the Instagram form" }));
    expect(screen.queryByRole("group", { name: "Enter metrics for Instagram" })).toBeNull();
  });

  it("saves one snapshot for the variant: posts the body, closes, says so, and shows the server's own aggregate again", async () => {
    const onSaved = vi.fn();
    const { post } = mount("Closing hours reminder", { onSaved });
    const before = metricsOf("Closing hours reminder");
    open("Instagram");
    type("Instagram", "Reach (required)", "4000");
    type("Instagram", "Likes", "200");
    type("Instagram", "Comments", "20");
    type("Instagram", "Saves", "30");
    type("Instagram", "Shares", "10");
    fireEvent.click(form("Instagram").getByRole("button", { name: "Save metrics" }));

    await waitFor(() => expect(screen.getByText("Metrics saved for Instagram.")).toBeInTheDocument());
    expect(enterPostMetrics).toHaveBeenCalledTimes(1);
    const [variantId, body] = vi.mocked(enterPostMetrics).mock.calls[0] as [string, Record<string, unknown>];
    expect(variantId).toBe(post.variants[0].id);
    expect(body).toEqual({ capturedAt: expect.stringMatching(/^2026-10-1\dT\d{2}:\d{2}:00\.000Z$/), reach: 4000, likes: 200, comments: 20, shares: 10, saves: 30 });
    expect(loadPostMetrics).toHaveBeenCalledWith(post.id);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Enter metrics for Instagram" })).toBeNull();
    // The block now shows the newest snapshot (the one just typed in), and its rate is the server's: (200 + 20 + 30 + 10) / 4000 = 6.5%.
    expect(before.latest!.source).toBe("manual");
    expect(within(cell("Engagement rate")).getByText("6.5%")).toBeInTheDocument();
    expect(within(cell("Reach")).getByText("4,000")).toBeInTheDocument();
  });

  it("blank reach and a bad counter are told beside their inputs, with no round trip", () => {
    mount("Closing hours reminder");
    open("Instagram");
    type("Instagram", "Likes", "12.5");
    fireEvent.click(form("Instagram").getByRole("button", { name: "Save metrics" }));
    expect(enterPostMetrics).not.toHaveBeenCalled();
    const reach = form("Instagram").getByLabelText("Reach (required)");
    expect(reach).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Reach is required: the engagement rate divides by it.")).toBeInTheDocument();
    expect(reach.getAttribute("aria-describedby")).toBe(screen.getByText("Reach is required: the engagement rate divides by it.").id);
    expect(form("Instagram").getByLabelText("Likes")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Likes must be a whole number from 0.")).toHaveAttribute("role", "alert");
    // typing clears that field's error
    type("Instagram", "Reach (required)", "100");
    expect(form("Instagram").getByLabelText("Reach (required)")).not.toHaveAttribute("aria-invalid");
  });

  it("a 400 from the server is put beside the field it names, in words", async () => {
    mount("Closing hours reminder");
    vi.mocked(enterPostMetrics).mockResolvedValueOnce({
      ok: false, refusal: { status: 400, error: "invalid_field", field: "likes" }, message: "Likes is not valid.",
    });
    open("Instagram");
    type("Instagram", "Reach (required)", "100");
    fireEvent.click(form("Instagram").getByRole("button", { name: "Save metrics" }));
    await waitFor(() => expect(screen.getByText("Likes is not valid.")).toBeInTheDocument());
    expect(form("Instagram").getByLabelText("Likes")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("group", { name: "Enter metrics for Instagram" })).toBeInTheDocument(); // the form stays open with what was typed
    expect((form("Instagram").getByLabelText("Reach (required)") as HTMLInputElement).value).toBe("100");
  });

  it("any other refusal is said in words under the form (the existing refusal vocabulary)", async () => {
    mount("Closing hours reminder");
    vi.mocked(enterPostMetrics).mockResolvedValueOnce({
      ok: false, refusal: { status: 409, error: "post_not_live" }, message: "The post is not live yet.",
    });
    open("Instagram");
    type("Instagram", "Reach (required)", "100");
    fireEvent.click(form("Instagram").getByRole("button", { name: "Save metrics" }));
    await waitFor(() => expect(within(form("Instagram").getByRole("alert")).getByText("The post is not live yet.")).toBeInTheDocument());
  });

  it("a person the server refuses (403) is told so, and nothing is saved", async () => {
    // the form is cosmetic: a copywriter driven to it anyway gets the server's refusal, shown in words
    const post = read("Closing hours reminder");
    persona.user = "u-copy";
    render(<PostMetricsSection post={{ ...post, officer: { id: "u-copy", name: "Mock" } }} metrics={metricsOf("Closing hours reminder")} viewerId="u-copy" />);
    open("Instagram");
    type("Instagram", "Reach (required)", "100");
    fireEvent.click(form("Instagram").getByRole("button", { name: "Save metrics" }));
    await waitFor(() => expect(form("Instagram").getByRole("alert")).toBeInTheDocument());
    expect(form("Instagram").getByRole("alert")).toHaveTextContent(/not allowed/i);
    expect(loadPostMetrics).not.toHaveBeenCalled();
  });
});

describe("the post page carries the block", () => {
  it("a live post shows the Metrics section between the post and its logs; a post that is not live does not", () => {
    const post = read("A day in the warehouse");
    const { unmount } = render(<PostPage deptId="dept-4" post={post} comments={[]} assets={null} metrics={metricsOf("A day in the warehouse")} viewerId={post.officer!.id} demo />);
    expect(screen.getByRole("region", { name: "Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Boost candidate")).toBeInTheDocument();
    unmount();
    const other = read("Five ways to style a scarf");
    render(<PostPage deptId="dept-4" post={other} comments={[]} assets={null} demo />);
    expect(screen.queryByRole("region", { name: "Metrics" })).toBeNull();
  });
});
