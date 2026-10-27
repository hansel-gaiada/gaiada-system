import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
// SCP-2e and 2f, the staff half: how the client's latest decision reached us, and the link we send the client while the post waits on them.
import { ClientDecisionLine, ClientLink, clientDecisionText, clientLinkPath, whatsappShareHref } from "./PostClient";
import { asPipelinePost, type ClientDecision } from "@/lib/socialPipeline";

const base: ClientDecision = {
  decisionId: "d-1", kind: "approved", changeKind: null, note: null, decidedAt: "2026-10-27T06:30:00Z",
  via: "portal", channel: null, decidedBy: { id: "c-1", name: "Rina Contact" }, recordedBy: null,
};

afterEach(() => vi.restoreAllMocks());

describe("the client's decision", () => {
  it("names the contact for a decision given in the portal", () => {
    expect(clientDecisionText(base)).toMatch(/^How the client decided: approved in the portal \(Rina Contact\), /);
  });
  it("names the member of staff and the channel for a recorded decision, and the change kind", () => {
    const text = clientDecisionText({
      ...base, kind: "changes", changeKind: "design", via: "recorded", channel: "whatsapp", decidedBy: null, recordedBy: { id: "u-1", name: "Officer One" },
    });
    expect(text).toMatch(/^How the client decided: asked for a design change outside the portal by WhatsApp; Officer One recorded it on the client's behalf, /);
  });
  it("says a copy change, and a meeting, in words", () => {
    expect(clientDecisionText({ ...base, kind: "changes", changeKind: "copy", via: "recorded", channel: "meeting", decidedBy: null, recordedBy: null }))
      .toMatch(/^How the client decided: asked for a copy change outside the portal by a meeting; recorded on the client's behalf/);
  });
  it("draws nothing before a decision", () => {
    const { container } = render(<ClientDecisionLine decision={null} />);
    expect(container.textContent).toBe("");
  });
  it("is read from the post read's clientDecision, and is null when absent or malformed", () => {
    const raw = { id: "p-1", pipelineStatus: "approved" };
    expect(asPipelinePost(raw).clientDecision).toBeNull();
    expect(asPipelinePost({ ...raw, clientDecision: { kind: "approved" } }).clientDecision).toBeNull();
    const d = asPipelinePost({
      ...raw,
      clientDecision: { decisionId: "d-2", kind: "changes", changeKind: "copy", note: "Fix the price", decidedAt: "2026-10-27T06:30:00Z", via: "recorded", channel: "email", decidedBy: null, recordedBy: { id: "u-1", name: "Officer One" } },
    }).clientDecision;
    expect(d).toMatchObject({ decisionId: "d-2", kind: "changes", changeKind: "copy", via: "recorded", channel: "email", recordedBy: { name: "Officer One" } });
  });
});

describe("the client's link", () => {
  it("is the portal approval page for this post", () => {
    expect(clientLinkPath("p 1")).toBe("/portal/social?post=p%201");
  });
  it("shares to WhatsApp with the post's title and the link in the text", () => {
    const href = whatsappShareHref("https://erp.example/portal/social?post=p-1", "Autumn teaser");
    expect(href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(href.slice("https://wa.me/?text=".length))).toBe("A post is ready for your approval: Autumn teaser. https://erp.example/portal/social?post=p-1");
  });
  it("shows the absolute link, copies it, and says so", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ClientLink postId="p-1" title="Autumn teaser" />);
    const input = screen.getByRole("textbox", { name: "The client's link" }) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(`${window.location.origin}/portal/social?post=p-1`));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Link copied."));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/portal/social?post=p-1`);
    expect(screen.getByRole("link", { name: "Share on WhatsApp" }).getAttribute("href")).toContain(encodeURIComponent(`${window.location.origin}/portal/social?post=p-1`));
  });
  it("says so when the copy fails, and the link stays selectable", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    render(<ClientLink postId="p-1" title="" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not copy"));
  });
});
