import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConnectionBlocks } from "./ConnectionBlocks";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { SocialAccountsBlock } from "./SocialAccountsBlock";
import { workspaceFor } from "@/lib/workspaces";
import type { SocialAccount } from "@/lib/socialShared";

// The page supplies a block for every kind it can draw; the registry decides which of them show.
const ALL_BLOCKS = {
  github: <p>github block</p>,
  drive: <p>drive block</p>,
  "claude-seats": <p>seats block</p>,
  "google-accounts": <p>google block</p>,
  "social-accounts": <p>social block</p>,
  figma: <p>figma block</p>,
};

function headings(vertical: string | null, dept: string): string[] {
  const { unmount } = render(<ConnectionBlocks workspace={workspaceFor(vertical, dept)} blocks={ALL_BLOCKS} />);
  const out = screen.queryAllByRole("heading", { level: 4 }).map((h) => h.textContent ?? "");
  unmount();
  return out;
}

describe("ConnectionBlocks: the kinds each workspace draws", () => {
  it("Web Dev: GitHub, Google Drive, Claude seats (Figma is ticketed, so hidden)", () => {
    expect(headings("agency", "Web Dev")).toEqual(["GitHub", "Google Drive", "Claude seats"]);
  });
  it("SEO: Google accounts, Drive, seats", () => {
    expect(headings("agency", "SEO")).toEqual(["Google accounts (Search Console, GA4, Ads)", "Google Drive", "Claude seats"]);
  });
  it("Social Media: social accounts, Drive, seats", () => {
    expect(headings("agency", "Social Media")).toEqual(["Social accounts", "Google Drive", "Claude seats"]);
  });
  it("Creatives: Drive, seats (Figma is hidden)", () => {
    expect(headings("agency", "Creatives")).toEqual(["Google Drive", "Claude seats"]);
  });
  it("Office of the GM: Drive, seats", () => {
    expect(headings("agency", "GM")).toEqual(["Google Drive", "Claude seats"]);
  });
  it("a generic department: Drive only", () => {
    expect(headings(null, "Housekeeping")).toEqual(["Google Drive"]);
  });

  it("never draws a ticketed kind, even when a block is supplied for it", () => {
    render(<ConnectionBlocks workspace={workspaceFor("agency", "Web Dev")} blocks={ALL_BLOCKS} />);
    expect(screen.queryByText("figma block")).toBeNull();
  });

  it("skips a kind the page has no block for rather than drawing an empty one", () => {
    render(<ConnectionBlocks workspace={workspaceFor("agency", "Web Dev")} blocks={{ drive: <p>drive block</p> }} />);
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Google Drive"]);
  });
});

describe("ConnectionsPanel `only`", () => {
  const noop = vi.fn().mockResolvedValue({ ok: true });
  const actions = { connect: noop, update: noop, revoke: noop, mapSeat: noop, updateSeat: noop, unmapSeat: noop };

  it("renders just the named rows and no note", () => {
    const { container } = render(<ConnectionsPanel actions={actions} only={["drive"]} />);
    expect(container.querySelectorAll("li.dept-conn-row")).toHaveLength(1);
    expect(screen.getByLabelText("Google Drive account")).toBeInTheDocument();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
    expect(screen.queryByText(/account mappings/)).toBeNull();
  });

  it("renders all three rows and the note when `only` is left off (classic)", () => {
    const { container } = render(<ConnectionsPanel actions={actions} />);
    expect(container.querySelectorAll("li.dept-conn-row")).toHaveLength(3);
    expect(screen.getByText(/account mappings/)).toBeInTheDocument();
  });
});

describe("SocialAccountsBlock", () => {
  const acct = { id: "a1", clientId: "c1", network: "linkedin", handle: "@gaiada", status: "connected" } as unknown as SocialAccount;

  it("lists network, handle and status, read-only", () => {
    render(<SocialAccountsBlock accounts={[acct]} />);
    expect(screen.getByText("linkedin")).toBeInTheDocument();
    expect(screen.getByText("@gaiada")).toBeInTheDocument();
    expect(screen.getByText(/^connected$/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says 'none' only for a confirmed empty read", () => {
    render(<SocialAccountsBlock accounts={[]} />);
    expect(screen.getByText("No social accounts are connected yet.")).toBeInTheDocument();
  });

  it("says 'unavailable', never 'none', when the read failed or was denied", () => {
    const { rerender } = render(<SocialAccountsBlock accounts={null} />);
    expect(screen.getByText(/unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No social accounts/)).toBeNull();
    rerender(<SocialAccountsBlock accounts={[]} forbidden />);
    expect(screen.getByText(/unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No social accounts/)).toBeNull();
  });
});
