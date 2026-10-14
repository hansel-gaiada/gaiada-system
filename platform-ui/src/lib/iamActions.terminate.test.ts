import { describe, it, expect, vi, beforeEach } from "vitest";

// Offboarding (2026-10-15): the platform KEEPS a leaver's department grant when the same unit id also exists at another
// company where they still work, and lists it as `keptAmbiguousOrgUnitGrants`. The HR message must say so by name, so a
// kept grant is never silently retained.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { platformFetch } from "./platform";
import { terminateEmployee } from "./iamActions";

const fetchMock = vi.mocked(platformFetch);

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const BASE = { ok: true, userDisabled: false, itFollowUp: null, closedAssignmentIds: ["a1"], revokedManualGrants: ["g1"] };

beforeEach(() => fetchMock.mockReset());

describe("terminateEmployee: the kept department grants are named", () => {
  it("lists every kept grant with its role and unit, and tells HR to review them", async () => {
    fetchMock.mockResolvedValue({
      ...BASE,
      keptAmbiguousOrgUnitGrants: [{ grantId: "g9", role: "org_unit_lead", scopeId: "d-web", otherCompanyIds: ["co-2"] }],
    } as never);
    const r = await terminateEmployee(form({ employeeId: "e1", reason: "Left the company" }));
    expect(r.ok).toBe(true);
    const msg = (r as { message: string }).message;
    expect(msg).toContain("1 department grant(s) were KEPT");
    expect(msg).toContain("org_unit_lead on d-web");
    expect(msg).toContain("Review them in Access");
  });

  it("says nothing extra when no grant was kept (and tolerates an older platform without the field)", async () => {
    fetchMock.mockResolvedValue({ ...BASE, keptAmbiguousOrgUnitGrants: [] } as never);
    const a = (await terminateEmployee(form({ employeeId: "e1", reason: "Left" }))) as { message: string };
    expect(a.message).not.toContain("KEPT");
    fetchMock.mockResolvedValue({ ...BASE } as never);
    const b = (await terminateEmployee(form({ employeeId: "e1", reason: "Left" }))) as { message: string };
    expect(b.message).not.toContain("KEPT");
    expect(b.message).toContain("1 manual grant(s) revoked");
  });
});
