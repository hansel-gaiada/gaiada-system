import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WebdeskArchiveRequestSummary } from "./WebdeskArchiveRequestSummary";

const ARGS = { command: "site.archive", tenantSlug: "gaiada", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", summary: { title: "x" }, commandHash: "h" };

describe("WebdeskArchiveRequestSummary", () => {
  it("names the site (display name plus id), says what approving does, and that it cannot be undone", () => {
    render(<WebdeskArchiveRequestSummary toolArgs={ARGS} siteName="gaiada.com" />);
    expect(screen.getByRole("heading", { name: "Site archive request" })).toBeTruthy();
    expect(screen.getByTestId("archive-summary-site").textContent).toContain("gaiada.com");
    expect(screen.getByTestId("archive-summary-site").textContent).toContain(ARGS.siteId);
    expect(screen.getByTestId("archive-summary-tenant").textContent).toBe("gaiada");
    expect(screen.getByTestId("archive-summary-irreversible").textContent).toMatch(/cannot be undone/);
    expect(screen.getByTestId("archive-summary-effects").textContent).toMatch(/stops serving content/);
  });

  it("shows the site id when the name could not be read (cosmetic read failed)", () => {
    render(<WebdeskArchiveRequestSummary toolArgs={ARGS} siteName={null} />);
    expect(screen.getByTestId("archive-summary-site").textContent).toBe(ARGS.siteId);
  });

  it.each<[string, unknown]>([
    ["not an object", "x"],
    ["the wrong command", { ...ARGS, command: "key.mint" }],
    ["no tenantSlug", { command: "site.archive", siteId: ARGS.siteId }],
    ["no siteId", { command: "site.archive", tenantSlug: "gaiada" }],
    ["a non-string siteId", { ...ARGS, siteId: 7 }],
  ])("arguments in the wrong format (%s) are flagged as unrecognised, never summarised", (_n, toolArgs) => {
    render(<WebdeskArchiveRequestSummary toolArgs={toolArgs} siteName="gaiada.com" />);
    expect(screen.getByTestId("archive-summary-unrecognised").textContent).toMatch(/Unrecognised request/);
    expect(screen.queryByTestId("archive-summary")).toBeNull();
  });
});
