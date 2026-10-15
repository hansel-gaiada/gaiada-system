import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-7j j0 (BFF §40.6.1): a functional reader over a module's tables runs only when the company has that module. Pure: the module
// check is mocked, so this pins the registration (which module each reader is gated on) and the `null`-never-an-error answer for
// a company without it. Each reader's own database test proves its rows.
const { isModuleEnabled } = vi.hoisted(() => ({ isModuleEnabled: vi.fn<(tenantId: string, key: string) => Promise<boolean>>() }));
vi.mock("../../../registry", () => ({ isModuleEnabled: (t: string, k: string) => isModuleEnabled(t, k) }));

import { FUNCTIONAL_READERS } from "./index";
import { DELIVERY_READERS, gated as deliveryGated } from "../delivery";
import { gated } from "../gated";

const ctx = { tenantId: "t-1", unitId: "u-1", periodKind: "month" as const, start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-14" };
/** The readers over the finance module's tables (the payments reader reads a core table and is not gated). */
const FINANCE_GATED = ["gm.margin", "finance.close_on_time", "finance.overdue_receivables_share"];
/** HR's readers: f3 to f5 read HR's tables, f6 reads the LMS module's (its walls also open hr). */
const HR_GATED = ["hr.leave_decided_2d", "hr.payroll_on_time", "hr.time_to_hire"];
const LMS_GATED = ["hr.mandatory_learning"];

describe("functional readers: registration and the module gate", () => {
  beforeEach(() => isModuleEnabled.mockReset());

  it("registers the DW-7j readers under their catalogue ids", () => {
    expect(Object.keys(FUNCTIONAL_READERS).sort()).toEqual(
      [
        "finance.close_on_time", "finance.overdue_receivables_share", "finance.payments_confirmed_1d", "gm.margin",
        "hr.leave_decided_2d", "hr.mandatory_learning", "hr.payroll_on_time", "hr.time_to_hire",
      ],
    );
  });

  it("DW-6's registry keeps exporting the same gate, and its ids do not collide with ours", () => {
    expect(deliveryGated).toBe(gated);
    expect(Object.keys(DELIVERY_READERS).filter((id) => id in FUNCTIONAL_READERS)).toEqual([]);
  });

  it("answers null without running when the company does not have the finance module, and asks about exactly that module", async () => {
    isModuleEnabled.mockResolvedValue(false);
    for (const id of FINANCE_GATED) expect(await FUNCTIONAL_READERS[id](ctx), id).toBeNull();
    expect(isModuleEnabled).toHaveBeenCalledTimes(FINANCE_GATED.length);
    expect(new Set(isModuleEnabled.mock.calls.map(([t, k]) => `${t}/${k}`))).toEqual(new Set(["t-1/finance"]));
  });

  it("HR's readers answer null without running when the company lacks the module they read (hr for f3 to f5, lms for f6)", async () => {
    isModuleEnabled.mockResolvedValue(false);
    for (const id of [...HR_GATED, ...LMS_GATED]) expect(await FUNCTIONAL_READERS[id](ctx), id).toBeNull();
    expect(isModuleEnabled).toHaveBeenCalledTimes(HR_GATED.length + LMS_GATED.length);
    expect(new Set(isModuleEnabled.mock.calls.map(([t, k]) => `${t}/${k}`))).toEqual(new Set(["t-1/hr", "t-1/lms"]));
    expect(isModuleEnabled.mock.calls.filter(([, k]) => k === "lms")).toHaveLength(LMS_GATED.length);
  });

  it("runs the reader when the company has the module", async () => {
    isModuleEnabled.mockResolvedValue(true);
    const read = vi.fn(async () => ({ value: 0.5 }));
    expect(await gated("finance", read)(ctx)).toEqual({ value: 0.5 });
    expect(read).toHaveBeenCalledWith(ctx);
  });
});
