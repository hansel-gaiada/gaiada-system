// M6-P4g — the deploy grant's conditions and state machine, with no database: the site row lives in an in-memory
// transaction (commit on resolve, roll back on throw, like `withTenants`) and GitHub is the in-memory fake
// (core/github/git-data.testkit.ts, extended with the contents API and org Actions secrets).
//
// WHAT THIS SUITE TRIES TO FALSIFY:
//   1. a repo that is not registered, not committed, not the GH-12 one, or whose default branch has no (or the wrong)
//      CONTRACT.lock is granted NOTHING: every refusal happens before any write;
//   2. a grant PUTs each configured secret once, records it, and a re-grant is an idempotent no-op;
//   3. a partial grant (a write failed, or the answer was lost) resumes to completion, and a revoke after a crash still
//      removes what landed;
//   4. without `organization_secrets` (O-3) the refusal is the specific `github_permission_missing: organization_secrets`,
//      also through the REAL http client's 403 handling, never a generic error;
//   5. a secret that does not exist, or is visible to all repos, is reported per name and never written through;
//   6. the automatic trigger never undoes an operator's revoke;
//   7. (M6-P6a amendment, M6-P6f naming) the per-site secret's name is derived from the resolved repo (its name, the
//      environment and its GitHub id), cannot collide across two sites, matches the one fixture the site workflow's
//      shell derivation is also tested against, waits as `pending` until the owner creates it, and is only ever granted
//      to its own site's repo.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { GithubApiError } from "../../core/github/errors";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GithubInstallationClient, type FetchImpl } from "../../core/github/http-client";
import { InstallationRateLimiter } from "../../core/github/rate-limiter";
import type { GitCaller } from "../../core/github/git-data";
import { getFileAtRef, isValidSecretName } from "../../core/github/org-secrets";
import type { SnapshotFacts } from "./scaffold-commit";
import {
  DeployGrantRefusal, SITE_SECRET_NOT_DERIVABLE, grantDeploySecrets, parseDeploySecretNames, parseRevokeReason, revokeDeploySecrets,
  siteDeploySecretName,
  type DeployGrantDeps, type DeployGrantRow, type DeployGrantTx, type RegistryFacts,
} from "./deploy-grant";
import { classifyDeployGrantError } from "./deploy-grant.service";

const SNAP: SnapshotFacts = {
  id: "11111111-1111-4111-8111-111111111111",
  contractVersion: "1.0.0",
  vocabularyVersion: "1.1.0",
  contentHash: `sha256:${"a".repeat(64)}`,
};
const SITE = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const GRANT = "WEBDESK_DEPLOY_GRANT";
const KEY = "WEBDESK_DEPLOY_KEY";
/** The fake repo's GitHub id: the per-site name ends in it. */
const REPO_ID = new FakeGithub("acme-org", "acme-site").repoId;
/** This site's own per-site deploy secret (repo acme-site, environment staging, the fake repo's id). */
const SITE_SECRET = siteDeploySecretName({ slug: "acme-site", environment: "staging", repositoryId: REPO_ID });

const lockText = (over: Partial<Record<string, string>> = {}): string =>
  JSON.stringify(
    { blockLibraryVersion: "0.1.0", contentHash: SNAP.contentHash, contractVersion: SNAP.contractVersion, snapshotId: SNAP.id, vocabularyVersion: SNAP.vocabularyVersion, ...over },
    null,
    2,
  ) + "\n";

function grantableRow(over: Partial<DeployGrantRow> = {}): DeployGrantRow {
  return {
    id: SITE, tenantId: "t", slug: "acme-site", provider: "erp_repo", providerRef: "approval-1", status: "live",
    repoUrl: "https://github.com/acme-org/acme-site", completionState: "complete", contractSnapshotId: SNAP.id,
    webdevSiteId: "ws-1", scaffoldState: "committed", grantState: null, grantSecretNames: [], grantSnapshotId: null,
    grantRepositoryId: null, grantHeadSha: null, grantError: null, grantSiteSecretName: null, grantPendingNames: [], ...over,
  };
}

const liveRegistry = (over: Partial<RegistryFacts> = {}): RegistryFacts => ({
  id: "ws-1", deleted: false, origin: "provisioned", repoUrl: "https://github.com/acme-org/acme-site", environment: "staging", ...over,
});

/** The site row behind a lock: each `withLockedSite` works on a copy, kept only when the callback resolves. */
class MemSite {
  row: DeployGrantRow | null;
  registry: RegistryFacts | null;
  commits = 0;
  events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  revokeReason: string | null = null;
  /** Runs after each committed transaction (1 = the first read, 2 = the claim, …). */
  onCommit?: (n: number, site: MemSite) => void;

