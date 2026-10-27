// M6-P6o — the write's seven steps (deploy-secret-write.ts) against the in-memory GitHub (core/github/git-data.testkit.ts), with
// the database ports in memory. What this suite tries to falsify:
//   * the value written is the vault's canonical value, sealed so that the org's PRIVATE key opens it (the sealing is right);
//   * a new secret is created visible to NO repository (the write never widens access); a name the grant already holds keeps
//     exactly this repo; the grant step runs once, after a successful write, and never after a failed one;
//   * a rotation (a new sealed version) rewrites the secret, and afterwards GitHub holds the new value;
//   * O-3 (no `organization_secrets`) is the typed refusal, before the vault is decrypted and before any write;
//   * a revoked (archived) site, a resealed vault, a mismatched credential or another repository id write nothing;
//   * a far-side error that echoes the value reaches neither the refusal nor the ledger.
// The DB-backed half (RLS, the approval, the ledger in `activities`, the leak scan over every row) is deploy-secret.db.test.ts.
import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GithubApiError } from "../../core/github/errors";
import { siteDeploySecretName, type DeployGrantRow } from "./deploy-grant";
import { parseDeployCredential } from "./deploy-credential";
import {
  DeploySecretRefusal, writeDeploySecret, type DeploySecretArgs, type DeploySecretWriteDeps, type EnvRowFacts, type VaultFacts,
} from "./deploy-secret-write";
import { toDeploySecretRefusal } from "./deploy-secret.service";
import { findSecretValueLeaks } from "../../testing/secret-value-leaks";

const SITE = "33333333-3333-4333-8333-333333333333";
const ROW = "55555555-5555-4555-8555-555555555555";
const CONN = "66666666-6666-4666-8666-666666666666";
const V1 = "a".repeat(64);
const V2 = "b".repeat(64);
const REPO = { owner: "acme-org", name: "acme-site" };

const canary = (tag: string): string => `canary-${tag}-${randomBytes(12).toString("hex")}`;

function credential(over: Record<string, unknown> = {}): { canonical: string; password: string } {
  const password = canary("pw");
  const p = parseDeployCredential({
    version: 1, environment: "staging", transport: "sftp", host: "sftp.example.invalid", port: 65002, user: "u_site_stg", password,
    knownHosts: "[sftp.example.invalid]:65002 ssh-ed25519 AAAAplaceholder", remoteBase: "/home/u/domains/stg", docroot: "public_html",
    siteUrl: "https://stg.example.invalid", ...over,
  });
  if (!p.ok) throw new Error(`fixture: ${p.problems.join(";")}`);
  return { canonical: p.canonical, password: (over.password as string | undefined) ?? password };
}

function siteRow(over: Partial<DeployGrantRow> = {}): DeployGrantRow {
  return {
    id: SITE, tenantId: "t", slug: "acme-site", provider: "erp_repo", providerRef: "approval-1", status: "live",
    repoUrl: "https://github.com/acme-org/acme-site", completionState: "complete", contractSnapshotId: "s", webdevSiteId: ROW,
    scaffoldState: "committed", grantState: null, grantSecretNames: [], grantSnapshotId: null, grantRepositoryId: null,
    grantHeadSha: null, grantError: null, grantSiteSecretName: null, grantPendingNames: [], ...over,
  };
}

const args = (over: Partial<DeploySecretArgs> = {}): DeploySecretArgs => ({
  provisionedSiteId: SITE, webdevSiteId: ROW, environment: "staging", connectionId: CONN, sealedVersion: V1, ...over,
});

