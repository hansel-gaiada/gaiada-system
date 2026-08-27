// WSK-38 — pure unit test for ResidencyStatementService (design §11 "(d) A residency statement
// per tenant"). No database, no Nest bootstrap needed — this service reads only env/config.
import { describe, expect, it } from "vitest";
import { ResidencyStatementService } from "../src/privacy/residency-statement.service";

describe("residency statement (design §11 / WSK-D23)", () => {
  it("names self-hosted Postgres + MinIO explicitly, never Cloudflare/R2, for the default (now) backup phase", () => {
    const svc = new ResidencyStatementService();
    const statement = svc.buildFor("acme");

    expect(statement.sentence).toContain("acme");
    expect(statement.sentence).toContain("self-hosted");
    expect(statement.sentence).toContain("MinIO");
    // The sentence explicitly REASSURES "never Cloudflare R2" — it names Cloudflare only to rule
    // it out, so the real assertion is that it never claims we USE it.
    expect(statement.sentence.toLowerCase()).toContain("never cloudflare r2");
    expect(statement.sentence.toLowerCase()).not.toMatch(/\bstored on cloudflare\b/);
    expect(statement.facts.selfHostedOnly).toBe(true);
    expect(statement.facts.backupPhase).toBe("now");
  });

  it("describes the pull-model, no-standing-credential backup posture for the 'now' phase (§11 WSK-D23)", () => {
    const svc = new ResidencyStatementService();
    const statement = svc.buildFor("acme", "now");
    expect(statement.facts.backupTarget).toContain("pull-model");
    expect(statement.facts.backupTarget).toContain("cannot reach, overwrite, or delete");
  });

  it("describes Google Workspace as the staging-phase backup target (§11)", () => {
    const svc = new ResidencyStatementService();
    const statement = svc.buildFor("acme", "staging");
    expect(statement.facts.backupTarget).toContain("Google Workspace");
  });

  it("describes local server + NAS + RAID for target-state, explicitly noting RAID alone is not a backup", () => {
    const svc = new ResidencyStatementService();
    const statement = svc.buildFor("acme", "target-state");
    expect(statement.facts.backupTarget).toContain("NAS");
    expect(statement.facts.backupTarget.toLowerCase()).toContain("never treated as a backup");
  });
});