  constructor(row: DeployGrantRow | null, registry: RegistryFacts | null) {
    this.row = row;
    this.registry = registry;
  }

  async withLockedSite<T>(fn: (tx: DeployGrantTx) => Promise<T>): Promise<T> {
    let draft: DeployGrantRow | null = this.row ? { ...this.row, grantSecretNames: [...this.row.grantSecretNames] } : null;
    const events: MemSite["events"] = [];
    let reason: string | null = this.revokeReason;
    const tx: DeployGrantTx = {
      read: async () => (draft ? { ...draft, grantSecretNames: [...draft.grantSecretNames] } : null),
      readRegistry: async (id) => (this.registry && this.registry.id === id ? { ...this.registry } : null),
      claim: async (c) => {
        if (!draft || draft.scaffoldState !== "committed") throw new Error("guarded update matched 0 rows");
        const keep = draft.grantState === "pending" || draft.grantState === "granted";
        draft = {
          ...draft, grantState: keep ? draft.grantState : "pending", grantSecretNames: keep ? draft.grantSecretNames : [],
          grantPendingNames: keep ? draft.grantPendingNames : [],
          grantSnapshotId: c.snapshotId, grantRepositoryId: c.repositoryId, grantHeadSha: c.headSha, grantSiteSecretName: c.siteSecretName,
        };
      },
      recordPending: async (pending, error) => {
        if (!draft || draft.grantState === null) throw new Error("guarded update matched 0 rows");
        draft = { ...draft, grantPendingNames: [...pending], grantError: error };
      },
      recordSecretNames: async (names) => {
        if (!draft || draft.grantState === null) throw new Error("guarded update matched 0 rows");
        draft = { ...draft, grantSecretNames: [...names] };
      },
      markGranted: async (names) => {
        if (!draft || (draft.grantState !== "pending" && draft.grantState !== "granted")) throw new Error("guarded update matched 0 rows");
        draft = { ...draft, grantState: "granted", grantSecretNames: [...names], grantPendingNames: [], grantError: null };
        events.push({ type: "webdev.site.deploy_granted", payload: { secretNames: names } });
      },
      markRevoked: async (r) => {
        if (!draft || draft.grantState === null) throw new Error("guarded update matched 0 rows");
        draft = { ...draft, grantState: "revoked", grantSecretNames: [], grantPendingNames: [], grantRepositoryId: r.repositoryId, grantError: null };
        reason = r.reason;
        events.push({ type: "webdev.site.deploy_revoked", payload: { secretNames: r.revokedNames, reason: r.reason } });
      },
      recordError: async (token) => {
        if (draft) draft = { ...draft, grantError: token };
      },
    };
    const out = await fn(tx);
    this.row = draft;
    this.revokeReason = reason;
    this.events.push(...events);
    this.commits += 1;
    this.onCommit?.(this.commits, this);
    return out;
  }
}

interface Harness {
  gh: FakeGithub;
  site: MemSite;
  deps: DeployGrantDeps;
  ledger: Array<{ op: string; secretName: string; outcome: string }>;
  head: string;
}

function harness(opts: {
  row?: Partial<DeployGrantRow>;
  registry?: RegistryFacts | null;
  names?: string[];
  lock?: string | null;
  repo?: boolean;
  secrets?: Record<string, "all" | "private" | "selected">;
  /** false: the owner has not created this site's per-site secret yet. */
  siteSecret?: false | "all" | "private" | "selected";
  git?: (gh: FakeGithub) => GitCaller;
} = {}): Harness {
  const gh = new FakeGithub("acme-org", "acme-site");
  gh.seedTemplate({ "README.md": "# template\n", ".github/workflows/site.yml": "name: site\n" });
  const head = opts.lock === null
    ? gh.pushHumanCommit({ "src/index.astro": "<h1>Home</h1>\n" })
    : gh.pushHumanCommit({ "CONTRACT.lock": opts.lock ?? lockText(), "src/index.astro": "<h1>Home</h1>\n" });
  for (const [name, visibility] of Object.entries(opts.secrets ?? { [GRANT]: "selected" as const })) gh.addOrgSecret(name, visibility);
  if (opts.siteSecret !== false) gh.addOrgSecret(SITE_SECRET, opts.siteSecret ?? "selected");
  const site = new MemSite(grantableRow(opts.row), opts.registry === undefined ? liveRegistry() : opts.registry);
  const ledger: Harness["ledger"] = [];
  const deps: DeployGrantDeps = {
    withLockedSite: (fn) => site.withLockedSite(fn),
    readSnapshot: async (id) => (id === SNAP.id ? SNAP : null),
    resolveRepo: async () => (opts.repo === false ? null : { owner: "acme-org", name: "acme-site" }),
    git: opts.git ? opts.git(gh) : gh.caller(),
    secretNames: opts.names ?? [GRANT],
    ledger: async (op, target, perform) => {
      try {
        const r = await perform();
        ledger.push({ op, secretName: target.secretName, outcome: String(r) });
        return r;
      } catch (err) {
        ledger.push({ op, secretName: target.secretName, outcome: "failed" });
        throw err;
      }
    },
    actor: { userId: ACTOR },
    classifyError: classifyDeployGrantError,
  };
  return { gh, site, deps, ledger, head };
}

