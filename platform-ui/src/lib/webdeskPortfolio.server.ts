import "server-only";
import { platformFetch } from "./platform";
import type { PortfolioResult } from "./webdeskPortfolio";

// Server-only network read for the estate portfolio, split out of `webdeskPortfolio.ts` so that
// file can stay client-safe (the `PortfolioPanel` client component imports its types and helpers).
// Backend contract: docs/FRONTEND-BFF-CONTRACT.md §24 — GET /api/:t/modules/webdev/console/portfolio.
export async function fetchPortfolio(userId: string, tenant: string): Promise<PortfolioResult> {
  return platformFetch<PortfolioResult>(`/api/${tenant}/modules/webdev/console/portfolio`, userId);
}
