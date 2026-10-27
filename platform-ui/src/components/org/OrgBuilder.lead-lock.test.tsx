import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { OrgNode } from "@/lib/org";
import { OrgBuilder, LEAD_LOCK_REASON, LEAD_LOCK_CONTAINS_REASON } from "./OrgBuilder";

// SCP-1r (SCP-D7, owner ruling SCP-Q23): nobody renames, re-types, moves or deletes a unit they hold a live lead seat on. The SERVER
// refuses it (`org_structure` update, the unit self-edit DENY); this is the mirror, which only stops offering controls that would
// 403 and says why. It never decides anything.

const n = (id: string, name: string, kind: OrgNode["kind"], children: OrgNode[] = []): OrgNode => ({ id, name, kind, children });
const tree = (): OrgNode =>
  n("root", "Mock Co", "company", [
    n("d-gm", "GM", "department"),
    n("d-mkt", "Marketing", "department", [n("d-social", "Social Desk", "department")]),
    n("d-web", "Web Dev", "department"),
  ]);

const props = {
  companyId: "c1",
  initial: tree(),
  canEdit: true,
  members: [],
  source: "backend" as const,
  updatedAt: null,
  save: async () => ({ ok: true }),
  service: { enabled: false, companies: [], modules: [], actions: {} as never },
};

/** The detailed editor's row for the unit whose name input shows `name`. */
const row = (name: string): HTMLElement => screen.getByDisplayValue(name).closest(".org-erow") as HTMLElement;

describe("OrgBuilder: units the viewer leads (SCP-D7)", () => {
  it("a unit the viewer leads has its name read-only, its type fixed, no drag handle and no Remove, with the reason", () => {
    render(<OrgBuilder {...props} ledUnitIds={["d-web"]} />);
    const r = row("Web Dev");
    expect(within(r).getByDisplayValue("Web Dev")).toHaveAttribute("readonly");
    expect(within(r).getByLabelText("Unit type")).toBeDisabled();
    expect(within(r).getByRole("button", { name: "Remove unit" })).toBeDisabled();
    expect(within(r).getByRole("button", { name: "Remove unit" })).toHaveAttribute("title", LEAD_LOCK_REASON);
    expect(within(r).queryByRole("button", { name: /Drag Web Dev/ })).toBeNull();
  });

  it("every other unit stays fully editable", () => {
    render(<OrgBuilder {...props} ledUnitIds={["d-web"]} />);
    const r = row("GM");
    expect(within(r).getByDisplayValue("GM")).not.toHaveAttribute("readonly");
    expect(within(r).getByLabelText("Unit type")).toBeEnabled();
    expect(within(r).getByRole("button", { name: "Remove unit" })).toBeEnabled();
    expect(within(r).getByRole("button", { name: /Drag GM/ })).toBeInTheDocument();
  });

  it("a unit that only CONTAINS a led unit can be renamed and moved, but not deleted (deleting it deletes the led unit)", () => {
    render(<OrgBuilder {...props} ledUnitIds={["d-social"]} />);
    const r = row("Marketing");
    expect(within(r).getByDisplayValue("Marketing")).not.toHaveAttribute("readonly");
    expect(within(r).getByLabelText("Unit type")).toBeEnabled();
    expect(within(r).getByRole("button", { name: "Remove unit" })).toBeDisabled();
    expect(within(r).getByRole("button", { name: "Remove unit" })).toHaveAttribute("title", LEAD_LOCK_CONTAINS_REASON);
    expect(within(row("Social Desk")).getByDisplayValue("Social Desk")).toHaveAttribute("readonly");
  });

  it("the chart box of a led unit is not draggable, the others are", () => {
    render(<OrgBuilder {...props} ledUnitIds={["d-web"]} />);
    expect(screen.getByText("Web Dev").closest(".org-box")).toHaveAttribute("draggable", "false");
    expect(screen.getByText("GM").closest(".org-box")).toHaveAttribute("draggable", "true");
  });

  it("selecting a led unit shows the reason in the inspector, with the name and type locked and Remove off", () => {
    render(<OrgBuilder {...props} ledUnitIds={["d-web"]} />);
    fireEvent.click(screen.getByText("Web Dev"));
    expect(screen.getByTestId("org-lead-lock-note")).toHaveTextContent(LEAD_LOCK_REASON);
    const insp = document.querySelector(".org-insp") as HTMLElement;
    expect(within(insp).getByLabelText("Unit name")).toHaveAttribute("readonly");
    expect(within(insp).getByLabelText("Unit type")).toBeDisabled();
    expect(within(insp).getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("typing into a locked name changes nothing (the editor is a mirror of the server, not a way round it)", () => {
    render(<OrgBuilder {...props} ledUnitIds={["d-web"]} />);
    fireEvent.change(screen.getByDisplayValue("Web Dev"), { target: { value: "Social Media" } });
    expect(screen.getByDisplayValue("Web Dev")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Social Media")).toBeNull();
  });

  it("with no led units (or the prop omitted) nothing is disabled and no reason is shown", () => {
    for (const extra of [{ ledUnitIds: [] as string[] }, {}]) {
      const { unmount } = render(<OrgBuilder {...props} {...extra} />);
      const r = row("Web Dev");
      expect(within(r).getByDisplayValue("Web Dev")).not.toHaveAttribute("readonly");
      expect(within(r).getByLabelText("Unit type")).toBeEnabled();
      expect(within(r).getByRole("button", { name: "Remove unit" })).toBeEnabled();
      fireEvent.click(screen.getByText("Web Dev"));
      expect(screen.queryByTestId("org-lead-lock-note")).toBeNull();
      unmount();
    }
  });
});
