import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { GoogleConnectionsPanel } from "./GoogleConnectionsPanel";
import type { GoogleConnectionView } from "@/lib/searchMarketingShared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// SM-25a's Connections tab — pins §A12.3's honesty rule: the Connections surface MUST render
// issuerHost whenever issuerIsGoogle is false, and must render NOTHING extra when it IS Google
// (both must be exercisable in one render, never a fixture that only shows one).

const realGoogle: GoogleConnectionView = {
  id: "conn-1", provider: "google_search_console", clientId: "cl-2", status: "linked",
  hasToken: true, hasRefreshToken: true, tokenExpiresAt: "2026-08-30T00:00:00Z",
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  externalAccount: "seo@cedargroup.example.com", issuerHost: "accounts.google.com", issuerIsGoogle: true,
};
const nonGoogle: GoogleConnectionView = {
  id: "conn-2", provider: "google_analytics", clientId: "cl-2", status: "linked",
  hasToken: true, hasRefreshToken: true, tokenExpiresAt: "2026-08-30T00:00:00Z",
  scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  externalAccount: "dev-sandbox@cedargroup.example.com", issuerHost: "keycloak.gaiada.local:8443", issuerIsGoogle: false,
};
const revoked: GoogleConnectionView = {
  id: "conn-3", provider: "google_ads", clientId: "cl-2", status: "revoked",
  hasToken: false, hasRefreshToken: false, tokenExpiresAt: null,
  scopes: [], externalAccount: "old@cedargroup.example.com", issuerHost: "accounts.google.com", issuerIsGoogle: true,
};

describe("GoogleConnectionsPanel", () => {
  it("empty state — 'no accounts connected yet', never a blank table", () => {
    render(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[]} clients={[]} properties={[]} canManage={false} />,
    );
    expect(screen.getByText(/No Search Console, GA4 or Ads accounts connected yet/i)).toBeInTheDocument();
  });

  it("renders issuerHost for the NON-Google connection", () => {
    render(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[nonGoogle]} clients={[]} properties={[]} canManage={false} />,
    );
    expect(screen.getByText(/keycloak\.gaiada\.local:8443/)).toBeInTheDocument();
    expect(screen.getByText(/Non-Google issuer/i)).toBeInTheDocument();
  });

  it("discloses NOTHING extra for a real Google connection — presence AND absence in the same render", () => {
    render(
      <GoogleConnectionsPanel
        tenantId="t1" returnPath="/departments/dept-3/connections"
        connections={[realGoogle, nonGoogle]} clients={[]} properties={[]} canManage={false}
      />,
    );
    // Exactly one disclosure line exists (the non-Google row's) even though two connections render.
    expect(screen.getAllByText(/Non-Google issuer/i).length).toBe(1);
    expect(screen.queryByText(/accounts\.google\.com/)).not.toBeInTheDocument();
  });

  it("status renders verbatim — a revoked connection stays listed, not hidden", () => {
    render(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[revoked]} clients={[]} properties={[]} canManage={false} />,
    );
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("hides Refresh/Revoke and the Connect form when canManage is false", () => {
    render(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[realGoogle]} clients={[{ id: "cl-2", name: "Cedar Group" }]} properties={[]} canManage={false} />,
    );
    expect(screen.queryByText("Refresh")).not.toBeInTheDocument();
    expect(screen.queryByText("Revoke")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("shows Refresh/Revoke and the Connect form when canManage is true", () => {
    render(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[realGoogle]} clients={[{ id: "cl-2", name: "Cedar Group" }]} properties={[]} canManage={true} />,
    );
    expect(screen.getByText("Refresh")).toBeInTheDocument();
    expect(screen.getByText("Revoke")).toBeInTheDocument();
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("shows a one-line status after the OAuth callback redirect — connected/denied/error each render distinct text", () => {
    const { rerender } = render(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[]} clients={[]} properties={[]} canManage={false} oauthStatus="connected" />,
    );
    expect(screen.getByText(/^Connected\.$/)).toBeInTheDocument();

    rerender(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[]} clients={[]} properties={[]} canManage={false} oauthStatus="denied" oauthDetail="access_denied" />,
    );
    expect(screen.getByText(/Connection not completed — access_denied/)).toBeInTheDocument();

    rerender(
      <GoogleConnectionsPanel tenantId="t1" returnPath="/departments/dept-3/connections" connections={[]} clients={[]} properties={[]} canManage={false} oauthStatus="error" oauthDetail="issuer refused" />,
    );
    expect(screen.getByText(/Connection failed — issuer refused/)).toBeInTheDocument();
  });
});
