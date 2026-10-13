// M6-P4g2 (WSK-D82) — an archived WebDesk site keeps no deploy access. `revokeDeployAfterArchive` runs AFTER an approved
// `site.archive` executed: every provisioned repo linked to the archived site's WebDesk tenant loses its deploy secrets,
// as the decider, and nothing it does can fail or undo the archive. Pure: the db and the deploy-grant service are stubbed;
// the archive route itself, against real Postgres + Cerbos, is webdesk-site-archive.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";

const db = vi.hoisted(() => ({ rows: [] as Array<{ id: string }>, fail: false, queries: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock("../../db", async (orig) => ({
  ...(await orig<typeof import("../../db")>()),
  withTenants: async (_ids: string[], fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[]) => {
        db.queries.push({ sql, params });
        if (db.fail) throw new Error("connection reset");
        return { rows: db.rows };
      },
    }),
}));
vi.mock("./deploy-grant.service", () => ({ revokeDeployForSite: vi.fn() }));

import { revokeDeployForSite } from "./deploy-grant.service";
import { DeployGrantRefusal } from "./deploy-grant";
import { revokeDeployAfterArchive } from "./webdesk-approved-command";
import type { Principal } from "../../rbac/principal";

const T = "019fb652-c68b-728f-b779-04465fcec5ae";
const decider = { userId: "decider-1", kind: "human" } as unknown as Principal;
const args = { command: "site.archive" as const, tenantSlug: "m6-gate-static-prd", siteId: "site-1" };

afterEach(() => {
  db.rows = [];
  db.fail = false;
  db.queries = [];
  vi.mocked(revokeDeployForSite).mockReset();
});

describe("revokeDeployAfterArchive (M6-P4g2)", () => {
  it("a never-provisioned site: nothing to revoke, no revoke call", async () => {
    expect(await revokeDeployAfterArchive(T, "appr-1", args, decider)).toEqual([]);
    expect(revokeDeployForSite).not.toHaveBeenCalled();
    // looked up by THIS tenant and the archived site's WebDesk tenant slug
    expect(db.queries[0].params).toEqual([T, "m6-gate-static-prd"]);
    expect(db.queries[0].sql).toMatch(/webdesk_tenant_slug = \$2/);
  });

  it("each linked provisioned repo is revoked AS THE DECIDER, with a reason naming the site and the approval", async () => {
    db.rows = [{ id: "ps-1" }];
    vi.mocked(revokeDeployForSite).mockResolvedValue({ outcome: "revoked" } as never);
    expect(await revokeDeployAfterArchive(T, "appr-1", args, decider)).toEqual([{ provisionedSiteId: "ps-1", outcome: "revoked", error: null }]);
    const [p, t, id, reason] = vi.mocked(revokeDeployForSite).mock.calls[0];
    expect(p).toBe(decider);
    expect([t, id]).toEqual([T, "ps-1"]);
    expect(reason).toMatch(/site-1/);
    expect(reason).toMatch(/appr-1/);
  });

  it("not_granted passes through (the ERP never granted it, e.g. before O-3)", async () => {
    db.rows = [{ id: "ps-1" }];
    vi.mocked(revokeDeployForSite).mockResolvedValue({ outcome: "not_granted" } as never);
    expect((await revokeDeployAfterArchive(T, "appr-1", args, decider))[0].outcome).toBe("not_granted");
  });

  it("a refused revoke is reported with its row token, never thrown: the archive stands", async () => {
    db.rows = [{ id: "ps-1" }, { id: "ps-2" }];
    vi.mocked(revokeDeployForSite)
      .mockRejectedValueOnce(new DeployGrantRefusal("github_permission_missing" as never, "organization_secrets missing", "organization_secrets"))
      .mockResolvedValueOnce({ outcome: "revoked" } as never);
    const out = await revokeDeployAfterArchive(T, "appr-1", args, decider);
    expect(out[0]).toMatchObject({ provisionedSiteId: "ps-1", outcome: "failed" });
    expect(out[0].error).toMatch(/^github_permission_missing/);
    expect(out[1]).toEqual({ provisionedSiteId: "ps-2", outcome: "revoked", error: null });
  });

  it("a decider without the revoke's permissions is reported `forbidden`, never elevated", async () => {
    db.rows = [{ id: "ps-1" }];
    vi.mocked(revokeDeployForSite).mockRejectedValue(new ForbiddenException());
    expect(await revokeDeployAfterArchive(T, "appr-1", args, decider)).toEqual([{ provisionedSiteId: "ps-1", outcome: "failed", error: "forbidden" }]);
  });

  it("an unexpected error is a typed failure, not a leak of its message", async () => {
    db.rows = [{ id: "ps-1" }];
    vi.mocked(revokeDeployForSite).mockRejectedValue(new Error("socket hang up token=abc"));
    expect(await revokeDeployAfterArchive(T, "appr-1", args, decider)).toEqual([{ provisionedSiteId: "ps-1", outcome: "failed", error: "deploy_revoke_failed" }]);
  });

  it("a failed lookup is reported, not thrown", async () => {
    db.fail = true;
    expect(await revokeDeployAfterArchive(T, "appr-1", args, decider)).toEqual([{ provisionedSiteId: "(unknown)", outcome: "failed", error: "lookup_failed" }]);
    expect(revokeDeployForSite).not.toHaveBeenCalled();
  });
});