async function refusal(p: Promise<unknown>): Promise<DeployGrantRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DeployGrantRefusal) return err;
    throw err;
  }
  throw new Error("expected a DeployGrantRefusal, the call succeeded");
}

const writes = (gh: FakeGithub): number => gh.calls.filter((c) => c.method !== "GET").length;
const operator = { siteId: SITE, trigger: "operator" as const };
const scaffold = { siteId: SITE, trigger: "scaffold" as const };

describe("configuration", () => {
  it("WEBDESK_DEPLOY_SECRET_NAMES: empty means the default; a list is trimmed; a bad or repeated name refuses", () => {
    expect(parseDeploySecretNames("")).toEqual([GRANT]);
    expect(parseDeploySecretNames(undefined)).toEqual([GRANT]);
    expect(parseDeploySecretNames(`  ${GRANT} , ${KEY} `)).toEqual([GRANT, KEY]);
    for (const bad of ["GITHUB_TOKEN", "1ABC", "A-B", `${GRANT},`, `${GRANT},${GRANT.toLowerCase()}`]) {
      expect(() => parseDeploySecretNames(bad), bad).toThrow(DeployGrantRefusal);
    }
    expect(isValidSecretName("WEBDESK_DEPLOY_GRANT")).toBe(true);
    expect(isValidSecretName("github_x")).toBe(false);
  });

  it("no configured name refuses before anything is read", async () => {
    const h = harness({ names: [] });
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("deploy_grant_not_configured");
    expect(h.gh.calls).toHaveLength(0);
  });

  it("a revoke reason is required (8 to 500 characters)", () => {
    expect(() => parseRevokeReason({})).toThrow(DeployGrantRefusal);
    expect(() => parseRevokeReason({ reason: "  short " })).toThrow(DeployGrantRefusal);
    expect(() => parseRevokeReason({ reason: "x".repeat(501) })).toThrow(DeployGrantRefusal);
    expect(parseRevokeReason({ reason: "  site archived by the client  " })).toBe("site archived by the client");
  });
});

