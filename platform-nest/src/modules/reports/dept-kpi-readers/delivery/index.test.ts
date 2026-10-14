import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-6n (BFF §40.5.1): a reader over a module's tables runs only when the company has that module. Pure: the module check is
// mocked, so this pins the gate's behaviour; each reader's own database test proves its rows.
// vi.mock's factory is hoisted above the imports; vi.hoisted() makes the mock function exist before it runs.
const { isModuleEnabled } = vi.hoisted(() => ({ isModuleEnabled: vi.fn<(tenantId: string, key: string) => Promise<boolean>>() }));
vi.mock("../../../registry", () => ({ isModuleEnabled: (t: string, k: string) => isModuleEnabled(t, k) }));

import { gated, DELIVERY_READERS } from "./index";
const ctx = { tenantId: "t-1", unitId: "u-1", periodKind: "month" as const, start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-14" };

describe("delivery readers: the module gate", () => {
  beforeEach(() => isModuleEnabled.mockReset());

  it("runs the reader when the company has the module, and asks about exactly that module and company", async () => {
    isModuleEnabled.mockResolvedValue(true);
    const read = vi.fn(async () => ({ value: 0.5 }));
    expect(await gated("search", read)(ctx)).toEqual({ value: 0.5 });
    expect(read).toHaveBeenCalledWith(ctx);
    expect(isModuleEnabled).toHaveBeenCalledWith("t-1", "search");
  });

  it("answers null (no_data) without running the reader when the company does not have the module", async () => {
    isModuleEnabled.mockResolvedValue(false);
    const read = vi.fn(async () => ({ value: 0.5 }));
    expect(await gated("social", read)(ctx)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("gates every reader over a module's tables (search, social, monitoring)", async () => {
    isModuleEnabled.mockResolvedValue(false);
    const moduleReaders = Object.keys(DELIVERY_READERS).filter((id) => /^(search|social|monitoring)\./.test(id));
    expect(moduleReaders.length).toBeGreaterThan(0);
    for (const id of moduleReaders) expect(await DELIVERY_READERS[id](ctx), id).toBeNull();
    const asked = isModuleEnabled.mock.calls.map(([, key]) => key);
    expect(new Set(asked)).toEqual(new Set(moduleReaders.map((id) => id.split(".")[0])));
  });
});
