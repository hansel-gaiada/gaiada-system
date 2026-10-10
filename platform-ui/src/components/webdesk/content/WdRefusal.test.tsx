import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import type { WdResult } from "@/lib/webdeskContentModel";
import { WdRefusal } from "./WdRefusal";

type Refusal = Exclude<WdResult<unknown>, { kind: "ok" }>;
const draw = (r: Refusal) => render(<WdRefusal result={r} subject="this item" retryHref="/retry" />).container;

describe("WdRefusal: every non-ok result is its own full-page state", () => {
  it.each<[string, Refusal]>([
    ["editorial_unavailable", { kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" }],
    ["network", { kind: "unavailable", code: "network", reason: "ECONNREFUSED" }],
    ["upstream_error", { kind: "unavailable", code: "upstream_error", reason: "boom" }],
  ])("%s: the notice, and NEVER a list or a form", (_n, r) => {
    const c = draw(r);
    expect(c.querySelector('[data-testid="wd-editorial-unavailable"]')?.textContent).toMatch(/Editing is unavailable.*WebDesk can't be reached\. Nothing has been lost\./);
    expect(c.querySelectorAll("table, form, input, textarea, select, ul, ol")).toHaveLength(0);
    expect(c.querySelector("a")?.getAttribute("href")).toBe("/retry");
  });

  it("contract drift is a louder, different notice that says it is NOT an empty site, and names the path", () => {
    const c = draw({ kind: "unavailable", code: "contract_drift", reason: "sites.tenants[0].defaultLocale: expected string, got missing" });
    const n = c.querySelector('[data-testid="wd-contract-drift"]');
    expect(n?.textContent).toMatch(/does not mean this item is empty/);
    expect(n?.textContent).toContain("defaultLocale");
    expect(c.querySelector('[data-testid="wd-editorial-unavailable"]')).toBeNull();
  });

  it("forbidden reuses ReadRefusal ('you don't have access'), with no hedge about existence", () => {
    expect(draw({ kind: "forbidden", reason: "x" }).textContent).toMatch(/don't have access to this item/);
  });

  it("not enabled: module off vs endpoint not served are different sentences", () => {
    expect(draw({ kind: "not_enabled", reason: "module_disabled" }).textContent).toMatch(/switched off.*Nothing has been deleted/);
    expect(draw({ kind: "not_enabled", reason: "not_served" }).textContent).toMatch(/Backend pending.*isn't served by this deployment yet/);
  });

  it("not_found names what is missing", () => {
    expect(draw({ kind: "not_found", slug: "item-not-found" }).textContent).toContain("That item does not exist");
    expect(draw({ kind: "not_found", slug: "collection-not-found" }).textContent).toContain("That collection does not exist");
    expect(draw({ kind: "not_found", slug: "site-not-found" }).textContent).toContain("not one of your company's");
  });
});
