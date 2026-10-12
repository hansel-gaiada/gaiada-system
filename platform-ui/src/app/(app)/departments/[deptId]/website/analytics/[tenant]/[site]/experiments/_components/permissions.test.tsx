import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// A user who can read but not update sees no register form and none of the four actions.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/experimentsActions", () => ({
  registerExperimentAction: vi.fn(), syncExperimentAction: vi.fn(), stopExperimentAction: vi.fn(), abortExperimentAction: vi.fn(), decideExperimentAction: vi.fn(),
}));

import { ExperimentActions } from "./ExperimentActions";
import { ExperimentsView } from "./ExperimentsView";

describe("read-only users", () => {
  it("no actions in any status", () => {
    for (const status of ["draft", "running", "stopped"] as const) {
      const { container, unmount } = render(<ExperimentActions propertyId="p" experimentId="e" status={status} canUpdate={false} />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });
  it("no register form, but the list is still there", () => {
    render(<ExperimentsView siteName="s" analyticsHref="/a" hrefBase="/a/experiments" propertyId="p" tenantSlug="t" siteId="x" canUpdate={false} experiments={[]} />);
    expect(screen.queryByTestId("exp-register")).toBeNull();
    expect(screen.getByTestId("exp-empty")).toBeTruthy();
  });
});
