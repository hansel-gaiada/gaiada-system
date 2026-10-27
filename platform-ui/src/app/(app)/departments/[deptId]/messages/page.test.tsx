import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-1j (BFF §63.7, §63.14): the Social Media Messages page. The read is the server's (`GET waiting`); the page draws who holds each of the officer's posts,
// grouped by holder, with how long each has waited and when the holder was last reminded, and a Follow up button that posts the `follow_up` action. The
// server's refusals come back as codes: a second follow-up inside 24 hours is a wait with its time, a post nobody holds is said in words. A refused read is the
// "no access" state and a failed one says it cannot tell, never "nothing is waiting".
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialMessages-data", () => ({ getWaiting: vi.fn() }));
vi.mock("@/lib/socialMessagesActions", () => ({ followUpAction: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { getWaiting } from "@/lib/socialMessages-data";
import { followUpAction } from "@/lib/socialMessagesActions";
import { followUpRefusalText, type WaitingGroup } from "@/lib/socialMessages";
import type { ReadResult } from "@/lib/readResult";
import SocialMessagesPage from "./page";

const post = (over: Partial<WaitingGroup["posts"][number]> = {}): WaitingGroup["posts"][number] => ({
  id: "p-1", title: "Autumn collection teaser", clientName: "Northwind Traders", since: "2026-10-12T04:00:00.000Z", lastFollowUpAt: null,
  pipelineStatus: "hod", engagementId: "e-1", clientId: "c-1", ...over,
});
const groups = (): WaitingGroup[] => [
  { holder: { role: "approver", label: "The HoD or the GM", userIds: ["u-pm", "u-gm"] }, posts: [post(), post({ id: "p-2", title: "Winter packages", lastFollowUpAt: "2026-10-14T01:00:00.000Z", pipelineStatus: "final" })] },
  { holder: { role: "copywriter", label: "A copywriter", userIds: ["u-copy"] }, posts: [post({ id: "p-3", title: "Ginger and clove tea", pipelineStatus: "proofread", clientName: "Saltmarsh Day Spa", clientId: "c-2" })] },
  { holder: { role: "client", label: "The client", userIds: [] }, posts: [post({ id: "p-4", title: "Five ways to style a scarf", pipelineStatus: "client" })] },
];
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });

const mount = async (deptId = "d-soc") => render(await SocialMessagesPage({ params: Promise.resolve({ deptId }) }));
const row = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

beforeEach(() => {
  // Wednesday 14 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getWaiting).mockReset().mockResolvedValue(ok(groups()));
  vi.mocked(followUpAction).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the waiting posts for the signed-in person in the active company", async () => {
    await mount();
    expect(getWaiting).toHaveBeenCalledWith("u-1", "co-a");
  });
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount("d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount("nope")).rejects.toThrow("notFound");
  });
});

describe("the groups", () => {
  it("draws one section per holder, in the server's order, each naming who it waits on and how many posts", async () => {
    await mount();
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Waiting on the Social Media head or the GM (2)", "Waiting on a copywriter (1)", "Waiting on the client (1)",
    ]);
  });

  it("lists each post with its client, its step and how long it has waited, and opens it at the post page", async () => {
    await mount();
    const a = within(row("Autumn collection teaser"));
    expect(a.getByRole("link", { name: "Autumn collection teaser" })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(a.getByText(/Northwind Traders · Head check · waiting 2 days/)).toBeInTheDocument();
    expect(a.getByText("No follow-up yet")).toBeInTheDocument();
    const b = within(row("Winter packages"));
    expect(b.getByText(/Final check/)).toBeInTheDocument();
    expect(b.getByText("Last follow-up 3 h ago")).toBeInTheDocument();
  });

  it("only a client-held post opens the client's conversation", async () => {
    await mount();
    expect(within(row("Five ways to style a scarf")).getByRole("link", { name: "Open the conversation" })).toHaveAttribute("href", "/clients/c-1/work#conversation");
    expect(within(row("Winter packages")).queryByRole("link", { name: "Open the conversation" })).toBeNull();
    expect(within(row("Ginger and clove tea")).queryByRole("link", { name: "Open the conversation" })).toBeNull();
  });

  it("says so, in a sentence, when nothing of the person's is waiting (a person who is nobody's officer opens the page too)", async () => {
    vi.mocked(getWaiting).mockResolvedValue(ok([]));
    await mount();
    expect(screen.getByText(/Nothing of yours is waiting on anyone/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
  });

  it("a 403 is the 'no access' state and a failed read says it cannot tell", async () => {
    vi.mocked(getWaiting).mockResolvedValue({ kind: "forbidden" });
    const first = await mount();
    expect(screen.getByText(/You don.t have access to your Social Media messages/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(getWaiting).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/this is not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("platform 500")).toBeInTheDocument();
  });
});

describe("Follow up", () => {
  it("posts the follow_up action for that post at the step the person is looking at, then says it went", async () => {
    vi.mocked(followUpAction).mockResolvedValue({ ok: true, alreadyApplied: false });
    await mount();
    fireEvent.click(within(row("Autumn collection teaser")).getByRole("button", { name: "Follow up" }));
    await waitFor(() => expect(within(row("Autumn collection teaser")).getByText("Followed up. The holder has been reminded.")).toBeInTheDocument());
    expect(followUpAction).toHaveBeenCalledTimes(1);
    expect(followUpAction).toHaveBeenCalledWith("p-1", "hod");
    expect(within(row("Autumn collection teaser")).getByText("Last follow-up just now")).toBeInTheDocument();
    // the other posts were not touched
    expect(within(row("Winter packages")).queryByText(/Followed up/)).toBeNull();
  });

  it("shows 409 follow_up_too_soon as a wait, with the time from retryAfterSeconds, and holds the button until then", async () => {
    vi.mocked(followUpAction).mockResolvedValue({
      ok: false, error: "follow_up_too_soon", retryAfterSeconds: 12_000, message: followUpRefusalText({ error: "follow_up_too_soon", retryAfterSeconds: 12_000 }),
    });
    await mount();
    fireEvent.click(within(row("Winter packages")).getByRole("button", { name: "Follow up" }));
    await waitFor(() => expect(within(row("Winter packages")).getByRole("button", { name: "Follow up in 3 h 20 min" })).toBeDisabled());
    expect(within(row("Winter packages")).getByText(/You can follow up again in 3 h 20 min/)).toBeInTheDocument();
  });

  it("words 409 nobody_to_follow_up, and any other refusal, as an alert and leaves the button usable", async () => {
    vi.mocked(followUpAction).mockResolvedValueOnce({ ok: false, error: "nobody_to_follow_up", message: followUpRefusalText({ error: "nobody_to_follow_up" }) });
    await mount();
    fireEvent.click(within(row("Ginger and clove tea")).getByRole("button", { name: "Follow up" }));
    const alert = await within(row("Ginger and clove tea")).findByRole("alert");
    expect(alert).toHaveTextContent("Nobody else holds this post right now, so there is nobody to follow up.");
    // The alert can show while the click's transition still runs (the button reads "Following up…" until it ends): wait for the button to come back.
    await waitFor(() => expect(within(row("Ginger and clove tea")).getByRole("button", { name: "Follow up" })).toBeEnabled());
    vi.mocked(followUpAction).mockResolvedValueOnce({ ok: false, error: "status_changed", message: followUpRefusalText({ error: "status_changed" }) });
    fireEvent.click(within(row("Ginger and clove tea")).getByRole("button", { name: "Follow up" }));
    await waitFor(() => expect(within(row("Ginger and clove tea")).getByRole("alert")).toHaveTextContent(/moved on while you were looking/));
  });
});
