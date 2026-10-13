import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PageContextChip } from "./PageContextChip";
import type { PinnedPageContext } from "@/lib/assistant";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/assistantActions", () => ({ resolveCitationAction: vi.fn() }));

const pinned: PinnedPageContext = { ref: "erp:project:p-web-1", kind: "project", label: "Client site redesign", href: "/projects/p-web-1" };

// DW-2h — the chip also says which department and page the person came from.
describe("PageContextChip", () => {
  it("shows the department and page, as a plain label", () => {
    render(<PageContextChip originLabel="Web Dev · Board" />);
    expect(screen.getByText("Web Dev · Board")).toBeInTheDocument();
    // It announces where it comes from, and is not a control.
    expect(screen.getByText("Opened from")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the department beside the pinned entity when both exist", () => {
    render(<PageContextChip context={pinned} originLabel="Web Dev" />);
    expect(screen.getByText("Web Dev")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pinned: Client site redesign" })).toBeInTheDocument();
  });

  it("is today's chip with no department: just the pin", () => {
    render(<PageContextChip context={pinned} />);
    expect(screen.getByRole("button", { name: "Pinned: Client site redesign" })).toBeInTheDocument();
    expect(screen.queryByText("Opened from")).not.toBeInTheDocument();
  });
});