async function harness(o: { site?: Partial<DeployGrantRow>; env?: Partial<EnvRowFacts>; vault?: Partial<VaultFacts>; value?: string } = {}) {
  const gh = new FakeGithub(REPO.owner, REPO.name);
  await gh.useOrgKeyPair("kid-1");
  const state = {
    site: siteRow(o.site),
    env: { id: ROW, environment: "staging", origin: "provisioned", deleted: false, access: "ssh", kind: "static", vaultRef: CONN, clientId: null, ...o.env } as EnvRowFacts,
    vault: { id: CONN, provider: "ssh", status: "linked", ownerKind: "company", ownerId: "t", sealedVersion: V1, ...o.vault } as VaultFacts,
    value: o.value ?? credential().canonical,
  };
  const ledger: Array<{ secretName: string; outcome: string; error?: string }> = [];
  const counts = { opened: 0, grants: 0 };
  const deps: DeploySecretWriteDeps = {
    loadFacts: async () => ({ env: { ...state.env }, site: { ...state.site }, vault: { ...state.vault } }),
    resolveRepo: async () => ({ ...REPO }),
    git: gh.caller(),
    openVault: async (id) => {
      counts.opened += 1;
      return id === CONN ? state.value : null;
    },
    ledger: async (target, perform) => {
      try {
        const r = await perform();
        ledger.push({ secretName: target.secretName, outcome: "succeeded" });
        return r;
      } catch (err) {
        ledger.push({ secretName: target.secretName, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    grant: async () => {
      counts.grants += 1;
      return { outcome: "granted", state: "granted", error: null };
    },
    classifyError: toDeploySecretRefusal,
  };
  const name = siteDeploySecretName({ slug: REPO.name, environment: "staging", repositoryId: gh.repoId });
  return { gh, state, deps, ledger, counts, name };
}

async function refusal(p: Promise<unknown>): Promise<DeploySecretRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DeploySecretRefusal) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

const valueCalls = (gh: FakeGithub) => gh.calls.filter((c) => c.method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(c.path));

describe("M6-P6o · writeDeploySecret (pure, against the fake GitHub)", () => {
  it("SEAL, WRITE, GRANT: the stored box opens with the org's private key to the vault's canonical value; created visible to no repo; then the grant", async () => {
    const h = await harness();
    const r = await writeDeploySecret(h.deps, args());
    expect(r).toMatchObject({
      outcome: "written", secretName: h.name, environment: "staging", repo: "acme-org/acme-site", repositoryId: h.gh.repoId,
      written: "created", keyId: "kid-1", selectedRepositoryIds: [], sealedVersion: V1, grant: { outcome: "granted" },
    });
    // The sealing is correct: GitHub's side (the private key) recovers exactly what the vault holds.
    expect(await h.gh.openOrgSecretValue(h.name)).toBe(h.state.value);
    expect(h.gh.orgSecrets.get(h.name)).toEqual({ visibility: "selected", repos: new Set() });
    const [put] = valueCalls(h.gh);
    expect(Object.keys(put.body as object).sort()).toEqual(["encrypted_value", "key_id", "selected_repository_ids", "visibility"]);
    expect(h.counts).toEqual({ opened: 1, grants: 1 });
    expect(h.ledger).toEqual([{ secretName: h.name, outcome: "succeeded" }]);
    // Order: the public key before the value write; no plaintext in any recorded call.
    const paths = h.gh.calls.map((c) => `${c.method} ${c.path.replace(h.name, "<name>")}`);
    expect(paths).toEqual([
      "GET /repos/acme-org/acme-site",
      "GET /orgs/acme-org/actions/secrets/public-key",
      "GET /orgs/acme-org/actions/secrets/<name>",
      "PUT /orgs/acme-org/actions/secrets/<name>",
    ]);
    const pw = JSON.parse(h.state.value).password as string;
    expect(findSecretValueLeaks(h.gh.calls.map((c, i) => ({ where: `call#${i}`, text: JSON.stringify(c) })), { pw, canonical: h.state.value })).toEqual([]);
  });

  it("a name the grant ALREADY holds keeps exactly this repo (no deploy window), answered as an update", async () => {
    const h = await harness();
    h.state.site = siteRow({ grantState: "granted", grantRepositoryId: h.gh.repoId, grantSecretNames: ["WEBDESK_DEPLOY_GRANT", h.name] });
    h.gh.addOrgSecret(h.name, "selected", [h.gh.repoId, 999]);
    const r = await writeDeploySecret(h.deps, args());
    expect(r).toMatchObject({ written: "updated", selectedRepositoryIds: [h.gh.repoId] });
    // A repo someone added by hand is gone: the secret is visible to exactly this site's repo.
    expect([...h.gh.orgSecrets.get(h.name)!.repos]).toEqual([h.gh.repoId]);
  });

  it("ROTATION: the vault is resealed (new version), the rewrite lands, and GitHub then holds the NEW value", async () => {
    const h = await harness();
    await writeDeploySecret(h.deps, args());
    const first = h.state.value;
    const next = credential().canonical;
    h.state.value = next;
    h.state.vault = { ...h.state.vault, sealedVersion: V2 };
    // The approval for the OLD version no longer writes: the decider approved a specific sealed value.
    expect((await refusal(writeDeploySecret(h.deps, args()))).code).toBe("deploy_secret_vault_changed");
    const r = await writeDeploySecret(h.deps, args({ sealedVersion: V2 }));
    expect(r).toMatchObject({ written: "updated", sealedVersion: V2 });
    expect(await h.gh.openOrgSecretValue(h.name)).toBe(next);
    expect(next).not.toBe(first);
    expect(valueCalls(h.gh)).toHaveLength(2);
  });

  it("O-3: an App without organization_secrets is the TYPED refusal; the vault is never decrypted, nothing is written, no grant", async () => {
    const h = await harness();
    h.gh.orgSecretsPermission = false;
    const e = await refusal(writeDeploySecret(h.deps, args()));
    expect(e.code).toBe("github_permission_missing");
    expect(e.rowToken).toBe("github_permission_missing: organization_secrets");
    expect(e.status).toBe(503);
    expect(h.counts).toEqual({ opened: 0, grants: 0 });
    expect(valueCalls(h.gh)).toHaveLength(0);
    expect(h.ledger).toEqual([]);
  });

  it("a FAILED write is never followed by the grant, and a GitHub message echoing the value reaches neither the refusal nor the ledger", async () => {
    const h = await harness();
    const pw = JSON.parse(h.state.value).password as string;
    h.gh.beforeRequest = (method, path) => {
      if (method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(path)) throw new GithubApiError(`${method} ${path}`, 500, `upstream echoed ${pw}`);
    };
    const e = await refusal(writeDeploySecret(h.deps, args()));
    expect(e.code).toBe("github_request_failed");
    expect(h.counts.grants).toBe(0);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].outcome).toBe("failed");
    expect(findSecretValueLeaks([{ where: "refusal", text: `${e.message} ${e.detail}` }, { where: "ledger", text: JSON.stringify(h.ledger) }], { pw })).toEqual([]);
    expect(h.ledger[0].error).toContain("[redacted]");
  });

  it("an ARCHIVED (revoked) site gets nothing: no GitHub call, no decrypt, no grant (WSK-D82)", async () => {
    const h = await harness({ site: { grantState: "revoked" } });
    expect((await refusal(writeDeploySecret(h.deps, args()))).code).toBe("deploy_secret_site_revoked");
    expect(h.gh.calls).toHaveLength(0);
    expect(h.counts).toEqual({ opened: 0, grants: 0 });
  });

  it.each([
    ["the row points at another record", { vault: { id: "77777777-7777-4777-8777-777777777777" } }, "deploy_secret_vault_changed"],
    ["the record is not linked", { vault: { status: "unconfigured" } }, "deploy_secret_vault_unusable"],
    ["the record is a user's", { vault: { ownerKind: "user" } }, "deploy_secret_vault_unusable"],
    // M6-P6o2: a per-site record of ANOTHER row (another site, or this site's other environment) is never this row's key
    ["the record is another row's per-site record", { vault: { ownerKind: "webdev_site", ownerId: "88888888-8888-4888-8888-888888888888" } }, "deploy_secret_vault_unusable"],
    ["the record is ftp for an ssh row", { vault: { provider: "ftp" } }, "deploy_secret_vault_unusable"],
    ["the row is unbound", { env: { vaultRef: null } }, "deploy_secret_no_vault_record"],
    ["the row is a tracked estate row", { env: { origin: "tracked" } }, "deploy_secret_not_deliverable"],
    ["the row is deleted", { env: { deleted: true } }, "not_found"],
  ])("refuses before any GitHub call when %s", async (_l, over, code) => {
    const h = await harness(over as never);
    expect((await refusal(writeDeploySecret(h.deps, args()))).code).toBe(code);
    expect(h.gh.calls).toHaveLength(0);
    expect(h.counts.opened).toBe(0);
  });

  it.each([
    ["a production credential on the staging row", { environment: "production" }, "environment"],
    ["an ftps credential on an ssh record", { transport: "ftps", knownHosts: undefined, certSha256: "AB:CD" }, "transport"],
    ["a static site's credential with no docroot", { docroot: undefined }, "docroot"],
  ])("refuses %s after decrypting it in memory, and writes nothing", async (_l, over, qualifier) => {
    const h = await harness({ value: credential(over).canonical });
    const e = await refusal(writeDeploySecret(h.deps, args()));
    expect(e.code).toBe("deploy_secret_credential_mismatch");
    expect(e.qualifier).toBe(qualifier);
    expect(valueCalls(h.gh)).toHaveLength(0);
    expect(h.counts.grants).toBe(0);
  });

  it("M6-P6o2: a per-site record of THIS row is accepted and written; the refusal of another row's names vault_ref_wrong_owner", async () => {
    const own = await harness({ vault: { ownerKind: "webdev_site", ownerId: ROW } });
    expect(await writeDeploySecret(own.deps, args())).toMatchObject({ outcome: "written", written: "created" });
    expect(valueCalls(own.gh)).toHaveLength(1);
    const other = await harness({ vault: { ownerKind: "webdev_site", ownerId: "88888888-8888-4888-8888-888888888888" } });
    const e = await refusal(writeDeploySecret(other.deps, args()));
    expect(e.code).toBe("deploy_secret_vault_unusable");
    expect(e.qualifier).toBe("vault_ref_wrong_owner");
    expect(other.gh.calls).toHaveLength(0);
    expect(other.counts).toEqual({ opened: 0, grants: 0 });
  });

  it("a recorded grant for another repository id is superseded; nothing written", async () => {
    const h = await harness({ site: { grantRepositoryId: 1 } });
    expect((await refusal(writeDeploySecret(h.deps, args()))).code).toBe("deploy_secret_superseded");
    expect(valueCalls(h.gh)).toHaveLength(0);
  });

  it("a stored value that is not a valid credential is refused naming fields only", async () => {
    const pw = canary("pw");
    const h = await harness({ value: JSON.stringify({ version: 1, password: pw }) });
    const e = await refusal(writeDeploySecret(h.deps, args()));
    expect(e.code).toBe("deploy_credential_invalid");
    expect(findSecretValueLeaks([{ where: "refusal", text: e.message }], { pw })).toEqual([]);
    expect(valueCalls(h.gh)).toHaveLength(0);
  });
});