describe("the conditions (nothing is written for a repo that fails one)", () => {
  const cases: Array<[string, Parameters<typeof harness>[0], string]> = [
    ["not an ERP repo control row", { row: { provider: "provision" } }, "deploy_grant_repo_unresolved"],
    ["no provider_ref", { row: { providerRef: null } }, "deploy_grant_repo_unresolved"],
    ["completion not complete", { row: { completionState: "tenant_ready" } }, "deploy_grant_site_not_complete"],
    ["the repo step failed", { row: { status: "failed" } }, "deploy_grant_site_not_complete"],
    ["no registry link", { row: { webdevSiteId: null } }, "deploy_grant_no_registry_row"],
    ["the registry row is gone", { registry: null }, "deploy_grant_no_registry_row"],
    ["the registry row is soft-deleted", { registry: liveRegistry({ deleted: true }) }, "deploy_grant_no_registry_row"],
    ["the registry row is not a provisioned one", { registry: liveRegistry({ origin: "manual" }) }, "deploy_grant_no_registry_row"],
    ["the scaffold is not committed", { row: { scaffoldState: "commit_created" } }, "deploy_grant_not_committed"],
    ["the GH-12 repo cannot be proven", { repo: false }, "deploy_grant_repo_unresolved"],
    ["the registry names another repo", { registry: liveRegistry({ repoUrl: "https://github.com/acme-org/other" }) }, "deploy_grant_registry_mismatch"],
    ["no CONTRACT.lock on the default branch", { lock: null }, "deploy_grant_no_lock"],
    ["a lock that is not JSON", { lock: "not json" }, "deploy_grant_lock_invalid"],
    ["a lock with an extra key", { lock: JSON.stringify({ ...JSON.parse(lockText()), extra: "x" }) }, "deploy_grant_lock_invalid"],
    ["a lock naming another snapshot", { lock: lockText({ snapshotId: "99999999-9999-4999-8999-999999999999" }) }, "deploy_grant_lock_mismatch"],
    ["a lock with another content hash", { lock: lockText({ contentHash: `sha256:${"b".repeat(64)}` }) }, "deploy_grant_lock_mismatch"],
  ];
  for (const [what, opts, code] of cases) {
    it(`${what}: ${code}, recorded, no write`, async () => {
      const h = harness(opts);
      const e = await refusal(grantDeploySecrets(h.deps, operator));
      expect(e.code).toBe(code);
      expect(e.status).toBe(409);
      expect(writes(h.gh)).toBe(0);
      expect(h.site.row).toMatchObject({ grantState: null, grantError: code });
    });
  }

  it("the lock is read at the default branch's HEAD: a human commit deleting it after the scaffold refuses", async () => {
    const h = harness();
    h.gh.pushHumanDeletion(["CONTRACT.lock"]);
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("deploy_grant_no_lock");
    expect(h.gh.calls.some((c) => c.path.includes("/contents/CONTRACT.lock?ref=") && c.path.endsWith(h.gh.headOf() as string))).toBe(true);
  });

  it("a branch that is not the default one does not count: the default branch is what is read", async () => {
    const h = harness({ lock: null });
    h.gh.seedTemplate({ "CONTRACT.lock": lockText() }, "elsewhere");
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("deploy_grant_no_lock");
  });

  it("the site facts are re-checked under the lock before the claim: a registry row removed meanwhile refuses", async () => {
    const h = harness();
    h.site.onCommit = (n, site) => {
      if (n === 1) site.registry = null;
    };
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("deploy_grant_no_registry_row");
    expect(writes(h.gh)).toBe(0);
  });

  it("the contents API driver decodes GitHub's 60-column base64 and treats a directory as not a file", async () => {
    const h = harness();
    const bytes = await getFileAtRef(h.gh.caller(), { owner: "acme-org", name: "acme-site" }, "CONTRACT.lock", h.head);
    expect(bytes?.toString("utf8")).toBe(lockText());
    expect(await getFileAtRef(h.gh.caller(), { owner: "acme-org", name: "acme-site" }, "src", h.head)).toBeNull();
    expect(await getFileAtRef(h.gh.caller(), { owner: "acme-org", name: "acme-site" }, "nope.txt", h.head)).toBeNull();
  });
});

