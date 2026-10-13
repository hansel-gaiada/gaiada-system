import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// PV4-08 — the shared meeting notes page: title, date, "Shared on <date> by <name>", and a body rendered by the
// portal's safe Markdown renderer (ArtifactMarkdown, as the contract page does), never as HTML.
const notFoundMock = vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); });
vi.mock("next/navigation", () => ({
  notFound: () => notFoundMock(), redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Example" })) }));
const getPortalMeeting = vi.fn();
vi.mock("@/lib/portal-data", () => ({ getPortalMeeting: (...a: unknown[]) => getPortalMeeting(...a) }));

import PortalMeetingPage from "./page";

beforeEach(() => { getPortalMeeting.mockReset(); notFoundMock.mockClear(); });

const minutes = {
  id: "m1", title: "Kickoff call", meetingDate: "2026-10-05T09:00:00Z", sharedAt: "2026-10-06T08:00:00Z", sharedBy: "Made Prabowo",
  bodyMd: "## Decisions\n\n- Launch in **November**\n\n<script>window.__pwned = 1</script>",
};

describe("PortalMeetingPage", () => {
  it("shows the title, the meeting date, who shared it and when", async () => {
    getPortalMeeting.mockResolvedValue(minutes);
    render(await PortalMeetingPage({ params: Promise.resolve({ minutesId: "m1" }) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kickoff call");
    expect(screen.getByText("05 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("Shared on 06 Oct 2026 by Made Prabowo")).toBeInTheDocument();
    expect(getPortalMeeting).toHaveBeenCalledWith("u1", "co-1", "m1");
  });

  it("renders bodyMd through the safe renderer: formatting works, a script tag is only text", async () => {
    getPortalMeeting.mockResolvedValue(minutes);
    const { container } = render(await PortalMeetingPage({ params: Promise.resolve({ minutesId: "m1" }) }));
    expect(container.querySelector(".pl-md")).not.toBeNull();
    expect(screen.getByText("November").tagName).toBe("STRONG");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>window.__pwned = 1</script>");
  });

  it("an unknown, draft or out-of-scope id (null from the BFF) is a 404", async () => {
    getPortalMeeting.mockResolvedValue(null);
    await expect(PortalMeetingPage({ params: Promise.resolve({ minutesId: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
