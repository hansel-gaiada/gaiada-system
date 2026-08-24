// SIM-F9 — the run's tenant is supplied by the runner, never by the model.
//
// These pin the four behaviours the fix depends on. The one that matters most is the OVERRIDE case:
// the live simulation caught the model inventing tenant ids from surrounding text ("live-02", the
// simulation's own run id), and a fill-the-gap-only implementation would have honoured every one of
// them.
import { describe, it, expect, vi } from "vitest";
import { tenantContext, withRunTenant } from "./deps";

const TENANT = "019fb652-c68b-728f-b779-04465fcec5ae";

describe("withRunTenant", () => {
  it("fills in the run's tenant when the model supplied none", () => {
    const out = tenantContext.run(TENANT, () => withRunTenant({ limit: 10 }));
    expect(out).toEqual({ limit: 10, tenantId: TENANT });
  });

  it("OVERRIDES a model-supplied tenant that disagrees with the run", () => {
    // "live-02" is verbatim what the model sent on the live estate, lifted out of the goal text.
    const onOverride = vi.fn();
    const out = tenantContext.run(TENANT, () => withRunTenant({ tenantId: "live-02" }, onOverride));
    expect(out.tenantId).toBe(TENANT);
    expect(onOverride).toHaveBeenCalledWith("live-02", TENANT);
  });

  it("does not report an override when the model happened to agree", () => {
    const onOverride = vi.fn();
    const out = tenantContext.run(TENANT, () => withRunTenant({ tenantId: TENANT }, onOverride));
    expect(out.tenantId).toBe(TENANT);
    // The signal exists to reveal GUESSING. Firing it on agreement would bury the real cases.
    expect(onOverride).not.toHaveBeenCalled();
  });

  it("leaves args untouched outside a run context", () => {
    // The CLI and direct runAgent() callers never open tenantContext. They must behave exactly as
    // they did before this existed — fail-soft, not fail-closed.
    const args = { tenantId: "whatever-the-caller-chose" };
    expect(withRunTenant(args)).toEqual(args);
  });

  it("does not mutate the caller's args object", () => {
    // agent.ts hashes raw tool args for the D14 approval grant (`argsSha256`). Mutating in place
    // would change the object the grant was filed from and break every legitimate re-drive.
    const original = { tenantId: "guessed", other: 1 };
    const copy = { ...original };
    tenantContext.run(TENANT, () => withRunTenant(original));
    expect(original).toEqual(copy);
  });
});
