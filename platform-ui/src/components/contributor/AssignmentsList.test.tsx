import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AssignmentsView } from "@/lib/contributorModel";
import { ASSURANCE_NOTICE_TITLE } from "@/lib/contributorRouting";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
import { AssignmentsList } from "./AssignmentsList";

afterEach(cleanup);

// M5-W1f: the screen draws every state of the view; the two-step notice is the whole screen, never a list.
describe("AssignmentsList", () => {
  it("assurance_high_required shows the two-step notice and no list", () => {
    render(<AssignmentsList view={{ kind: "assurance", reason: "assurance_high_required" }} />);
    expect(screen.getByTestId("assurance-notice").textContent).toContain("Your two-step sign-in isn't set up yet");
    expect(ASSURANCE_NOTICE_TITLE).toBe("Your two-step sign-in isn't set up yet");
    expect(screen.queryByTestId("assignment-row")).toBeNull();
    expect(screen.queryByTestId("assignments-none")).toBeNull();
  });

  it("a refused or unreachable read is words, and shows no 'nothing assigned'", () => {
    const { rerender } = render(<AssignmentsList view={{ kind: "refused", message: "No role here" }} />);
    expect(screen.getByTestId("assignments-refused").textContent).toBe("No role here");
    rerender(<AssignmentsList view={{ kind: "unavailable", message: "Cannot reach" }} />);
    expect(screen.getByTestId("assignments-unavailable").textContent).toBe("Cannot reach");
    expect(screen.queryByTestId("assignments-none")).toBeNull();
  });

  it("lists rows with links to the contributor editor", () => {
    const view: AssignmentsView = { kind: "ok", sections: [{
      kind: "items", tenantSlug: "t", siteId: "s", siteName: "gaiada.com", more: false, others: [],
      mine: [{ itemId: "i1", title: "Post 1", collectionKey: "blog", locale: "en", slug: "p1", state: "draft", headVersion: 1, dueAt: null, href: "/contributor/items/t/s/blog/p1?locale=en", mine: true }],
    }] };
    render(<AssignmentsList view={view} />);
    expect(screen.getByText("Post 1").closest("a")?.getAttribute("href")).toBe("/contributor/items/t/s/blog/p1?locale=en");
    expect(screen.getByText("Assigned to you")).toBeTruthy();
  });

  it("an answered, empty site says nothing is assigned; a refused site says so separately", () => {
    render(<AssignmentsList view={{ kind: "ok", sections: [
      { kind: "none", tenantSlug: "t", siteId: "a", siteName: "A" },
      { kind: "refused", tenantSlug: "t", siteId: "b", siteName: "B", message: "No role on B" },
    ] }} />);
    expect(screen.getByTestId("assignments-none")).toBeTruthy();
    expect(screen.getByTestId("site-refused").textContent).toBe("No role on B");
  });
});
