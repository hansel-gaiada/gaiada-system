import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// M5-W1f: the contributor layout. Server layout: its readers are mocked and the element it returns is inspected.
// A fenced session (no real second factor) gets the two-step notice INSTEAD of the page; a contributor gets the shell around the page.
vi.mock("@/lib/contributorServer", () => ({ contributorCtx: vi.fn() }));
vi.mock("@/components/contributor/ContributorShell", () => ({ ContributorShell: () => null }));
vi.mock("@/components/contributor/AssuranceNotice", () => ({ AssuranceNotice: () => null }));

import { contributorCtx } from "@/lib/contributorServer";
import { AssuranceNotice } from "@/components/contributor/AssuranceNotice";
import ContributorLayout from "./layout";

type Shell = ReactElement<{ userName: string | null; children: ReactElement }>;
beforeEach(() => vi.mocked(contributorCtx).mockReset());

describe("ContributorLayout", () => {
  it("a fenced session sees the notice, and the page is never rendered", async () => {
    vi.mocked(contributorCtx).mockResolvedValue({ kind: "fenced", reason: "assurance_high_required" });
    const page = <div data-testid="page" />;
    const shell = (await ContributorLayout({ children: page })) as Shell;
    expect(shell.props.children.type).toBe(AssuranceNotice);
    expect(shell.props.userName).toBeNull();
  });

  it("a contributor gets the shell around the page", async () => {
    vi.mocked(contributorCtx).mockResolvedValue({ kind: "ok", userId: "u", me: { userId: "u", name: "Ayu", email: "a@x", title: null, assurance: "high", companies: [], roles: [], kind: "contributor" }, company: "c1" });
    const page = <div data-testid="page" />;
    const shell = (await ContributorLayout({ children: page })) as Shell;
    expect(shell.props.children).toBe(page);
    expect(shell.props.userName).toBe("Ayu");
  });
});