describe("the grant", () => {
  it("HAPPY PATH: each secret lists the repo, the row says granted with its facts, one ledgered write per secret", async () => {
    const h = harness({ names: [GRANT, KEY], secrets: { [GRANT]: "selected", [KEY]: "selected" } });
    const r = await grantDeploySecrets(h.deps, scaffold);
    expect(r).toMatchObject({
      outcome: "granted", state: "granted", repo: "acme-org/acme-site", repositoryId: h.gh.repoId, snapshotId: SNAP.id,
      headSha: h.head, error: null, siteSecretName: SITE_SECRET, pending: [],
      secrets: [{ name: GRANT, result: "granted" }, { name: KEY, result: "granted" }, { name: SITE_SECRET, result: "granted" }],
    });
    for (const n of [GRANT, KEY, SITE_SECRET]) expect([...h.gh.orgSecrets.get(n)!.repos]).toEqual([h.gh.repoId]);
    expect(h.site.row).toMatchObject({
      grantState: "granted", grantSecretNames: [GRANT, KEY, SITE_SECRET], grantRepositoryId: h.gh.repoId, grantSiteSecretName: SITE_SECRET,
    });
    expect(h.ledger).toEqual([
      { op: "grant", secretName: GRANT, outcome: "granted" },
      { op: "grant", secretName: KEY, outcome: "granted" },
      { op: "grant", secretName: SITE_SECRET, outcome: "granted" },
    ]);
    expect(h.gh.count("PUT", "/actions/secrets/")).toBe(3);
    expect(h.site.events.map((e) => e.type)).toEqual(["webdev.site.deploy_granted"]);
    // No call ever touches a secret value: only the metadata GET and the repository-list PUT.
    expect(h.gh.calls.filter((c) => c.path.includes("/actions/secrets/")).every((c) => c.method === "GET" || c.path.includes("/repositories/"))).toBe(true);
    expect(h.gh.calls.some((c) => c.path.includes("public-key"))).toBe(false);
  });

  it("IDEMPOTENT: an operator re-grant PUTs again (GitHub no-op) and stays granted; the scaffold re-submit makes no call", async () => {
    const h = harness();
    await grantDeploySecrets(h.deps, operator);
    const again = await grantDeploySecrets(h.deps, operator);
    expect(again).toMatchObject({ outcome: "granted", state: "granted" });
    expect(h.gh.orgSecrets.get(GRANT)!.repos.size).toBe(1);
    expect(h.gh.count("PUT", "/actions/secrets/")).toBe(4); // two secrets, twice

    const before = h.gh.calls.length;
    const quiet = await grantDeploySecrets(h.deps, scaffold);
    expect(quiet).toMatchObject({ outcome: "already_granted", state: "granted" });
    expect(h.gh.calls.length).toBe(before);
  });

  it("PARTIAL RESUME: the second PUT fails; the first is recorded; a re-run completes the grant", async () => {
    const h = harness({ names: [GRANT, KEY], secrets: { [GRANT]: "selected", [KEY]: "selected" } });
    let dropped = false;
    h.gh.beforeRequest = (method, path) => {
      if (method === "PUT" && path.includes(KEY) && !dropped) {
        dropped = true;
        throw new GithubApiError(`PUT ${path}`, 502, "Bad Gateway");
      }
    };
    const e = await refusal(grantDeploySecrets(h.deps, operator));
    expect(e.code).toBe("github_request_failed");
    expect(h.site.row).toMatchObject({ grantState: "pending", grantSecretNames: [GRANT], grantError: "github_request_failed" });

    const r = await grantDeploySecrets(h.deps, scaffold);
    expect(r).toMatchObject({ outcome: "granted", state: "granted", error: null });
    expect(h.site.row!.grantSecretNames).toEqual([GRANT, KEY, SITE_SECRET]);
    expect(h.gh.orgSecrets.get(KEY)!.repos.has(h.gh.repoId)).toBe(true);
  });

  it("LOST ANSWER: the PUT landed but its answer did not; the row is pending (claimed first), so a revoke still removes it", async () => {
    const h = harness();
    h.gh.afterRequest = (method) => {
      if (method === "PUT") throw new GithubApiError("PUT", 0, "network_error_or_timeout");
    };
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("github_request_failed");
    expect(h.gh.orgSecrets.get(GRANT)!.repos.has(h.gh.repoId)).toBe(true); // GitHub has it
    expect(h.site.row).toMatchObject({ grantState: "pending", grantSecretNames: [] }); // the ERP knows a PUT may have landed

    h.gh.afterRequest = undefined;
    const r = await revokeDeploySecrets(h.deps, { siteId: SITE, reason: "rollback after a lost answer" });
    expect(r.outcome).toBe("revoked");
    expect(h.gh.orgSecrets.get(GRANT)!.repos.size).toBe(0);
    expect(r.secrets.map((x) => x.name)).toContain(SITE_SECRET); // the recorded per-site name is swept too
  });

  it("O-3 NOT IN EFFECT: the org-secret calls answer 403; the refusal names organization_secrets and nothing is claimed", async () => {
    const h = harness();
    h.gh.orgSecretsPermission = false;
    const e = await refusal(grantDeploySecrets(h.deps, scaffold));
    expect(e.code).toBe("github_permission_missing");
    expect(e.status).toBe(503);
    expect(e.qualifier).toBe("organization_secrets");
    expect(e.detail).toMatch(/Organization permissions > Secrets: read and write/);
    expect(h.site.row).toMatchObject({ grantState: null, grantError: "github_permission_missing: organization_secrets" });
    expect(writes(h.gh)).toBe(0);

    // The owner grants it: the next attempt completes.
    h.gh.orgSecretsPermission = true;
    expect(await grantDeploySecrets(h.deps, scaffold)).toMatchObject({ outcome: "granted", error: null });
  });

  it("O-3 through the REAL http client: GitHub's 403 'Resource not accessible by integration' is surfaced at once and mapped", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403, headers: { "content-type": "application/json" } })) as unknown as FetchImpl;
    const client = new GithubInstallationClient({ getToken: async () => "t", onAuthExpired: () => {}, limiter: new InstallationRateLimiter(), fetchImpl });
    const h = harness({
      git: (gh) => {
        const fake = gh.caller();
        return (async (req: Parameters<GitCaller>[0]) =>
          req.path.startsWith("/orgs/") ? client.request(ACTOR, { ...req, role: "erp" }) : fake(req)) as GitCaller;
      },
    });
    const e = await refusal(grantDeploySecrets(h.deps, operator));
    expect(e.rowToken).toBe("github_permission_missing: organization_secrets");
  });

  it("A SECRET THAT DOES NOT EXIST YET is not an error: the grant is pending for that name and completes once it exists", async () => {
    const h = harness({ names: [GRANT, KEY], secrets: { [GRANT]: "selected" } });
    const r = await grantDeploySecrets(h.deps, scaffold);
    expect(r).toMatchObject({
      outcome: "pending", state: "pending", pending: [KEY], error: null,
      secrets: [{ name: GRANT, result: "granted" }, { name: KEY, result: "missing" }, { name: SITE_SECRET, result: "granted" }],
    });
    expect(h.site.row).toMatchObject({ grantSecretNames: [GRANT, SITE_SECRET], grantPendingNames: [KEY], grantError: null });
    expect(h.gh.count("PUT", KEY)).toBe(0);

    h.gh.addOrgSecret(KEY);
    expect(await grantDeploySecrets(h.deps, scaffold)).toMatchObject({ outcome: "granted", state: "granted", pending: [], error: null });
    expect(h.site.row!.grantPendingNames).toEqual([]);
  });

  it("THE PER-SITE SECRET before P6: the owner has not created it; the marker is granted and the site's own name waits", async () => {
    const h = harness({ siteSecret: false });
    const r = await grantDeploySecrets(h.deps, scaffold);
    expect(r).toMatchObject({ outcome: "pending", state: "pending", siteSecretName: SITE_SECRET, pending: [SITE_SECRET], error: null });
    expect(h.gh.orgSecrets.get(GRANT)!.repos.has(h.gh.repoId)).toBe(true);
    // The next trigger (a scaffold re-submit) is not short-circuited while pending, and completes it.
    h.gh.addOrgSecret(SITE_SECRET);
    expect(await grantDeploySecrets(h.deps, scaffold)).toMatchObject({ outcome: "granted", state: "granted", pending: [] });
    expect([...h.gh.orgSecrets.get(SITE_SECRET)!.repos]).toEqual([h.gh.repoId]);
  });

  it("A SECRET VISIBLE TO ALL REPOS voids the gate: it is never written through and is reported", async () => {
    const h = harness({ names: [GRANT], secrets: { [GRANT]: "all" } });
    const r = await grantDeploySecrets(h.deps, operator);
    expect(r).toMatchObject({
      outcome: "partial", state: "pending", secrets: [{ name: GRANT, result: "not_selected" }, { name: SITE_SECRET, result: "granted" }],
    });
    expect(r.error).toBe(`deploy_grant_secret_not_selected: ${GRANT}`);
    expect(h.gh.count("PUT", GRANT)).toBe(0);
  });

  it("the visibility changing between the read and the PUT (409) is reported the same way", async () => {
    const h = harness();
    h.gh.beforeRequest = (method, path) => {
      if (method === "PUT" && path.includes(GRANT)) h.gh.orgSecrets.get(GRANT)!.visibility = "private";
    };
    const r = await grantDeploySecrets(h.deps, operator);
    expect(r.secrets).toEqual([{ name: GRANT, result: "not_selected" }, { name: SITE_SECRET, result: "granted" }]);
    expect(r.outcome).toBe("partial");
    expect(r.state).toBe("pending");
  });

  it("a revoke landing between the claim and the writes wins: the grant is refused and nothing is written", async () => {
    const h = harness();
    h.site.onCommit = (n, site) => {
      if (n === 2 && site.row) site.row = { ...site.row, grantState: "revoked" };
    };
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("deploy_grant_superseded");
    expect(writes(h.gh)).toBe(0);
  });
});

