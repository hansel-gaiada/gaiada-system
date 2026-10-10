import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ItemsPanel } from "./ItemsPanel";
import type { ItemListBody, ItemSummary } from "@/lib/webdeskContentModel";

// WSK-44b — `headCreatedAt` is null for a pre-0009 row (it has no version row), and the real BFF sends that.
const summary = (over: Partial<ItemSummary> = {}): ItemSummary => ({
  itemId: "i1", slug: "service.seo", locale: "en", localizationGroupId: "g", title: "SEO", headVersion: 0, publishedVersion: null, publishState: "draft",
  publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", headCreatedAt: "2026-10-10T08:00:00Z", headCreatedBy: "u1", pendingChanges: false, ...over,
});

const list = (items: ItemSummary[]): ItemListBody => ({ items, page: { cursor: null, hasMore: false, limit: 100 } });
const panel = (items: ItemSummary[]) => (
  <ItemsPanel list={list(items)} locales={["en"]} filters={{}} editorBase="/x/service" authors={{ u1: "Dewi" }} filterAction="/x/service" />
);

describe("ItemsPanel: a pre-0009 row (no head version row) renders — for the last edit, never a crash or a fake date", () => {
  it("shows the author and the edit time when the head row exists", () => {
    render(panel([summary()]));
    const cell = screen.getByText("Dewi").closest("td");
    expect(cell?.getAttribute("title")).toMatch(/^Last edited .*10/);
  });

  it("headCreatedAt null -> 'Last edited —', and the author falls back like any unknown author", () => {
    render(panel([summary({ headCreatedAt: null, headCreatedBy: null })]));
    const row = screen.getByText("service.seo").closest("tr") as HTMLElement;
    const cells = row.querySelectorAll("td");
    expect(cells[cells.length - 1].getAttribute("title")).toBe("Last edited —");
  });
});
