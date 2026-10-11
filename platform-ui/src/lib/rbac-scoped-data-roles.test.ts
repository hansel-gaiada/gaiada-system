// M5-W1a guard: the writers'-room roles are STAFF-side, data-scoped roles. See `SCOPED_DATA_ROLES` in rbac.ts.
// The trap this pins: the two parity tests force every role Cerbos names into ROLE_CAPS or CLIENT_SIDE_ROLES, and the
// quick way to make them pass is to park a staff role on the client-side list, which turns staff into portal clients.
import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  CLIENT_SIDE_ROLES,
  ROLE_CAPS,
  SCOPED_DATA_ROLES,
  can,
  isClient,
  isClientOnly,
  isStaff,
} from "./rbac";
import type { Me } from "./platform";

function meWith(roles: Me["roles"]): Me {
  return {
    userId: "u1", name: "Test", email: "t@example.com", title: null, assurance: "aal1",
    companies: [{ id: "c1", name: "Co", type: null }],
    roles,
  };
}

const NAMES = ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"];

describe("SCOPED_DATA_ROLES", () => {
  it("is exactly the four writers'-room roles", () => {
    expect([...SCOPED_DATA_ROLES].sort()).toEqual([...NAMES].sort());
  });

  it("is disjoint from CLIENT_SIDE_ROLES (a staff role on the client list turns staff into clients)", () => {
    expect([...SCOPED_DATA_ROLES].filter((r) => CLIENT_SIDE_ROLES.has(r))).toEqual([]);
  });

  it("is disjoint from ROLE_CAPS (no capability by role name)", () => {
    expect([...SCOPED_DATA_ROLES].filter((r) => r in ROLE_CAPS)).toEqual([]);
  });

  for (const role of NAMES) {
    describe(role, () => {
      const me = meWith([{ role, scopeType: "company", scopeId: "c1" }]);

      it("is not client-only and not a client", () => {
        expect(isClient(me)).toBe(false);
        expect(isClientOnly(me)).toBe(false);
      });

      it("counts as staff, so the app shell (not the portal) is kept", () => {
        expect(isStaff(me)).toBe(true);
      });

      it("grants no capability, in any company or without one", () => {
        for (const cap of CAPABILITIES) {
          expect(can(me, cap), `${role} must not hold ${cap}`).toBe(false);
          expect(can(me, cap, "c1"), `${role} must not hold ${cap} in c1`).toBe(false);
        }
      });
    });
  }

  it("a scoped data role does not hide a client grant: client + writer is staff, so not client-only", () => {
    const me = meWith([
      { role: "client", scopeType: "client", scopeId: "k1" },
      { role: "webdesk_writer", scopeType: "company", scopeId: "c1" },
    ]);
    expect(isClient(me)).toBe(true);
    expect(isClientOnly(me)).toBe(false);
  });
});
