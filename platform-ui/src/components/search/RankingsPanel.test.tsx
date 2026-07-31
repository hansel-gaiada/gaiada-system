import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RankingsPanel } from "./RankingsPanel";
import type { RankSnapshot } from "@/lib/searchMarketingShared";

// Stub next/navigation the same way Board.test.tsx/Contributors.test.tsx do — this renders outside
// an app-router mount, and the panel only needs `router.refresh()` after a write.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// SM-14's Rankings tab — pins the three provenance states (real / simulated / not-yet-pulled), the
// "— never 0" position convention for a genuinely not-found capture, and the dropped indicator. A
// fixture where every row is one state proves nothing — this suite exercises presence AND absence
// of each signal in the SAME render, per the house rule ("a fixture where everything is clean proves
// nothing").

const real: RankSnapshot = {
  id: "r1", keywordId: "k1", keyword: "seo audit tools", engine: "google", device: "desktop",
  locationCode: 2360, capturedAt: "2026-07-22T03:00:00Z", position: 9, rankedUrl: "https://cedargroup.example.com/tools",
  serpFeatures: null, provider: "dataforseo", simulated: false,
};
const simulated: RankSnapshot = {
  id: "r2", keywordId: "k2", keyword: "seo audit checklist", engine: "google", device: "desktop",
  locationCode: 2360, capturedAt: "2026-07-29T03:00:00Z", position: 3, rankedUrl: "https://cedargroup.example.com/checklist",
  serpFeatures: null, provider: "dataforseo", simulated: true,
};
const notFound: RankSnapshot = {
  id: "r3", keywordId: "k3", keyword: "technical seo checklist", engine: "google", device: "mobile",
  locationCode: 2360, capturedAt: "2026-07-29T03:10:00Z", position: null, rankedUrl: null,
  serpFeatures: null, provider: "dataforseo", simulated: false,
};
const olderReal: RankSnapshot = {
  id: "r0", keywordId: "k1", keyword: "seo audit tools", engine: "google", device: "desktop",
  locationCode: 2360, capturedAt: "2026-07-15T03:00:00Z", position: 5, rankedUrl: "https://cedargroup.example.com/tools",
  serpFeatures: null, provider: "dataforseo", simulated: false,
};

describe("RankingsPanel", () => {
  it("empty state reads 'no rank captures yet', never a table of zeros", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[]} canManage={false} />);
    expect(screen.getByText(/No rank captures yet/i)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("a REAL row carries no Simulated chip", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[real]} canManage={false} />);
    expect(screen.getByText("seo audit tools")).toBeInTheDocument();
    expect(screen.queryByText("Simulated")).not.toBeInTheDocument();
  });

  it("a SIMULATED row carries the Simulated chip — presence AND absence exercised in one render", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[real, simulated]} canManage={false} />);
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    // exactly one chip — the real row must not also carry one
    expect(screen.getAllByText("Simulated").length).toBe(1);
  });

  it("a genuinely not-found capture renders '— (not found)', never '0' or an error", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[notFound]} canManage={false} />);
    expect(screen.getByText(/— \(not found\)/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("a found -> worse-position regression is flagged 'dropped'", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[olderReal, real]} canManage={false} />);
    expect(screen.getByText(/dropped/i)).toBeInTheDocument();
  });

  it("a single, first-ever capture is never flagged dropped", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[real]} canManage={false} />);
    expect(screen.queryByText(/dropped/i)).not.toBeInTheDocument();
  });

  it("hides the 'Pull ranks now' write affordance when canManage is false", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[real]} canManage={false} />);
    expect(screen.queryByText(/Pull ranks now/i)).not.toBeInTheDocument();
  });

  it("shows the 'Pull ranks now' write affordance when canManage is true", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[real]} canManage={true} />);
    expect(screen.getByText(/Pull ranks now/i)).toBeInTheDocument();
  });

  it("renders the provider label next to a provider-sourced position", () => {
    render(<RankingsPanel tenantId="t1" engagementId="eng-1" snapshots={[real]} canManage={false} />);
    expect(screen.getByText(/DataForSEO/)).toBeInTheDocument();
  });
});
