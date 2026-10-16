import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConnectServicePanel, type ConnectServiceActions } from "./ConnectServicePanel";
import { ServiceAssignmentRow } from "./ServiceAssignmentRow";
import type { OrgNode } from "@/lib/org";
import type { AssignmentSummary, DryRunResult } from "@/lib/serviceAssignments";
import { ROUTING_KEYS, routeClientReasonText, routePreviewText, routeProposeErrorText, moduleOptionLabel, isRoutingKey } from "@/lib/requests";

// DW-10e (BFF §60.2, §60.9): ORG-13's side of a route. The module picker also offers "Asset requests" and "Engineering requests" on a DEPARTMENT only;
// the lead picker is hidden for them (a route has no manager); the preview says nobody is added and what the route allows; a target that is not the
// provider's client says so in words; and the Serviced functions row names a route as one.
const dept: OrgNode = { id: "dept-2", name: "Creatives", kind: "department", children: [] };
const division: OrgNode = { id: "dv-1", name: "Design", kind: "division", children: [] };
const companies = [{ id: "co-resort", name: "Viceroy" }, { id: "co-hotel", name: "Hotel Two" }];
const modules = ["hr", "it", "pm", ...ROUTING_KEYS];

const preview = (over: Partial<DryRunResult> = {}): DryRunResult => ({
  dryRun: true, routeOnly: true, unit: { nodeId: "dept-2", name: "Creatives", kind: "department" }, items: [],
  companies: [{ id: "co-resort", name: "Viceroy", included: true }], ...over,
});
function actions(over: Partial<ConnectServiceActions> = {}): ConnectServiceActions {
  return {
    dryRun: vi.fn(async () => ({ ok: true, result: preview() })),
    propose: vi.fn(async () => ({ ok: true, result: { assignments: [{ id: "sa-1", target: "co-resort", status: "proposed" as const }] } })),
    listForUnit: vi.fn(async () => []),
    revoke: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}
const draw = (node: OrgNode, a: ConnectServiceActions) =>
  render(<ConnectServicePanel node={node} companies={companies} modules={modules} members={[{ id: "u-1", name: "Rai" }]} actions={a} existing={[]} onClose={() => {}} providerName="Gaia Digital Agency" />);
const pickModule = (value: string) => fireEvent.change(screen.getByLabelText("Module"), { target: { value } });
const options = () => Array.from(screen.getByLabelText("Module").querySelectorAll("option")).map((o) => o.textContent);

describe("the module picker", () => {
  it("offers Asset requests and Engineering requests on a department, beside the modules", () => {
    draw(dept, actions());
    expect(options()).toEqual(["hr", "it", "pm", "Asset requests", "Engineering requests"]);
  });

  it("offers them on a department only: a division is offered the modules alone", () => {
    draw(division, actions());
    expect(options()).toEqual(["hr", "it", "pm"]);
  });

  it("hides the lead picker for a route, and shows it again for a module", () => {
    draw(dept, actions());
    expect(screen.getByLabelText("Lead (optional)")).toBeInTheDocument();
    pickModule("asset_requests");
    expect(screen.queryByLabelText("Lead (optional)")).toBeNull();
    pickModule("pm");
    expect(screen.getByLabelText("Lead (optional)")).toBeInTheDocument();
  });
});

describe("the preview of a route", () => {
  it("says nobody is added to the company and what the route allows, billed to it as a client", async () => {
    const a = actions();
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Viceroy"));
    pickModule("asset_requests");
    fireEvent.click(screen.getByRole("button", { name: "Preview staff (dry run)" }));
    expect(await screen.findByText("Nobody is added to Viceroy. Viceroy can send asset requests to Creatives, billed to it as a client.")).toBeInTheDocument();
    expect(screen.queryByText(/Would serve/)).toBeNull();
    expect(a.dryRun).toHaveBeenCalledWith("dept-2", { targets: ["co-resort"], module: "asset_requests", leadUserId: undefined });
  });

  it("names the engineering kind for an engineering route", async () => {
    draw(dept, actions());
    fireEvent.click(screen.getByLabelText("Viceroy"));
    pickModule("engineering_requests");
    fireEvent.click(screen.getByRole("button", { name: "Preview staff (dry run)" }));
    expect(await screen.findByText(/Viceroy can send engineering requests to Creatives/)).toBeInTheDocument();
  });

  it("says a target that is not the provider's client is not, and where an operator links it", async () => {
    const a = actions({
      dryRun: vi.fn(async () => ({
        ok: true, result: preview({ companies: [{ id: "co-resort", name: "Viceroy", included: true }, { id: "co-hotel", name: "Hotel Two", included: false, reason: "no_group_client" }] }),
      })),
    });
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Viceroy"));
    fireEvent.click(screen.getByLabelText("Hotel Two"));
    pickModule("asset_requests");
    fireEvent.click(screen.getByRole("button", { name: "Preview staff (dry run)" }));
    expect(await screen.findByText("Hotel Two is not a client of Gaia Digital Agency yet: a platform operator links it in Clients")).toBeInTheDocument();
    expect(screen.getByText(/Viceroy can send asset requests/)).toBeInTheDocument();
  });

  it("a module's preview is as it was: who would be served", async () => {
    const a = actions({ dryRun: vi.fn(async () => ({ ok: true, result: preview({ routeOnly: undefined, items: [{ userId: "u-9", name: "Putu", email: "p@x", role: "staff" }] }) })) });
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Viceroy"));
    fireEvent.click(screen.getByRole("button", { name: "Preview staff (dry run)" }));
    expect(await screen.findByText("Would serve (1 people from Creatives)")).toBeInTheDocument();
    expect(screen.queryByText(/Nobody is added/)).toBeNull();
  });
});

describe("connecting a route", () => {
  it("sends no lead for a route even when one was chosen for a module first", async () => {
    const a = actions();
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Viceroy"));
    fireEvent.change(screen.getByLabelText("Lead (optional)"), { target: { value: "u-1" } });
    pickModule("engineering_requests");
    fireEvent.click(screen.getByRole("button", { name: "Confirm & connect" }));
    await waitFor(() => expect(a.propose).toHaveBeenCalledWith("dept-2", { targets: ["co-resort"], module: "engineering_requests", leadUserId: undefined }));
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
  });

  it("says route_needs_group_client with the company's name, from the refusal's target", async () => {
    const a = actions({ propose: vi.fn(async () => ({ ok: false, error: "raw", reason: "route_needs_group_client", targetId: "co-hotel" })) });
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Hotel Two"));
    pickModule("asset_requests");
    fireEvent.click(screen.getByRole("button", { name: "Confirm & connect" }));
    expect(await screen.findByText("Hotel Two is not a client of Gaia Digital Agency yet: a platform operator links it in Clients")).toBeInTheDocument();
  });

  it("says a division and a lead are refused, in words", async () => {
    const a = actions({ propose: vi.fn(async () => ({ ok: false, error: "raw", reason: "route_unit_not_department" })) });
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Viceroy"));
    pickModule("asset_requests");
    fireEvent.click(screen.getByRole("button", { name: "Confirm & connect" }));
    expect(await screen.findByText("A route goes on a department. Choose a department, not a division.")).toBeInTheDocument();
  });

  it("falls back to the backend's own words for a refusal it has no sentence for", async () => {
    const a = actions({ propose: vi.fn(async () => ({ ok: false, error: "Only owners can connect." })) });
    draw(dept, a);
    fireEvent.click(screen.getByLabelText("Viceroy"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & connect" }));
    expect(await screen.findByText("Only owners can connect.")).toBeInTheDocument();
  });

  it("lists an existing route by its label, not its key", () => {
    const existing: AssignmentSummary[] = [{
      id: "sa-9", providerTenantId: "co-agency", targetTenantId: "co-resort", targetCompanyName: "Viceroy", unitId: "dept-2", unitName: "Creatives", unitKind: "department",
      unitStatus: "active", module: "asset_requests", status: "active", createdAt: "2026-10-01T00:00:00Z",
    }];
    render(<ConnectServicePanel node={dept} companies={companies} modules={modules} members={[]} actions={actions()} existing={existing} onClose={() => {}} />);
    expect(screen.getByText("Asset requests", { selector: ".connect-svc__module" })).toBeInTheDocument();
    expect(screen.queryByText("asset_requests")).toBeNull();
  });
});

describe("the Serviced functions row", () => {
  const route: AssignmentSummary = {
    id: "sa-1", providerTenantId: "co-agency", providerCompanyName: "Gaia Digital Agency", targetTenantId: "co-resort", targetCompanyName: "Viceroy",
    unitId: "dept-2", unitName: "Creatives", unitKind: "department", unitStatus: "active", module: "asset_requests", status: "active", createdAt: "2026-10-01T00:00:00Z",
  };

  it("names a route by its label and says what it is, and that nobody is added", () => {
    render(<ul><ServiceAssignmentRow a={route} label="Gaia Digital Agency · Creatives" actions={{}} /></ul>);
    expect(screen.getByText("Asset requests")).toBeInTheDocument();
    expect(screen.getByText(/A route: Viceroy can send asset requests to Creatives, billed to it as a client\. Nobody is added to Viceroy\./)).toBeInTheDocument();
  });

  it("an ordinary module reads as it did, with no route note", () => {
    render(<ul><ServiceAssignmentRow a={{ ...route, module: "hr" }} label="Gaia · HR" actions={{}} /></ul>);
    expect(screen.getByText("hr")).toBeInTheDocument();
    expect(screen.queryByText(/A route:/)).toBeNull();
  });
});

describe("the words", () => {
  it("labels the two routing keys and nothing else", () => {
    expect(ROUTING_KEYS).toEqual(["asset_requests", "engineering_requests"]);
    expect(moduleOptionLabel("asset_requests")).toBe("Asset requests");
    expect(moduleOptionLabel("engineering_requests")).toBe("Engineering requests");
    expect(moduleOptionLabel("hr")).toBe("hr");
    expect(isRoutingKey("asset_requests")).toBe(true);
    expect(isRoutingKey("pm")).toBe(false);
  });

  it("says the client sentences, for the dry run's reasons and propose's codes", () => {
    for (const r of ["no_group_client", "route_needs_group_client"]) expect(routeClientReasonText(r, "Viceroy", "Gaia")).toBe("Viceroy is not a client of Gaia yet: a platform operator links it in Clients");
    expect(routeClientReasonText("group_client_ambiguous", "Viceroy", "Gaia")).toMatch(/more than once/);
    expect(routeClientReasonText("no_access", "Viceroy", "Gaia")).toBeNull();
    expect(routeClientReasonText(undefined, "Viceroy", "Gaia")).toBeNull();
    expect(routePreviewText("engineering_requests", "Viceroy", "Web Dev")).toBe("Nobody is added to Viceroy. Viceroy can send engineering requests to Web Dev, billed to it as a client.");
    expect(routeProposeErrorText("route_has_no_lead")).toBe("A route has no manager, so it takes no lead.");
    expect(routeProposeErrorText("x")).toBeNull();
  });
});
