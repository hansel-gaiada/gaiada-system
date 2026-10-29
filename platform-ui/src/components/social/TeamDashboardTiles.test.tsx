import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-5d, SCP-3f: the Team dashboard's pipeline tiles are the Standard Overview's Social Pulse: the same tiles, from ONE `GET overview`, with the same "No access" / "Unavailable"
// (never 0) and the one SIMULATED mark while the server says the tiles count simulated rows. Only the shared reader is mocked: the Pulse's own code runs.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialOverview-data", () => ({ getOverview: vi.fn() }));

import { getOverview } from "@/lib/socialOverview-data";
import type { SocialOverview } from "@/lib/socialOverview";
import type { ReadResult } from "@/lib/readResult";
import type { Me } from "@/lib/platform";
import { TeamDashboardTiles } from "./TeamDashboardTiles";
import { SIMULATED_MARK_NAME } from "./SimulatedMark";

const ME = { userId: "u-1", companies: [{ id: "co-a", vertical: "agency" }] } as unknown as Me;
const overview = vi.mocked(getOverview);
const answer = (over: Partial<SocialOverview["tiles"]> = {}, simulatedIncluded = false): ReadResult<SocialOverview> => ({
  kind: "ok", data: { tiles: { inProduction: 7, withClient: 3, late: 2, scheduledThisWeek: 5, failedPosts: 0, boostsWaiting: 4, ...over }, simulatedIncluded },
});
const mount = async () => render((await TeamDashboardTiles({ me: ME, tenantId: "co-a", deptId: "d-soc" }))!);
const tile = (key: string) => document.querySelector(`[data-tile="${key}"]`) as HTMLElement;

beforeEach(() => { overview.mockReset().mockResolvedValue(answer()); });

describe("TeamDashboardTiles", () => {
  it("draws the six pipeline tiles of the Standard Overview's Social Pulse from ONE read, and no placeholder", async () => {
    await mount();
    expect(overview).toHaveBeenCalledTimes(1);
    expect(overview).toHaveBeenCalledWith("u-1", "co-a");
    const keys = [...document.querySelectorAll("[data-tile]")].map((n) => n.getAttribute("data-tile"));
    expect(keys).toEqual(["in-production", "with-client", "late", "scheduled-this-week", "failed-posts", "boosts-waiting"]);
    expect(tile("in-production")).toHaveTextContent("In production7");
    expect(tile("with-client")).toHaveTextContent("With client3");
    expect(tile("late")).toHaveTextContent("Late2");
    expect(tile("scheduled-this-week")).toHaveTextContent("Scheduled this week5");
    expect(tile("failed-posts")).toHaveTextContent("Failed posts0");
    // Boosts waiting is a real number now (SCP-4d), and the unanswered-inbox placeholder (a ticket) is not drawn.
    expect(tile("boosts-waiting")).toHaveTextContent("Boosts waiting4");
    expect(screen.queryByText(/Unanswered inbox/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pipeline" })).toBeInTheDocument();
  });

  it("opens the same pages the Overview's tiles open", async () => {
    await mount();
    const href = (key: string) => within(tile(key)).getByRole("link").getAttribute("href");
    expect(href("in-production")).toBe("/departments/d-soc/profile");
    expect(href("late")).toBe("/departments/d-soc/profile");
    expect(href("scheduled-this-week")).toBe("/departments/d-soc/calendar");
    expect(href("failed-posts")).toBe("/departments/d-soc/calendar");
    expect(href("boosts-waiting")).toBe("/departments/d-soc/boosts");
  });

  it("carries the SIMULATED mark on every tile while the server says simulated rows are counted, and none when it does not", async () => {
    overview.mockResolvedValue(answer({}, true));
    await mount();
    expect(screen.getAllByRole("img", { name: SIMULATED_MARK_NAME })).toHaveLength(6);
    expect(screen.getAllByText("SIMULATED")).toHaveLength(6);
    document.body.innerHTML = "";
    overview.mockResolvedValue(answer({}, false));
    await mount();
    expect(screen.queryByRole("img", { name: SIMULATED_MARK_NAME })).not.toBeInTheDocument();
  });

  it("says No access for a refused read, on every tile and with no link, never 0", async () => {
    overview.mockResolvedValue({ kind: "forbidden" });
    await mount();
    for (const key of ["in-production", "with-client", "late", "scheduled-this-week", "failed-posts", "boosts-waiting"]) {
      expect(tile(key)).toHaveTextContent("No access");
      expect(within(tile(key)).queryByRole("link")).not.toBeInTheDocument();
      expect(tile(key).textContent).not.toMatch(/\b0\b/);
    }
  });

  it("says Unavailable for a failed read, never 0, and still draws (the dashboard's other sections stand)", async () => {
    overview.mockResolvedValue({ kind: "unavailable", reason: "503" });
    await mount();
    for (const key of ["in-production", "late", "failed-posts", "boosts-waiting"]) {
      expect(tile(key)).toHaveTextContent("Unavailable");
      expect(tile(key).textContent).not.toMatch(/\b0\b/);
    }
  });

  it("a read that throws is Unavailable on every tile, not a crash", async () => {
    overview.mockRejectedValue(new Error("socket hang up"));
    await mount();
    expect(tile("late")).toHaveTextContent("Unavailable");
  });
});
