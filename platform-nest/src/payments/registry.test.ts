// PV5-10 — "off unless configured" and the boot check, pure (config is mutated and restored per test).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config";
import {
  PROVIDER_PRINCIPALS, configuredProvider, configuredProviders, describePaymentsConfig, providerForTenant, simulationActive,
  simulatorBaseUrl,
} from "./registry";

const T = "11111111-2222-4333-8444-555555555555";

describe("payments registry", () => {
  let saved: typeof config.payments.midtrans;
  beforeEach(() => { saved = { ...config.payments.midtrans }; });
  afterEach(() => { config.payments.midtrans = saved; });

  it("with no server key everything is off, and boot says so in one line", () => {
    config.payments.midtrans = { serverKey: "", environment: "", tenantId: T };
    expect(configuredProvider("midtrans")).toBeNull();
    expect(configuredProviders()).toEqual([]);
    expect(providerForTenant(T)).toBeNull();
    expect(describePaymentsConfig()).toMatch(/^online payment is off/);
  });

  it("with a key and a company it is on for THAT company only, as the provider's automation principal", () => {
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "sandbox", tenantId: T.toUpperCase() };
    const p = configuredProvider("midtrans");
    expect(p?.tenantId).toBe(T);
    expect(p?.principalId).toBe(PROVIDER_PRINCIPALS.midtrans);
    expect(providerForTenant(T)?.provider.name).toBe("midtrans");
    expect(providerForTenant("99999999-2222-4333-8444-555555555555")).toBeNull();
    expect(configuredProvider("stripe")).toBeNull();
    expect(configuredProvider("MIDTRANS")).toBeNull();
    const line = describePaymentsConfig();
    expect(line).toMatch(/^online payment is on: midtrans sandbox/);
    expect(line).not.toContain("SB-Mid-server-x");
  });

  it("refuses to boot a half-configured money path", () => {
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "staging", tenantId: T };
    expect(() => describePaymentsConfig()).toThrow(/MIDTRANS_ENVIRONMENT/);
    expect(configuredProvider("midtrans")).toBeNull();
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "sandbox", tenantId: "" };
    expect(() => describePaymentsConfig()).toThrow(/MIDTRANS_TENANT_ID/);
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "sandbox", tenantId: "not-a-uuid" };
    expect(() => describePaymentsConfig()).toThrow(/MIDTRANS_TENANT_ID/);
  });

  it("says (does not refuse) when the key looks like the other environment's", () => {
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "production", tenantId: T };
    expect(describePaymentsConfig()).toMatch(/WARNING: the key looks like a sandbox key/);
    config.payments.midtrans = { serverKey: "Mid-server-x", environment: "sandbox", tenantId: T };
    expect(describePaymentsConfig()).toMatch(/WARNING: the key looks like a production key/);
  });
});

// PV-D41 — the simulated Midtrans: the flag and `simulated` come together or not at all.
describe("payments registry · simulated Midtrans (PV-D41)", () => {
  let saved: typeof config.payments.midtrans;
  let savedFlag: boolean;
  beforeEach(() => { saved = { ...config.payments.midtrans }; savedFlag = config.payments.simulationEnabled; });
  afterEach(() => { config.payments.midtrans = saved; config.payments.simulationEnabled = savedFlag; });

  it("flag + simulated: on, labelled, and the adapter points at the in-process simulator", () => {
    config.payments.simulationEnabled = true;
    config.payments.midtrans = { serverKey: "SIM-abc", environment: "simulated", tenantId: T };
    expect(describePaymentsConfig()).toMatch(/^\[payments:simulation-enabled\] online payment is SIMULATED/);
    const p = configuredProvider("midtrans");
    expect(p?.provider.environment).toBe("simulated");
    expect(simulationActive()).toBe(true);
    expect(simulatorBaseUrl()).toBe(`${config.payments.simulatorInternalUrl}/internal/payments/midtrans-sim`);
  });

  it("refuses to boot either half alone, and the flag without a key", () => {
    config.payments.simulationEnabled = true;
    config.payments.midtrans = { serverKey: "SB-Mid-server-x", environment: "sandbox", tenantId: T };
    expect(() => describePaymentsConfig()).toThrow(/needs MIDTRANS_ENVIRONMENT=simulated/);
    expect(configuredProvider("midtrans")).toBeNull();
    config.payments.midtrans = { serverKey: "Mid-server-x", environment: "production", tenantId: T };
    expect(() => describePaymentsConfig()).toThrow(/needs MIDTRANS_ENVIRONMENT=simulated/);
    config.payments.midtrans = { serverKey: "", environment: "simulated", tenantId: T };
    expect(() => describePaymentsConfig()).toThrow(/needs MIDTRANS_SERVER_KEY/);
    config.payments.simulationEnabled = false;
    config.payments.midtrans = { serverKey: "SIM-abc", environment: "simulated", tenantId: T };
    expect(() => describePaymentsConfig()).toThrow(/needs PAYMENTS_SIMULATION_ENABLED=1/);
    expect(configuredProvider("midtrans")).toBeNull();
    expect(simulationActive()).toBe(false);
  });
});
