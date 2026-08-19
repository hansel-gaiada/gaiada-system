// P2-10 / P2-11 / P2-12-FE — the IAM data layer's own judgement, tested without a network.
//
// The cases that carry weight are the ORDERING and DEGRADATION ones, because both encode a decision that
// is invisible once it works: which rows an operator sees first, and what an empty result is allowed to
// mean.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sortPositions, positionsByUnit, EMPLOYMENT_LABEL, GRANT_SOURCE_LABEL, type Position } from "./iam";

const pos = (over: Partial<Position> & { title: string }): Position => ({
  id: `p-${over.title}`,
  tenantId: "t1",
  unitNodeId: "d-web",
  isLead: false,
  status: "active",
  orphaned: false,
  roleSet: [],
  currentHolders: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...over,
});

describe("P2-12-FE · position ordering", () => {
  it("🔴 orphaned seats sort FIRST, then vacant, then filled", () => {
    // An orphaned seat has frozen someone's access and needs escalation; a vacant one is work to do; a
    // filled one is fine. If this inverts, the two rows that need action sit below the ones that do not.
    const sorted = sortPositions([
      pos({ title: "filled" }),
      pos({ title: "vacant", currentHolders: 0 }),
      pos({ title: "orphan", orphaned: true, status: "orphaned" }),
    ]);
    expect(sorted.map((p) => p.title)).toEqual(["orphan", "vacant", "filled"]);
  });

  it("sorts by title within a rank, so the list is stable between refreshes", () => {
    const sorted = sortPositions([pos({ title: "zeta" }), pos({ title: "alpha" })]);
    expect(sorted.map((p) => p.title)).toEqual(["alpha", "zeta"]);
  });

  it("an orphaned seat with holders still outranks a vacant one — frozen access beats an empty chair", () => {
    const sorted = sortPositions([
      pos({ title: "vacant", currentHolders: 0 }),
      pos({ title: "orphan-held", orphaned: true, status: "orphaned", currentHolders: 3 }),
    ]);
    expect(sorted[0].title).toBe("orphan-held");
  });

  it("groups by unit and sorts within each group", () => {
    const map = positionsByUnit([
      pos({ title: "b", unitNodeId: "d-hr" }),
      pos({ title: "a", unitNodeId: "d-hr" }),
      pos({ title: "c", unitNodeId: "d-web" }),
    ]);
    expect([...map.keys()].sort()).toEqual(["d-hr", "d-web"]);
    expect(map.get("d-hr")!.map((p) => p.title)).toEqual(["a", "b"]);
  });
});

describe("P2-10 / P2-11 · labels exist for every enum value", () => {
  it("every employment status has a label — an unlabelled status renders as blank", () => {
    for (const s of ["pending_start", "active", "on_leave", "terminated"] as const) {
      expect(EMPLOYMENT_LABEL[s], s).toBeTruthy();
    }
  });

  it("every grant source has a label, and they say WHERE the grant comes from", () => {
    // Provenance is the whole reason the grant list exists: a position-managed grant must not be
    // hand-revoked, so the label has to distinguish it rather than just naming it.
    expect(GRANT_SOURCE_LABEL.position).toMatch(/position/i);
    expect(GRANT_SOURCE_LABEL.manual).toBeTruthy();
    expect(GRANT_SOURCE_LABEL.service_assignment).toBeTruthy();
  });
});

// ── degradation: what an empty result is allowed to mean ─────────────────────────────────────────

describe("P2-12-FE · listPositions distinguishes 'refused' from 'none defined'", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  async function withPlatform(impl: () => Promise<unknown>) {
    vi.doMock("./platform", () => {
      class PlatformError extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
        }
      }
      return { platformFetch: impl, PlatformError };
    });
    return (await import("./iam")).listPositions("u1", "t1");
  }

  it("🔴 a refusal yields scope=null, which the page renders differently from an empty list", () => {
    // This is the distinction that keeps a department head from concluding no seats exist when in fact
    // they were not allowed to look.
    return withPlatform(async () => {
      throw new Error("not authorized");
    }).then((res) => {
      expect(res.scope).toBeNull();
      expect(res.positions).toEqual([]);
    });
  });

  it("a real empty company yields scope='tenant' with no positions — honestly 'none defined'", async () => {
    const res = await withPlatform(async () => ({ positions: [], scope: "tenant" }));
    expect(res.scope).toBe("tenant");
    expect(res.positions).toEqual([]);
  });

  it("🔴 scope='subtree' survives to the caller — it means the SERVER narrowed the list", async () => {
    // Dropping this would let the positions page tell a dept head they are seeing the whole company.
    const res = await withPlatform(async () => ({ positions: [pos({ title: "a" })], scope: "subtree" }));
    expect(res.scope).toBe("subtree");
  });
});

describe("P2-12-FE · listAttachableRoles keeps the refusals", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("🔴 unattachable roles are RETURNED with their reason, never filtered out", async () => {
    // The server is the allow-list. A UI that dropped these would turn a stated boundary into an
    // invisible one, and nobody could answer "why can't I attach that role?".
    vi.doMock("./platform", () => ({
      platformFetch: async () => ({
        roles: [
          { roleId: "r1", role: "manager", attachable: true, reason: null },
          { roleId: "r2", role: "platform_admin", attachable: false, reason: "denied_role_registry" },
        ],
      }),
      PlatformError: class extends Error {},
    }));
    const roles = await (await import("./iam")).listAttachableRoles("u1", "t1");
    expect(roles).toHaveLength(2);
    expect(roles.find((r) => r.role === "platform_admin")).toMatchObject({
      attachable: false,
      reason: "denied_role_registry",
    });
  });
});