describe("the revoke", () => {
  it("removes the repo from every secret (configured and recorded), records the reason, clears the names", async () => {
    const h = harness({ names: [GRANT, KEY], secrets: { [GRANT]: "selected", [KEY]: "selected" } });
    await grantDeploySecrets(h.deps, operator);
    // KEY is dropped from the configuration later: a revoke still removes it, because the row recorded it.
    const r = await revokeDeploySecrets({ ...h.deps, secretNames: [GRANT] }, { siteId: SITE, reason: "client contract ended" });
    expect(r).toMatchObject({ outcome: "revoked", state: "revoked", repositoryId: h.gh.repoId });
    expect(r.secrets.map((s) => s.name).sort()).toEqual([GRANT, KEY, SITE_SECRET].sort());
    expect(h.gh.orgSecrets.get(SITE_SECRET)!.repos.size).toBe(0);
    expect(h.gh.orgSecrets.get(GRANT)!.repos.size).toBe(0);
    expect(h.gh.orgSecrets.get(KEY)!.repos.size).toBe(0);
    expect(h.site.row).toMatchObject({ grantState: "revoked", grantSecretNames: [] });
    expect(h.site.revokeReason).toBe("client contract ended");
    expect(h.site.events.at(-1)).toMatchObject({ type: "webdev.site.deploy_revoked", payload: { reason: "client contract ended" } });
    expect(h.ledger.filter((l) => l.op === "revoke")).toHaveLength(3);
  });

  it("the automatic path never undoes an operator's revoke; an operator's POST does", async () => {
    const h = harness();
    await grantDeploySecrets(h.deps, operator);
    await revokeDeploySecrets(h.deps, { siteId: SITE, reason: "paused by the operator" });
    const before = h.gh.calls.length;
    expect(await grantDeploySecrets(h.deps, scaffold)).toMatchObject({ outcome: "skipped_revoked", state: "revoked" });
    expect(h.gh.calls.length).toBe(before);
    expect(await grantDeploySecrets(h.deps, operator)).toMatchObject({ outcome: "granted", state: "granted" });
    expect(h.gh.orgSecrets.get(GRANT)!.repos.has(h.gh.repoId)).toBe(true);
  });

  it("a site never granted is swept defensively and nothing is recorded; a missing secret is nothing to revoke", async () => {
    const h = harness({ names: [GRANT, KEY], secrets: { [GRANT]: "selected" }, siteSecret: false });
    h.gh.orgSecrets.get(GRANT)!.repos.add(h.gh.repoId); // a bypass made by hand in GitHub's UI
    const r = await revokeDeploySecrets(h.deps, { siteId: SITE, reason: "sweep a manual grant" });
    expect(r).toMatchObject({ outcome: "not_granted", state: null });
    // the per-site name is derived even with nothing recorded, so a hand-made one is swept as well
    expect(r.secrets).toEqual([{ name: GRANT, result: "revoked" }, { name: KEY, result: "missing" }, { name: SITE_SECRET, result: "missing" }]);
    expect(h.gh.orgSecrets.get(GRANT)!.repos.size).toBe(0);
    expect(h.site.row!.grantState).toBeNull();
  });

  it("a short reason refuses before any call; 403 without the permission is the specific refusal", async () => {
    const h = harness();
    expect((await refusal(revokeDeploySecrets(h.deps, { siteId: SITE, reason: "no" }))).code).toBe("deploy_grant_reason_required");
    expect(h.gh.calls).toHaveLength(0);
    await grantDeploySecrets(h.deps, operator);
    h.gh.orgSecretsPermission = false;
    const e = await refusal(revokeDeploySecrets(h.deps, { siteId: SITE, reason: "remove it please" }));
    expect(e.rowToken).toBe("github_permission_missing: organization_secrets");
    expect(h.site.row).toMatchObject({ grantState: "granted", grantSecretNames: [GRANT, SITE_SECRET] });
  });

  it("a secret visible to all repos cannot be revoked per repo: the state is kept and the reason recorded", async () => {
    const h = harness();
    await grantDeploySecrets(h.deps, operator);
    h.gh.orgSecrets.get(GRANT)!.visibility = "all";
    const r = await revokeDeploySecrets(h.deps, { siteId: SITE, reason: "remove it please" });
    expect(r).toMatchObject({ outcome: "partial", state: "granted", error: `deploy_grant_secret_not_selected: ${GRANT}` });
  });

  it("a non-GH-12 row refuses", async () => {
    const h = harness({ row: { provider: "provision" } });
    expect((await refusal(revokeDeploySecrets(h.deps, { siteId: SITE, reason: "remove it please" }))).code).toBe("deploy_grant_repo_unresolved");
  });
});

