import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { IncomingRequestsTable } from "./IncomingRequestsTable";
import { DeliveredRequestsTable } from "./DeliveredRequestsTable";
import type { RequestRow } from "@/lib/requests";

const row = (over: Partial<RequestRow> & { id: string }): RequestRow => ({
  kind: "assets", title: "Banners", status: "open", neededBy: null, createdAt: "2026-10-01T00:00:00Z", closedAt: null,
  fromUnit: { id: "d-mkt", name: "Marketing", unitMissing: false }, toUnit: { id: "d-cre", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u1", name: "Ayu" }, campaign: { id: "c1", name: "Spring launch", partId: "p1" },
  work: { state: "live", work: { type: "pm_task", id: "t1", projectId: null, status: "in_progress", isDone: false, responsibleName: "Rini" } },
  assetCount: 3, ...over,
});

describe("IncomingRequestsTable", () => {
  const now = new Date(2026, 9, 14, 12);
  it("links the title to the request and shows from, person, campaign, work and age", () => {
    render(<IncomingRequestsTable rows={[row({ id: "r-1", title: "<b>Hero</b>" })]} now={now} />);
    expect(screen.getByRole("link", { name: "<b>Hero</b>" })).toHaveAttribute("href", "/requests/r-1");
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    expect(screen.getByText("Ayu")).toBeInTheDocument();
    expect(screen.getByText("Spring launch")).toBeInTheDocument();
    expect(screen.getByText(/In progress\. Responsible: Rini/)).toBeInTheDocument();
    expect(screen.getByText("13 days")).toBeInTheDocument();
  });
  it("marks an overdue needed-by date in words", () => {
    render(<IncomingRequestsTable rows={[row({ id: "r-1", neededBy: "2026-10-10" })]} now={now} />);
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });
  it("marks nothing for a date that is not past", () => {
    render(<IncomingRequestsTable rows={[row({ id: "r-1", neededBy: "2026-10-20" })]} now={now} />);
    expect(screen.queryByText("Overdue")).toBeNull();
  });
});

describe("DeliveredRequestsTable", () => {
  it("shows the asset count, the delivery date and a link to the request", () => {
    render(<DeliveredRequestsTable rows={[row({ id: "r-2", title: "Posters", status: "delivered", closedAt: "2026-10-08T00:00:00Z", assetCount: 5 })]} />);
    expect(screen.getByRole("link", { name: "Posters" })).toHaveAttribute("href", "/requests/r-2");
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
