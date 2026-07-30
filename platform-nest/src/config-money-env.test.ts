// Pins config.ts's money-cap env validation (tracker §6r).
//
// The guard exists because of a defect found at the SM-40/42/18 QA gate, and the *shape* of that
// defect is why this test lives here rather than next to evaluateBudget: a malformed cap
// (`Number("50 usd")` → NaN) let the budget tier be entered and then compared against NaN, where
// every comparison is false by IEEE-754 — a tier that looked configured and enforced nothing.
//
// The gate proposed coercing NaN to `null`. That does not work, and proving it is what led here:
// an inert NaN tier and a skipped null tier enforce EXACTLY the same nothing, so coercion changes
// no behaviour — it only relocates the silence. Nothing downstream of the parse can tell "no cap
// was set" apart from "a cap I could not read", so the only place the distinction still exists is
// the parse site itself. Hence: unset => null (a deliberate, documented skip); set-but-
// uninterpretable => THROW at boot.
//
// The hazard is not arithmetic, it is silent misconfiguration: an operator sets a spend ceiling,
// believes the platform enforces it, and it does not. Everything else on this money path fails
// closed (pillar kill switch, tool scope, ceiling-unavailable, provider capability), so refusing to
// start is the consistent answer. A boot failure is loud and cheap; an unenforced ceiling is silent
// and is discovered by the invoice.
//
// config.ts evaluates at import, so each case is exercised in a FRESH module registry with the env
// var set beforehand — importing once and mutating process.env afterwards would prove nothing.
import { describe, it, expect, afterEach, vi } from "vitest";

const VAR = "DATAFORSEO_MONTHLY_CAP_USD";

async function loadConfigWith(value: string | undefined): Promise<{ cap: number | null } | Error> {
  const prior = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  vi.resetModules(); // force config.ts to re-evaluate its module-level parse
  try {
    const mod = await import("./config");
    return { cap: mod.config.search.providerMonthlyCapUsd.dataforseo };
  } catch (e) {
    return e as Error;
  } finally {
    if (prior === undefined) delete process.env[VAR];
    else process.env[VAR] = prior;
  }
}

describe("config money-cap env validation (§6r)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("UNSET is a deliberate skip, not an error — the platform must not invent a ceiling", async () => {
    const r = await loadConfigWith(undefined);
    expect(r).not.toBeInstanceOf(Error);
    expect((r as { cap: number | null }).cap).toBeNull();
  });

  it("a valid positive value is parsed through", async () => {
    const r = await loadConfigWith("50");
    expect(r).not.toBeInstanceOf(Error);
    expect((r as { cap: number | null }).cap).toBe(50);
  });

  // The actual regression: each of these previously became NaN (or a nonsense cap) and left the
  // tier silently unenforced. Every one must now refuse to boot, naming the variable so the operator
  // can find it — an error that does not name the var just moves the guessing.
  it.each([
    ["a unit suffix (the realistic typo)", "50 usd"],
    ["free text", "abc"],
    ["zero — express 'no ceiling' by unsetting, not by $0", "0"],
    ["negative", "-10"],
    ["Infinity", "Infinity"],
    ["a bare minus", "-"],
  ])("REFUSES to boot on %s", async (_label, value) => {
    const r = await loadConfigWith(value);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain(VAR);
  });

  it("whitespace-only is treated as UNSET, not as malformed — an empty compose default must not brick the boot", async () => {
    // `FOO=` / `FOO="  "` in an env file is how "not configured" arrives in practice, so it must
    // take the skip path. Throwing here would turn a blank compose row into a boot failure.
    const r = await loadConfigWith("   ");
    expect(r).not.toBeInstanceOf(Error);
    expect((r as { cap: number | null }).cap).toBeNull();
  });
});

// ── SM-52 · the SAME hole on every OTHER money input ────────────────────────────────────────────
// The architect gate on the fix above found it covered exactly ONE variable. Everything else still
// parsed raw — including SEARCH_GLOBAL_MONTHLY_CAP_USD, which on a default deployment is the ONLY
// platform-wide ceiling (tenantMonthlyCapUsd is null unless set). So the hole I had reported as
// closed was still open on the most load-bearing cap in the system.
//
// `reservationFraction` was a worse variant than NaN: it silently substituted 0.5, so an operator who
// typed `0.7` got a different budget than they configured, with no signal anywhere. A silent
// substitution is harder to notice than a crash AND harder to notice than a NaN.
describe("SM-52 · every money input refuses a set-but-uninterpretable value", () => {
  afterEach(() => { vi.resetModules(); });

  async function loadWith(vars: Record<string, string | undefined>): Promise<any | Error> {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prior[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.resetModules();
    try {
      const mod = await import("./config");
      return mod.config.search;
    } catch (e) {
      return e as Error;
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  it.each([
    ["SEARCH_GLOBAL_MONTHLY_CAP_USD", "150 usd"],
    ["SEARCH_GLOBAL_MONTHLY_CAP_USD", "0"],
    ["SEARCH_TENANT_MONTHLY_CAP_USD", "abc"],
    ["SEARCH_BUDGET_WARN_RATIO", "eighty percent"],
    // A warn ratio above 1 parses fine as a number but could only fire PAST the cap it exists to
    // pre-empt — inert by arithmetic, which is precisely the class this ticket closes.
    ["SEARCH_BUDGET_WARN_RATIO", "80"],
    ["SEMRUSH_PROVIDER_RESERVATION_FRACTION", "0.7x"],
    // Reserving more than 100% of a plan's allowance is not a reservation.
    ["AHREFS_PROVIDER_RESERVATION_FRACTION", "1.5"],
    ["SEMRUSH_MONTHLY_PLAN_PRICE_USD", "$499"],
    ["SEMRUSH_MONTHLY_UNIT_ALLOWANCE", "10,000"],
    ["AHREFS_MONTHLY_API_TIER_PRICE_USD", "n/a"],
    ["AHREFS_MONTHLY_UNIT_ALLOWANCE", "-5"],
  ])("%s=%s refuses to boot, naming the variable", async (name, value) => {
    const r = await loadWith({ [name]: value });
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain(name);
  });

  it("unset keeps every documented default — the guards must not change behaviour on a clean env", async () => {
    const r = await loadWith({
      SEARCH_GLOBAL_MONTHLY_CAP_USD: undefined,
      SEARCH_TENANT_MONTHLY_CAP_USD: undefined,
      SEARCH_BUDGET_WARN_RATIO: undefined,
      SEMRUSH_PROVIDER_RESERVATION_FRACTION: undefined,
    });
    expect(r).not.toBeInstanceOf(Error);
    expect(r.globalMonthlyCapUsd).toBe(150);
    expect(r.tenantMonthlyCapUsd).toBeNull();
    expect(r.budgetWarnRatio).toBeCloseTo(0.8);
  });

  it("a valid non-default reservation fraction is HONOURED, not silently replaced by 0.5", async () => {
    // The regression this pins: the old helper returned 0.5 for anything it disliked, so a typo and
    // a deliberate 0.7 were indistinguishable in behaviour. 0.7 must now mean 0.7.
    const r = await loadWith({
      SEMRUSH_PROVIDER_RESERVATION_FRACTION: "0.7",
      SEMRUSH_MONTHLY_PLAN_PRICE_USD: "500",
      SEMRUSH_API_KEY: "k",
    });
    expect(r).not.toBeInstanceOf(Error);
    expect(r.providerMonthlyCapUsd.semrush).toBeCloseTo(350); // 0.7 x 500, not 0.5 x 500 = 250
  });
});
