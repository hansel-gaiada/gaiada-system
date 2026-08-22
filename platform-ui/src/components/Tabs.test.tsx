import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/departments/web-dev/board" }));

import { Tabs, GroupedTabs } from "./Tabs";

describe("Tabs", () => {
  it("marks the deepest-prefix-matching tab active", () => {
    render(
      <Tabs
        tabs={[
          { key: "home", label: "Home", href: "/departments/web-dev" },
          { key: "board", label: "Board", href: "/departments/web-dev/board" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});

describe("GroupedTabs", () => {
  it("renders a secondary strip only when the active group has more than one tab", () => {
    render(
      <GroupedTabs
        groups={[
          { key: "home", label: "Home", tabs: [{ key: "home", label: "Home", href: "/departments/web-dev" }] },
          {
            key: "work",
            label: "Work",
            tabs: [
              { key: "board", label: "Board", href: "/departments/web-dev/board" },
              { key: "timeline", label: "Timeline", href: "/departments/web-dev/timeline" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Work" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation", { name: "Work Tools" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  });
});
