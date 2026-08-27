import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { DegradeBanner } from "./DegradeBanner";
import type { DegradeMeta } from "@/lib/webdesk";

// THE REQUIRED TEST (WSK-24's own instruction): assert the stale/degraded state is VISIBLE, not
// merely that the component renders without throwing. WSK-23's finding is that three of the four
// WebDesk console reads are ALWAYS stale — a console that renders that silently (or only shows a
// banner "sometimes") is the "confident wrong answer" failure this whole ticket exists to refuse to
// ship. Every assertion below reads the ACTUAL rendered text/attributes a person or an a11y tree
// would see, not just presence-of-a-div.
describe("DegradeBanner — staleness is visible, not merely rendered", () => {
  it("renders stale:true honestly: the ALWAYS-true case for sites/releases/submissions", () => {
    const meta: DegradeMeta = {
      stale: true,
      source: "facts",
      asOf: "2026-08-25T10:00:00Z",
      reason: "zone_b_has_no_live_environment_status_read_endpoint_yet",
    };
    render(<DegradeBanner meta={meta} subject="this site registry" />);

    // 1) The role/attributes an assistive-tech user or an automated a11y check would see.
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-stale", "true");
    expect(banner).toHaveAttribute("data-source", "facts");

    // 2) The actual copy a sighted user reads — not a raw token, the plain-language explanation.
    expect(screen.getByText(/Zone A facts/i)).toBeInTheDocument();
    expect(screen.getByText(/WebDesk doesn.t push live status yet/i)).toBeInTheDocument();
    // 3) The "as of" timestamp is present — a stale read must say WHEN it's current as of, not
    //    just that it's stale.
    expect(screen.getByText(/As of/i)).toBeInTheDocument();

    // It must NOT claim to be live.
    expect(screen.queryByText(/^Live from WebDesk\.?$/)).not.toBeInTheDocument();
  });

  it("renders the genuinely-unavailable case distinctly from a confirmed-empty read (asOf: null)", () => {
    const meta: DegradeMeta = { stale: true, source: "unavailable", asOf: null, reason: "control_channel_egress_error" };
    render(<DegradeBanner meta={meta} subject="the latest published contract version" />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-source", "unavailable");
    // No "as of" claim at all when there's genuinely nothing on file — the honest "we do not know"
    // wording from lib/webdesk.ts's own DegradeMeta contract, never a fabricated timestamp.
    expect(screen.getByText(/No data on file yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/As of/i)).not.toBeInTheDocument();
  });

  it("renders the rare live case distinctly, so 'stale' isn't the only state a viewer can ever see", () => {
    const meta: DegradeMeta = { stale: false, source: "live", asOf: "2026-08-27T09:00:00Z", reason: "live_control_channel_read" };
    render(<DegradeBanner meta={meta} subject="the latest published contract version" />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-stale", "false");
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText(/Live from WebDesk\./i)).toBeInTheDocument();
  });
});
