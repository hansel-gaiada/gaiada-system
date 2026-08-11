import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RoleManager, type AdminActionState } from "./RoleManager";
import type { OrgUnitOption } from "@/lib/org";

// IAM-UI-SCOPE — pins the migration-0100 scope-picker change: `team`/`record` are retired from the
// dropdown, `org_unit` replaces `team` with a real org-chart picker (never free text). HIER-3
// (2026-08-11) flips `ORG_UNIT_SCOPE_ENABLED` now that HIER-2's `org_unit_lead` role + Cerbos
// subtree cascade give the scope real effect. Render-only in the same spirit as
// PortalChangeRequestForm.test.tsx: `assign`/`revoke`/`revokeSession` are plain async functions
// here (not real "use server" actions), which is fine — RoleManager only needs something
// `useActionState` can call, and no test below fires a submit that would exercise them for real.
const ROLES = [{ id: "r-1", name: "Manager", company_id: null }];
const ORG_UNITS: OrgUnitOption[] = [
  { id: "d-web", name: "Web Dev", kind: "department", depth: 1 },
  { id: "dv-frontend", name: "Frontend", kind: "division", depth: 2 },
];

const noop = async (): Promise<AdminActionState> => ({ ok: true });

function renderManager(orgUnits: OrgUnitOption[] = ORG_UNITS) {
  render(
    <RoleManager
      userId="u-1"
      currentRoles={[]}
      roles={ROLES}
      orgUnits={orgUnits}
      assign={noop}
      revoke={vi.fn()}
      revokeSession={noop}
    />,
  );
}

describe("RoleManager scope picker", () => {
  // HIER-3 (2026-08-11) — `ORG_UNIT_SCOPE_ENABLED` flipped true: HIER-2 shipped both preconditions
  // (the API accepts `org_unit`; `org_unit_lead` + its Cerbos subtree cascade give the scope real
  // effect). `team`/`record` remain retired — zero live grants, deleted by HIER-3.
  it("offers global/company/project/org_unit — and never team or record", () => {
    renderManager();
    const scope = screen.getByLabelText("Scope") as HTMLSelectElement;
    const values = [...scope.options].map((o) => o.value).filter(Boolean);
    expect(values).toEqual(["company", "global", "project", "org_unit"]);
    // Retired scopes: zero live grants, deleted by HIER-3.
    expect(values).not.toContain("team");
    expect(values).not.toContain("record");
  });

  it("advertises org_unit now that the gate is on", () => {
    renderManager();
    expect(screen.queryByRole("option", { name: /org unit/i })).not.toBeNull();
  });

  it("defaults to a free-text Scope ID field (company/project shape)", () => {
    renderManager();
    expect(screen.getByLabelText(/scope id/i)).toBeInTheDocument();
  });

  // HIER-3: un-skipped now that `ORG_UNIT_SCOPE_ENABLED` is true and the option renders.
  it("selecting org_unit swaps the free-text box for an org-chart picker fed by orgUnits", () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "org_unit" } });
    expect(screen.queryByLabelText(/scope id \(optional\)/i)).not.toBeInTheDocument();
    const picker = screen.getByLabelText(/org unit/i) as HTMLSelectElement;
    const optionLabels = [...picker.options].map((o) => o.textContent);
    expect(optionLabels.some((l) => l?.includes("Web Dev"))).toBe(true);
    expect(optionLabels.some((l) => l?.includes("Frontend"))).toBe(true);
  });

  // HIER-3: un-skipped now that `ORG_UNIT_SCOPE_ENABLED` is true and the option renders. The
  // "inert grant" caveat is gone (org_unit now confers real access via org_unit_lead) — the hint
  // is a plain scope-shape note instead (`ORG_UNIT_SCOPE_NOTE` in RoleManager.tsx).
  it("the org-chart picker carries a subtree-scope hint", () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "org_unit" } });
    expect(screen.getByText(/and its subtree/i)).toBeInTheDocument();
    expect(screen.getByText(/org_unit_lead/i)).toBeInTheDocument();
  });

  it("selecting global hides the scope-id control entirely", () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "global" } });
    expect(screen.queryByLabelText(/scope id/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/org unit/i)).not.toBeInTheDocument();
  });

  // HIER-3: un-skipped now that `ORG_UNIT_SCOPE_ENABLED` is true and the option renders.
  it("org_unit with an empty org chart shows a teach-state and disables Assign rather than submitting an unstorable grant", () => {
    renderManager([]);
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "org_unit" } });
    expect(screen.getByText(/no departments or divisions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /assign/i })).toBeDisabled();
  });

  it("switching back to company/project restores the free-text scope-id box", () => {
    renderManager();
    const scope = screen.getByLabelText("Scope");
    fireEvent.change(scope, { target: { value: "org_unit" } });
    fireEvent.change(scope, { target: { value: "project" } });
    expect(screen.getByLabelText(/scope id/i)).toBeInTheDocument();
    expect(screen.queryByText(/and its subtree/i)).not.toBeInTheDocument();
  });
});
