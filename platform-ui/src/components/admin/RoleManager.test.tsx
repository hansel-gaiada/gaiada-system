import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RoleManager, type AdminActionState } from "./RoleManager";
import type { OrgUnitOption } from "@/lib/org";

// IAM-UI-SCOPE — pins the migration-0100 scope-picker change: `team`/`record` are retired from the
// dropdown, `org_unit` replaces `team` with a real org-chart picker (never free text), and an
// `org_unit` grant is never presented as doing anything today (HIER-2, the enforcing role, hasn't
// shipped). Render-only in the same spirit as PortalChangeRequestForm.test.tsx: `assign`/`revoke`/
// `revokeSession` are plain async functions here (not real "use server" actions), which is fine —
// RoleManager only needs something `useActionState` can call, and no test below fires a submit that
// would exercise them for real.
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
  // ⚠ REVISED 2026-08-10 (cross-agent conflict, resolved in the backend's favour).
  // This file originally asserted that `org_unit` IS offered, with a "no effect yet" label. Two
  // tickets had reached opposite, individually-defensible conclusions on the same feature:
  //   • this component chose to OFFER the scope with an honest caveat;
  //   • `platform-nest/src/admin/admin-identity.controller.ts` chose NOT to accept it, arguing that
  //     offering a scope before anything consumes it "would let an admin mint a grant that is inert
  //     by construction — the exact 'vestigial scope' pattern this whole program exists to retire".
  // The API's `SCOPE_TYPES` is `{global, company, project}`, so the UI option produced a 400. The
  // backend's argument also wins on merit: an inert grant nobody can act on is precisely how `team`
  // became a dead concept wired into ~23 policies and 70% of the IAM-04 rollout hazard, and a
  // caveat LABEL does not stop the grant from being created — not offering it does.
  // `ORG_UNIT_SCOPE_ENABLED` is the single gate; HIER-2 flips it alongside the `org_unit_lead` role.
  it("offers global/company/project — and never team, record, or (yet) org_unit", () => {
    renderManager();
    const scope = screen.getByLabelText("Scope") as HTMLSelectElement;
    const values = [...scope.options].map((o) => o.value).filter(Boolean);
    expect(values).toEqual(["company", "global", "project"]);
    // Retired scopes: zero live grants, deleted by HIER-3.
    expect(values).not.toContain("team");
    expect(values).not.toContain("record");
    // Not offered until it DOES something (HIER-2) — and until the API accepts it.
    expect(values).not.toContain("org_unit");
  });

  it("does not advertise org_unit anywhere while the gate is off", () => {
    renderManager();
    expect(screen.queryByRole("option", { name: /org unit/i })).toBeNull();
  });

  it("defaults to a free-text Scope ID field (company/project shape)", () => {
    renderManager();
    expect(screen.getByLabelText(/scope id/i)).toBeInTheDocument();
  });

  // ⏸ PARKED until HIER-2 flips `ORG_UNIT_SCOPE_ENABLED`. The org-node picker, its hint and
  // its empty-chart teach-state are all still BUILT in RoleManager.tsx — they are simply
  // unreachable while `org_unit` is absent from the select, so these cannot render today.
  // Un-skip them in the same change that flips the gate; do NOT delete them.
  it.skip("selecting org_unit swaps the free-text box for an org-chart picker fed by orgUnits", () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "org_unit" } });
    expect(screen.queryByLabelText(/scope id \(optional\)/i)).not.toBeInTheDocument();
    const picker = screen.getByLabelText(/org unit/i) as HTMLSelectElement;
    const optionLabels = [...picker.options].map((o) => o.textContent);
    expect(optionLabels.some((l) => l?.includes("Web Dev"))).toBe(true);
    expect(optionLabels.some((l) => l?.includes("Frontend"))).toBe(true);
  });

  // ⏸ PARKED until HIER-2 flips `ORG_UNIT_SCOPE_ENABLED`. The org-node picker, its hint and
  // its empty-chart teach-state are all still BUILT in RoleManager.tsx — they are simply
  // unreachable while `org_unit` is absent from the select, so these cannot render today.
  // Un-skip them in the same change that flips the gate; do NOT delete them.
  it.skip("the org-chart picker carries an explicit 'no effect until HIER-2' hint", () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "org_unit" } });
    expect(screen.getByText(/no role reads org-unit scope yet/i)).toBeInTheDocument();
    expect(screen.getByText(/department-lead role \(hier-2\)/i)).toBeInTheDocument();
  });

  it("selecting global hides the scope-id control entirely", () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "global" } });
    expect(screen.queryByLabelText(/scope id/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/org unit/i)).not.toBeInTheDocument();
  });

  // ⏸ PARKED until HIER-2 flips `ORG_UNIT_SCOPE_ENABLED`. The org-node picker, its hint and
  // its empty-chart teach-state are all still BUILT in RoleManager.tsx — they are simply
  // unreachable while `org_unit` is absent from the select, so these cannot render today.
  // Un-skip them in the same change that flips the gate; do NOT delete them.
  it.skip("org_unit with an empty org chart shows a teach-state and disables Assign rather than submitting an unstorable grant", () => {
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
    expect(screen.queryByText(/no role reads org-unit scope yet/i)).not.toBeInTheDocument();
  });
});
