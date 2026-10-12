// M5-G5 — the retention purge's configuration, without a database. The purge itself is proven against real
// Postgres in agency-lead-retention.db.test.ts (the Linux gate).
import { describe, it, expect } from "vitest";
import { DEFAULT_RETENTION_MONTHS, leadRetentionConfig, positiveIntEnv } from "./agency-lead-retention";

describe("positiveIntEnv — an empty or odd value NEVER becomes 0", () => {
  it.each([
    [undefined, 24],
    ["", 24], // the compose ${VAR:-} trap: Number("") is 0, and a 0-month retention deletes every unconverted lead
    ["   ", 24],
    ["0", 24],
    ["-3", 24],
    ["1.5", 24],
    ["24abc", 24],
    ["abc", 24],
    ["1e3", 24],
    ["99999999999999999999", 24], // not a safe integer
    ["36", 36],
    [" 12 ", 12],
    ["1", 1],
  ])("%j -> %i", (raw, want) => {
    expect(positiveIntEnv(raw as string | undefined, 24)).toBe(want);
  });
});

describe("leadRetentionConfig", () => {
  it("defaults: dark, 24 months, daily, batches of 200", () => {
    expect(leadRetentionConfig({})).toEqual({ enabled: false, months: DEFAULT_RETENTION_MONTHS, intervalMs: 86_400_000, batch: 200 });
    expect(DEFAULT_RETENTION_MONTHS).toBe(24);
  });

  it("is enabled only by 1/true, and reads every knob", () => {
    expect(leadRetentionConfig({ AGENCY_LEAD_RETENTION_PURGE_ENABLED: "1" }).enabled).toBe(true);
    expect(leadRetentionConfig({ AGENCY_LEAD_RETENTION_PURGE_ENABLED: "TRUE" }).enabled).toBe(true);
    expect(leadRetentionConfig({ AGENCY_LEAD_RETENTION_PURGE_ENABLED: "yes" }).enabled).toBe(false);
    expect(leadRetentionConfig({ AGENCY_LEAD_RETENTION_PURGE_ENABLED: "" }).enabled).toBe(false);
    expect(
      leadRetentionConfig({
        AGENCY_LEAD_RETENTION_MONTHS: "18", AGENCY_LEAD_RETENTION_INTERVAL_MS: "3600000", AGENCY_LEAD_RETENTION_BATCH: "50",
      }),
    ).toMatchObject({ months: 18, intervalMs: 3_600_000, batch: 50 });
  });

  it("an empty months/interval/batch keeps the defaults (no busy loop, no zero retention)", () => {
    expect(
      leadRetentionConfig({ AGENCY_LEAD_RETENTION_MONTHS: "", AGENCY_LEAD_RETENTION_INTERVAL_MS: "", AGENCY_LEAD_RETENTION_BATCH: "" }),
    ).toMatchObject({ months: 24, intervalMs: 86_400_000, batch: 200 });
  });
});
