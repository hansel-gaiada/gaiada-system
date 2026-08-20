// P2-14 — the accounts data layer's judgement. Pure functions, no network.
//
// The case that carries this file is `listAccounts` NOT degrading to an empty list. Every other reader
// in this codebase returns `[]` on 403/404 so a page can ship ahead of its backend; this one must not,
// because an empty accounts list asserts "everyone has a login" and that is the one claim the console is
// forbidden from making while blind.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sortByUrgency, summarize, STATE_LABEL, STATE_HINT, type AccountRow, type AccountState } from "./it-accounts";

const row = (over: Partial<AccountRow> & { state: AccountState; name: string }): AccountRow => ({
  userId: `u-${over.name}`,
  email: `${over.name}@ex.com`,
  employmentStatus: "active",
  keycloakId: "kc-1",
  enabled: true,
  emailVerified: true,
  linked: true,
  linkVerified: true,
  actionable: over.state !== "enabled",
  ...over,
});

describe("P2-14 · accounts data layer", () => {
  it("🔴 sorts a LEAVER STILL ENABLED above everything else", () => {
    // A security finding outranks an onboarding chore. If this ordering ever inverts, the row that
    // matters most is the one an operator has to scroll to find.
    const sorted = sortByUrgency([
      row({ state: "enabled", name: "aaa" }),
      row({ state: "missing", name: "bbb" }),
      row({ state: "leaver_still_enabled", name: "zzz" }),
      row({ state: "unverified_link", name: "ccc" }),
      row({ state: "disabled", name: "ddd" }),
    ]);
    expect(sorted.map((r) => r.state)).toEqual([
      "leaver_still_enabled",
      "missing",
      "unverified_link",
      "disabled",
      "enabled",
    ]);
  });

  it("sorts by name within a state, so the list is stable between refreshes", () => {
    const sorted = sortByUrgency([row({ state: "missing", name: "zoe" }), row({ state: "missing", name: "adam" })]);
    expect(sorted.map((r) => r.name)).toEqual(["adam", "zoe"]);
  });

  it("summarize counts the findings separately from the chores", () => {
    const s = summarize([
      row({ state: "leaver_still_enabled", name: "a" }),
      row({ state: "missing", name: "b" }),
      row({ state: "missing", name: "c" }),
      row({ state: "unverified_link", name: "d" }),
      row({ state: "enabled", name: "e" }),
    ]);
    expect(s).toEqual({ total: 5, actionable: 4, missing: 2, leaversStillEnabled: 1, unverified: 1 });
  });

  it("summarize's `actionable` comes from the SERVER's flag, never re-derived from state", () => {
    // The backend owns "needs attention" precisely so the console cannot disagree with it. A row the
    // server marked not-actionable stays out of the count even when its state looks actionable — which is
    // the real case for a DISABLED leaver (state is `disabled`, and that is the done state).
    const s = summarize([row({ state: "disabled", name: "leaver", employmentStatus: "terminated", actionable: false })]);
    expect(s.actionable).toBe(0);
  });

  it("every state has a label and a hint — a state with no explanation is a state nobody acts on", () => {
    const states: AccountState[] = ["missing", "enabled", "disabled", "leaver_still_enabled", "unverified_link"];
    for (const st of states) {
      expect(STATE_LABEL[st], st).toBeTruthy();
      expect(STATE_HINT[st], st).toBeTruthy();
    }
  });
});

// ── the no-degradation rule, against a stubbed platformFetch ─────────────────────────────────────

describe("P2-14 · listAccounts never degrades to an empty list", () => {
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
    return (await import("./it-accounts")).listAccounts("u1", "t1");
  }

  it("a 503 becomes `unavailable`, carrying the backend's reason", async () => {
    const res = await withPlatform(async () => {
      const { PlatformError } = (await import("./platform")) as unknown as {
        PlatformError: new (s: number, m: string) => Error;
      };
      throw new PlatformError(503, "keycloak_admin_not_configured: the admin client is not configured");
    });
    expect(res.kind).toBe("unavailable");
    if (res.kind === "unavailable") expect(res.reason).toContain("keycloak_admin_not_configured");
  });

  it("🔴 a 502 upstream failure is ALSO `unavailable`, not an empty list", async () => {
    const res = await withPlatform(async () => {
      const { PlatformError } = (await import("./platform")) as unknown as {
        PlatformError: new (s: number, m: string) => Error;
      };
      throw new PlatformError(502, "keycloak_admin_failed: boom");
    });
    expect(res.kind).toBe("unavailable");
  });

  it("a 403 is `forbidden` — distinct from `unavailable`, because the fix is different", async () => {
    const res = await withPlatform(async () => {
      const { PlatformError } = (await import("./platform")) as unknown as {
        PlatformError: new (s: number, m: string) => Error;
      };
      throw new PlatformError(403, "not authorized");
    });
    expect(res.kind).toBe("forbidden");
  });

  it("🔴 an UNRECOGNISED error is `unavailable` too — there is no error whose right rendering is []", async () => {
    const res = await withPlatform(async () => {
      throw new Error("connection reset");
    });
    expect(res.kind).toBe("unavailable");
  });

  it("a real 200 returns the rows", async () => {
    const res = await withPlatform(async () => ({ accounts: [row({ state: "missing", name: "a" })] }));
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.accounts).toHaveLength(1);
  });
});
