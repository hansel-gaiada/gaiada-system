import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/deptKpiAlertActions", () => ({ acknowledgeKpiAlert: vi.fn() }));

import { acknowledgeKpiAlert } from "@/lib/deptKpiAlertActions";
import { AlertsSection, TileAlertLine } from "./KpiAlerts";
import type { KpiAlert } from "@/lib/deptKpiAlertFormat";

// DW-4j-2 — the KPI page's alert line and history (BFF §43.7). The page passes the honest reader's result in; every state of it is said here:
// a list, a true "No alerts yet", the quiet nothing for a refusal, and "could not be loaded" for a failure (never an empty claim).

const alert = (over: Partial<KpiAlert> = {}): KpiAlert => ({
  id: "al-1", unit: { id: "dept-2", name: "Creatives" }, kpiKey: "asset-requests-on-time", kpiLabel: "Asset requests delivered on time", kpiUnit: "percent",
  periodStart: "2026-10-01", openedAt: "2026-10-03T06:30:00.000Z", value: 0.72, target: 0.9,
  acknowledgedBy: null, acknowledgedByName: null, acknowledgedAt: null, ackNote: null, resolvedAt: null, resolvedCondition: null, ...over,
});
const resolvedAck = alert({
  id: "al-2", kpiKey: "projects-on-time", kpiLabel: "Projects on time", openedAt: "2026-08-12T06:30:00.000Z", value: 0.78, target: 0.85,
  acknowledgedBy: "u1", acknowledgedByName: "Ayu", acknowledgedAt: "2026-08-13T09:10:00.000Z", ackNote: "Rebooked the two launches.",
  resolvedAt: "2026-09-02T06:30:00.000Z", resolvedCondition: "on_track",
});
const resolvedUnavailable = alert({
  id: "al-3", kpiKey: "client-site-uptime", kpiLabel: "Client site uptime", openedAt: "2026-09-15T06:30:00.000Z", value: 0.97, target: 0.995,
  resolvedAt: "2026-11-01T06:30:00.000Z", resolvedCondition: "unavailable",
});

beforeEach(() => {
  refresh.mockReset();
  vi.mocked(acknowledgeKpiAlert).mockReset();
});

describe("TileAlertLine", () => {
  it("says since when, and who once a head has acknowledged", () => {
    const { rerender } = render(<TileAlertLine alert={alert()} />);
    expect(screen.getByText("Off track since 3 Oct")).toBeInTheDocument();
    rerender(<TileAlertLine alert={alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", acknowledgedByName: "Ayu" })} />);
    expect(screen.getByText("Off track since 3 Oct · acknowledged by Ayu")).toBeInTheDocument();
  });
});

describe("AlertsSection: the unit's history", () => {
  it("lists every alert newest first, each with its state in words, its reading and its story", () => {
    render(<AlertsSection result={{ kind: "ok", data: [resolvedAck, alert(), resolvedUnavailable] }} tenantId="co-a" canAcknowledge={false} />);
    const list = screen.getByRole("list", { name: "Alerts" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual(["Asset requests delivered on time", "Client site uptime", "Projects on time"]);
    const [open, uptime, projects] = rows;
    expect(within(open).getByText("Open")).toBeInTheDocument();
    expect(open.textContent).toContain("Off track since 3 Oct · 72% against 90%");
    expect(within(uptime).getByText("Resolved")).toBeInTheDocument();
    expect(uptime.textContent).toContain("Resolved (unavailable) on 1 Nov");
    expect(within(projects).getByText("Resolved")).toBeInTheDocument();
    expect(projects.textContent).toContain("Acknowledged by Ayu on 13 Aug. Note: Rebooked the two launches.");
    expect(projects.textContent).toContain("Back on track on 2 Sep");
  });

  it("says an open acknowledged alert is open and acknowledged", () => {
    render(<AlertsSection result={{ kind: "ok", data: [alert({ acknowledgedAt: "2026-10-04T09:00:00.000Z", acknowledgedByName: "Ayu" })] }} tenantId="co-a" canAcknowledge />);
    expect(screen.getByText("Open, acknowledged")).toBeInTheDocument();
    expect(screen.getByText("Acknowledged by Ayu on 4 Oct")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Acknowledge the alert/ })).not.toBeInTheDocument(); // nothing left to acknowledge
  });

  it("says No alerts yet for a read that succeeded with nothing in it", () => {
    render(<AlertsSection result={{ kind: "ok", data: [] }} tenantId="co-a" canAcknowledge />);
    expect(screen.getByRole("heading", { name: /Alerts/ })).toBeInTheDocument();
    expect(screen.getByText("No alerts yet")).toBeInTheDocument();
  });

  it("says the alerts could not be loaded for a failed read, never No alerts yet", () => {
    render(<AlertsSection result={{ kind: "error", reason: "boom" }} tenantId="co-a" canAcknowledge />);
    expect(screen.getByText("The alerts could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("No alerts yet")).not.toBeInTheDocument();
  });

  it("says the same for a unit that was not found, never No alerts yet", () => {
    render(<AlertsSection result={{ kind: "not_found" }} tenantId="co-a" canAcknowledge />);
    expect(screen.getByText("The alerts could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No alerts yet")).not.toBeInTheDocument();
  });

  it("shows nothing extra for a refusal: the page's own gate already speaks", () => {
    const { container } = render(<AlertsSection result={{ kind: "forbidden" }} tenantId="co-a" canAcknowledge />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AlertsSection: Acknowledge", () => {
  const open = () => <AlertsSection result={{ kind: "ok", data: [alert(), resolvedAck] }} tenantId="co-a" canAcknowledge />;

  it("is offered only on an open, unacknowledged alert, and only to someone who may", () => {
    const { unmount } = render(open());
    expect(screen.getAllByRole("button", { name: /Acknowledge the alert/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Acknowledge the alert for Asset requests delivered on time" })).toBeInTheDocument();
    unmount();
    render(<AlertsSection result={{ kind: "ok", data: [alert()] }} tenantId="co-a" canAcknowledge={false} />);
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).not.toBeInTheDocument();
  });

  it("acknowledges through the action with the company and the alert id, then refreshes the page", async () => {
    vi.mocked(acknowledgeKpiAlert).mockResolvedValue({ ok: true });
    render(open());
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge the alert/ }));
    await waitFor(() => expect(acknowledgeKpiAlert).toHaveBeenCalledWith("co-a", "al-1", ""));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps the note collapsed until asked for and sends what was typed", async () => {
    vi.mocked(acknowledgeKpiAlert).mockResolvedValue({ ok: true });
    render(open());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Seen, chasing the vendor." } });
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge the alert/ }));
    await waitFor(() => expect(acknowledgeKpiAlert).toHaveBeenCalledWith("co-a", "al-1", "Seen, chasing the vendor."));
  });

  it("shows the server's refusal as it was said and does not refresh", async () => {
    vi.mocked(acknowledgeKpiAlert).mockResolvedValue({ ok: false, error: "outside your reporting line" });
    render(open());
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge the alert/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside your reporting line");
    expect(refresh).not.toHaveBeenCalled();
  });
});