describe("the per-site secret's name (M6-P6a amendment; M6-P6f: it ends in the repository id)", () => {
  // ONE fixture for both sides: the site workflow's secret-name.sh is run against the same file by test-secret-name.sh.
  const FIXTURE = resolve(__dirname, "../../../../webdesk/templates/_deploy/secret-name.fixture.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    cases: Array<{ slug: string; environment: string; repositoryId: number; name: string }>;
    refusals: Array<{ why: string; slug: string; environment: string; repositoryId: unknown }>;
  };

  it("matches every case of the shared fixture, byte for byte", () => {
    expect(fixture.cases.length).toBeGreaterThan(5);
    for (const c of fixture.cases) {
      expect(siteDeploySecretName({ slug: c.slug, environment: c.environment, repositoryId: c.repositoryId }), JSON.stringify(c)).toBe(c.name);
      expect(isValidSecretName(c.name)).toBe(true);
    }
  });

  it("refuses every refusal of the shared fixture (what the shell derivation refuses)", () => {
    expect(fixture.refusals.length).toBeGreaterThan(5);
    for (const r of fixture.refusals) {
      expect(() => siteDeploySecretName({ slug: r.slug, environment: r.environment, repositoryId: r.repositoryId as number }), r.why).toThrow();
    }
  });

  it("is WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>: uppercased, non-alphanumerics to _, the GitHub repository id last; deterministic", () => {
    const n = siteDeploySecretName({ slug: "acme-site", environment: "staging", repositoryId: 123 });
    expect(n).toBe("WEBDESK_DEPLOY_ACME_SITE_STAGING_123");
    expect(siteDeploySecretName({ slug: "acme-site", environment: "staging", repositoryId: 123 })).toBe(n);
    expect(isValidSecretName(siteDeploySecretName({ slug: "a".repeat(100), environment: "development", repositoryId: 9007199254740991 }))).toBe(true);
    expect(siteDeploySecretName({ slug: "acme-site", environment: "production", repositoryId: 123 })).not.toBe(n);
  });

  it("CANNOT COLLIDE across two sites: slugs differing only by - vs _ map to one readable part, the repository id keeps them apart", () => {
    const dash = siteDeploySecretName({ slug: "a-b", environment: "staging", repositoryId: 11 });
    const under = siteDeploySecretName({ slug: "a_b", environment: "staging", repositoryId: 12 });
    expect(dash.replace(/_\d+$/, "")).toBe(under.replace(/_\d+$/, "")); // the readable part DOES collide
    expect(dash).not.toBe(under);
    // the same slug in two companies (ux_wps_slug is per tenant; org secret names are org-wide): two repos, two ids
    expect(siteDeploySecretName({ slug: "acme", environment: "staging", repositoryId: 21 })).not.toBe(siteDeploySecretName({ slug: "acme", environment: "staging", repositoryId: 22 }));
    // a slug that ends like an environment
    expect(siteDeploySecretName({ slug: "foo-staging", environment: "production", repositoryId: 31 }))
      .not.toBe(siteDeploySecretName({ slug: "foo", environment: "staging-production", repositoryId: 32 }));
  });

  it("is derived from the RESOLVED repo (its name and id), because that is all the site's own workflow can see", async () => {
    // the provisioned row's slug differs from the repo's name: the workflow sees github.event.repository.name
    const h = harness({ row: { slug: "provisioned-slug" } });
    const r = await grantDeploySecrets(h.deps, operator);
    expect(r.siteSecretName).toBe(`WEBDESK_DEPLOY_ACME_SITE_STAGING_${REPO_ID}`);
    expect(r.siteSecretName).toBe(SITE_SECRET);
    expect(r.siteSecretNote).toBeNull();
  });

  it("before a grant has read the repo there is NO name: the answer says why instead of inventing one", async () => {
    const h = harness({ row: { grantState: "revoked", grantSiteSecretName: null, grantRepositoryId: null, grantSecretNames: [] } });
    const r = await grantDeploySecrets(h.deps, scaffold);
    expect(r).toMatchObject({ outcome: "skipped_revoked", siteSecretName: null, siteSecretNote: SITE_SECRET_NOT_DERIVABLE });
    expect(SITE_SECRET_NOT_DERIVABLE).toMatch(/not derivable yet/);
  });

  it("a repo recreated under a new id gets a NEW name at the next grant; the old name stays in the recorded list so a revoke sweeps it", async () => {
    const h = harness();
    await grantDeploySecrets(h.deps, operator);
    h.gh.repoId = 777;
    const next = siteDeploySecretName({ slug: "acme-site", environment: "staging", repositoryId: 777 });
    const r = await grantDeploySecrets(h.deps, operator);
    expect(r).toMatchObject({ outcome: "pending", siteSecretName: next, pending: [next], repositoryId: 777 });
    expect(h.site.row!.grantSecretNames).toContain(SITE_SECRET);
  });

  it("is only ever granted to its OWN site's repo: another site's per-site name is never touched", async () => {
    const other = siteDeploySecretName({ slug: "acme-site", environment: "staging", repositoryId: REPO_ID + 1 });
    const h = harness();
    h.gh.addOrgSecret(other);
    await grantDeploySecrets(h.deps, operator);
    expect(h.gh.calls.some((c) => c.path.includes(other))).toBe(false);
    expect(h.gh.orgSecrets.get(other)!.repos.size).toBe(0);
    expect([...h.gh.orgSecrets.get(SITE_SECRET)!.repos]).toEqual([h.gh.repoId]);
  });

  it("the derived name is recorded at claim and must still match under the lock (a renamed environment refuses)", async () => {
    const h = harness();
    h.site.onCommit = (n, site) => {
      if (n === 1 && site.registry) site.registry = { ...site.registry, environment: "production" };
    };
    expect((await refusal(grantDeploySecrets(h.deps, operator))).code).toBe("deploy_grant_superseded");
    expect(writes(h.gh)).toBe(0);
  });
});
