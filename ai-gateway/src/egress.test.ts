// P5d: deterministic egress floor (D8.3) + per-tenant budgets.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { config } from "./config";
import { installEgressFloor, restoreEgressForTest, allowedHosts, isEgressInstalled } from "./egress";
import { takeBudget, budgetState, resetBudgetForTest } from "./budget";

describe("egress floor (D8.3)", () => {
  const savedGemini = config.geminiApiKey;
  const savedAllow = config.egressAllowlist;
  afterEach(() => {
    restoreEgressForTest();
    config.geminiApiKey = savedGemini;
    config.egressAllowlist = savedAllow;
  });

  it("derives allowed hosts from configured providers + explicit allowlist", () => {
    config.geminiApiKey = "x";
    config.egressAllowlist = ["files.example.test"];
    const hosts = allowedHosts();
    expect(hosts.has("generativelanguage.googleapis.com")).toBe(true);
    expect(hosts.has("files.example.test")).toBe(true);
  });

  it("blocks a fetch to a non-allowlisted host and allows an allowlisted one", async () => {
    config.geminiApiKey = "";
    config.egressAllowlist = ["allowed.example.test"];
    let blocked: string | null = null;
    installEgressFloor((h) => {
      blocked = h;
    });
    expect(isEgressInstalled()).toBe(true);
    await expect(fetch("https://evil.example.test/steal")).rejects.toThrow(/egress blocked/);
    expect(blocked).toBe("evil.example.test");
    // Allowed host passes the floor (then fails to connect — which is NOT an egress block).
    await expect(fetch("https://allowed.example.test/ok")).rejects.not.toThrow(/egress blocked/);
  });
});

describe("per-tenant budgets", () => {
  beforeEach(() => resetBudgetForTest());
  const savedGlobal = config.dailyCallCap;
  const savedTenant = config.perTenantDailyCallCap;
  afterEach(() => {
    config.dailyCallCap = savedGlobal;
    config.perTenantDailyCallCap = savedTenant;
    resetBudgetForTest();
  });

  it("charges a per-tenant cap independently of other tenants", () => {
    config.dailyCallCap = 100;
    config.perTenantDailyCallCap = 2;
    expect(takeBudget("t1").ok).toBe(true);
    expect(takeBudget("t1").ok).toBe(true);
    const over = takeBudget("t1");
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.scope).toBe("tenant");
    // A different tenant still has its own budget.
    expect(takeBudget("t2").ok).toBe(true);
  });

  it("enforces the global cap across all tenants", () => {
    config.dailyCallCap = 1;
    config.perTenantDailyCallCap = 100;
    expect(takeBudget("t1").ok).toBe(true);
    const over = takeBudget("t2");
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.scope).toBe("global");
    expect(budgetState().used).toBe(1);
  });
});
