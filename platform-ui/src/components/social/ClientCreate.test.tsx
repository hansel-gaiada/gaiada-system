import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-1m (BFF §63.6.1): the client page's create bar. "+ New post" and "Extra post" post to the cycle with a fresh id and the right body, show the server's
// refusal in words (403 not_officer_or_approver), and keep the extra post flagged and outside the target. "New task" opens PM's flow on the client's project;
// "Ask Creatives for assets" opens the work-request form addressed to Creatives.
const refresh = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/socialClientActions", () => ({ bulkPostAction: vi.fn(), createClientPost: vi.fn() }));

import { createClientPost } from "@/lib/socialClientActions";
import { createRefusalText } from "@/lib/socialClient";
import { ClientCreate } from "./ClientCreate";

const create = vi.mocked(createClientPost);
const props = {
  deptId: "d-soc", cycleId: "cyc-1", platforms: ["instagram", "tiktok"], pillars: ["Seasonal", "Product stories"], projectId: null, askCreatives: true, openInitial: null,
} as const;
const mount = (over: Partial<Parameters<typeof ClientCreate>[0]> = {}) => render(<ClientCreate {...props} {...over} />);
const form = (name: string) => screen.getByRole("form", { name });
const title = () => screen.getByLabelText("Title");

beforeEach(() => { create.mockReset(); refresh.mockReset(); });

describe("the bar", () => {
  it("offers + New post, Extra post, New task and Ask Creatives for assets", () => {
    mount();
    const bar = screen.getByRole("group", { name: "Create" });
    expect(within(bar).getByRole("button", { name: "+ New post" })).toBeEnabled();
    expect(within(bar).getByRole("button", { name: "Extra post" })).toBeEnabled();
    expect(within(bar).getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks/new");
    expect(within(bar).getByRole("link", { name: "Ask Creatives for assets" })).toHaveAttribute("href", "/requests/new?to=creatives");
  });

  it("opens New task already on the client's project when the engagement has one", () => {
    mount({ projectId: "proj 7" });
    expect(screen.getByRole("link", { name: "New task" })).toHaveAttribute("href", "/tasks/new?projectId=proj%207");
  });

  it("offers no Ask Creatives link to a company with no Creatives department", () => {
    mount({ askCreatives: false });
    expect(screen.queryByRole("link", { name: "Ask Creatives for assets" })).toBeNull();
  });

  it("disables both post buttons with the reason when the client has no cycle this month, and never opens a form", () => {
    mount({ cycleId: null, openInitial: "post" });
    expect(screen.getByRole("button", { name: "+ New post" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Extra post" })).toBeDisabled();
    expect(screen.getByText(/has no cycle this month/)).toBeInTheDocument();
    expect(screen.queryByRole("form")).toBeNull();
    // the task and the request do not need a cycle
    expect(screen.getByRole("link", { name: "New task" })).toBeInTheDocument();
  });

  it("opens the form the Create menu asked for, and toggles it", () => {
    mount({ openInitial: "extra" });
    expect(form("New extra post")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Extra post" }));
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ New post" }));
    expect(form("New post")).toBeInTheDocument();
  });
});

describe("+ New post", () => {
  it("posts the right body to the cycle: a fresh id, the fields, and the client's platforms as the placement", async () => {
    create.mockResolvedValue({ ok: true, postId: "p-new", created: true });
    mount({ openInitial: "post" });
    fireEvent.change(title(), { target: { value: "  Harvest day  " } });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "reel" } });
    fireEvent.change(screen.getByLabelText("Pillar"), { target: { value: "Seasonal" } });
    fireEvent.change(screen.getByLabelText(/Date and time/), { target: { value: "2026-11-03T09:30" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "TikTok" })); // the placement starts as every platform; this drops TikTok
    fireEvent.submit(form("New post"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith("cyc-1", {
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      title: "Harvest day", isExtra: false, format: "reel", pillar: "Seasonal", scheduledAt: new Date("2026-11-03T09:30").toISOString(), placement: ["instagram"],
    });
  });

  it("on success says so, links to the post's page, reads the page again and closes the form", async () => {
    create.mockResolvedValue({ ok: true, postId: "p-new", created: true });
    mount({ openInitial: "post" });
    fireEvent.change(title(), { target: { value: "Quick one" } });
    fireEvent.submit(form("New post"));
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("Post added to the plan.");
    expect(within(note).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/departments/d-soc/posts/p-new");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("leaves the empty fields as nulls", async () => {
    create.mockResolvedValue({ ok: true, postId: "p-new", created: true });
    mount({ openInitial: "post", platforms: [] });
    fireEvent.change(title(), { target: { value: "Just a title" } });
    fireEvent.submit(form("New post"));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toMatchObject({ title: "Just a title", isExtra: false, format: null, pillar: null, scheduledAt: null, placement: [] });
    expect(screen.queryByText(/no platforms yet/)).toBeNull(); // the form is gone after the success
  });

  it("says a client with no platforms has none to place the post on", () => {
    mount({ openInitial: "post", platforms: [] });
    expect(screen.getByText(/This client has no platforms yet/)).toBeInTheDocument();
  });

  it("checks the title before it asks the server, and names the problem", () => {
    mount({ openInitial: "post" });
    fireEvent.submit(form("New post"));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the post a title of 1 to 200 characters.");
    expect(create).not.toHaveBeenCalled();
  });

  it("shows the server's refusal for someone who is not the officer or an approver, in words, and keeps the form", async () => {
    create.mockResolvedValue({ ok: false, error: "not_officer_or_approver", message: createRefusalText("not_officer_or_approver") });
    mount({ openInitial: "post" });
    fireEvent.change(title(), { target: { value: "Not mine to add" } });
    fireEvent.submit(form("New post"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only this client's officer, the Social Media head, the GM, the owner or the superadmin can add a post to the cycle.");
    expect(form("New post")).toBeInTheDocument();
    expect(title()).toHaveValue("Not mine to add");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the same id across a retry, so a repeated request cannot add a second post", async () => {
    create.mockResolvedValueOnce({ ok: false, error: "session_expired", message: "Session expired — sign in again." });
    create.mockResolvedValueOnce({ ok: true, postId: "p-new", created: false });
    mount({ openInitial: "post" });
    fireEvent.change(title(), { target: { value: "Retry me" } });
    fireEvent.submit(form("New post"));
    await screen.findByRole("alert");
    fireEvent.submit(form("New post"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][1].id).toBe(create.mock.calls[0][1].id);
  });
});

describe("Extra post", () => {
  it("is flagged as outside the target, and posts isExtra: true", async () => {
    create.mockResolvedValue({ ok: true, postId: "p-x", created: true });
    mount({ openInitial: "extra" });
    expect(screen.getByRole("heading", { name: /Extra post/ })).toHaveTextContent("outside the monthly target");
    fireEvent.change(title(), { target: { value: "Gala evening brief" } });
    fireEvent.submit(form("New extra post"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toBe("cyc-1");
    expect(create.mock.calls[0][1]).toMatchObject({ title: "Gala evening brief", isExtra: true });
    expect(await screen.findByRole("status")).toHaveTextContent("Extra post added, outside the target.");
  });
});
