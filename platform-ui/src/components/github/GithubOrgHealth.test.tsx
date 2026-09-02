import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GithubOrgHealth } from "./GithubOrgHealth";
import type { GetGithubOrgStatusResult } from "@/lib/githubOrgStatus-data";
import type { GithubOrgStatus } from "@/lib/githubOrgStatus";

const OK_STATUS: GithubOrgStatus = {
  org: { login: "gaiadabali", tenantId: "co-agency", tenantName: "Gaia Digital Agency" },
  apps: [
    { role: "erp", slug: "gaiada-erp", readOnly: false, configured: true, externalAccount: "gaiadabali", status: "linked", hasToken: true, tokenExpiresAt: "2026-12-01T00:00:00Z" },
    { role: "agents", slug: "gaiada-agents", readOnly: true, configured: false, externalAccount: null, status: "unconfigured", hasToken: false, tokenExpiresAt: null },
  ],
  sync: { asOf: "2026-09-02T10:00:00Z", lastRepoSyncAt: "2026-09-02T09:00:00Z", lastWebhookReceivedAt: "2026-09-02T08:00:00Z", lastWebhookErrorClass: null },
};

// GHT-2/GHT-3 — this is the ORG APP's health, a different fact than the viewer's own personal
// `owner:"me"` link (RepoInventory.tsx's GithubLine, tested separately). Every ok/failure branch
// must render as ITSELF: the crux of the ticket applied to this smaller widget too.
describe("GithubOrgHealth", () => {
  it("renders both apps' status and never claims a live check for the sync facts", () => {
    render(<GithubOrgHealth result={{ ok: true, data: OK_STATUS }} />);
    expect(screen.getByText(/ERP App: Linked/)).toBeInTheDocument();
    expect(screen.getByText(/Agents App: Not configured/)).toBeInTheDocument();
    // "last known" / "not checked live just now" language — never phrased as a live probe.
    expect(screen.getByText(/not checked live just now/i)).toBeInTheDocument();
  });

  it("never renders token material — hasToken is a boolean and the type carries no ciphertext field", () => {
    const { container } = render(<GithubOrgHealth result={{ ok: true, data: OK_STATUS }} />);
    expect(container.textContent).not.toMatch(/access_token|refresh_token|_enc\b|-----BEGIN/i);
  });

  it("renders no_org distinctly from unavailable and from refused — three different sentences", () => {
    const { rerender } = render(<GithubOrgHealth result={{ ok: false, reason: "no_org" } as GetGithubOrgStatusResult} />);
    const noOrgText = screen.getByText(/configuration gap, not an outage/i).textContent;

    rerender(<GithubOrgHealth result={{ ok: false, reason: "unavailable" } as GetGithubOrgStatusResult} />);
    const unavailableText = screen.getByText(/not reachable right now/i).textContent;

    rerender(<GithubOrgHealth result={{ ok: false, reason: "refused" } as GetGithubOrgStatusResult} />);
    const refusedText = screen.getByText(/not authorized/i).textContent;

    expect(noOrgText).not.toBe(unavailableText);
    expect(unavailableText).not.toBe(refusedText);
    expect(noOrgText).not.toBe(refusedText);
  });

  it("the no_org copy never reads like a retryable outage", () => {
    render(<GithubOrgHealth result={{ ok: false, reason: "no_org" } as GetGithubOrgStatusResult} />);
    expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
  });
});
