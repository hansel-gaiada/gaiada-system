// M6-P4b1 - the dry-run proof, per kind, through the REAL runner path: POST /goals with agent "code-scaffold-v2",
// the runner's dispatch (runner/service.ts), runScaffoldJob, runCodeScaffold with the real
// HubContractSnapshotProvider and HubArtifactFetcher over a fake hub `callTool`, and the dry-run writer (a real
// local `git init`/`commit` in a temp dir). Only the hub and the goal store are faked.
//
// The snapshot fixture is the WSK-18 P3 gate's `acme` tenant (`qa-p3-acme`): `openapi.v1.json`, `sdk.d.ts`,
// `CONTENT-CONTRACT.md` and `sdk.php` in __fixtures__/qa-p3-acme/ are the REAL output of
// webdesk/qa/p3-gate/generate-fixture-artifacts.mts and webdesk/wordpress/sdk-gate/generate-fixture-php.mts
// (the .txt suffix keeps the static no-execute scan and tsc off them). The block-library tarball is a few fake
// bytes: nothing in this process opens it.
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildRunnerApp } from "../runner/service";
import type {
  GoalStore, GoalInput, GoalRunContext, FinishGoalPatch, GoalListItem, GoalDetail, RunInput, RunRow, CancelResult,
  RunEventInput, RunEventRow,
} from "../runner/store";
import type { AgentDeps, Envelope } from "../agent";
import { CODE_SCAFFOLD_AGENT, type ScaffoldJobResult } from "./runner-job";
import { isNodeAllowedPath } from "./templates/node-site";
import { resetExecLog, getExecLog } from "./no-execute-guard";
import type { ScaffoldFileEntry } from "./envelope";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "__fixtures__", "qa-p3-acme");
const fx = (name: string): string => readFileSync(join(FIX, name), "utf8");
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const SNAPSHOT = "bbbbbbbb-0000-4000-8000-000000000002";
const TOKEN = "runner-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const OBO: Envelope = { provider: "n8n", externalId: "wf:delivery" };
const PRD_REF = "11111111-1111-4111-8111-111111111111";
const PROTO_REF = "22222222-2222-4222-8222-222222222222";

const PRD = "# Signed PRD\nA marketing site for Acme with case studies and articles.\n";
const PROTOTYPE = JSON.stringify({
  pages: [
    { slug: "", title: "Home" },
    { slug: "about", title: "About us" },
    { slug: "case-studies", title: "Case Studies", collection: "caseStudy", isListing: true },
    { slug: "case-studies", title: "Case Study", collection: "caseStudy" },
    { slug: "articles", title: "Articles", collection: "article", isListing: true },
    { slug: "team", title: "Team", collection: "team-member" }, // not in the contract: a vocabulary gap
  ],
});

const TARBALL = Buffer.from("fake-blocks-tarball-never-opened");

interface FixtureOpts { withBlockLibrary?: boolean; withSdkPhp?: boolean }

/** A fake hub: `webdev.contracts.get`, `webdev.contracts.artifact` and `pipeline.artifacts.get`, recording every call. */
function fakeHub(opts: FixtureOpts = {}) {
  const { withBlockLibrary = true, withSdkPhp = true } = opts;
  const calls: { name: string; args: Record<string, unknown>; envelope: Envelope }[] = [];
  const meta = {
    id: SNAPSHOT,
    tenantId: TENANT,
    webdeskTenantSlug: "qa-p3-acme",
    contractVersion: "1.0.0",
    vocabularyVersion: "1.1.0",
    contentHash: "sha256:" + sha(fx("hash-manifest.json")),
    artifacts: {
      sdkTs: "file-sdk-ts",
      sdkPhp: withSdkPhp ? "file-sdk-php" : null,
      openapi: "file-openapi",
      contractMd: "file-md",
      blockLibrary: { package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" },
      blockLibraryFile: withBlockLibrary ? "file-blocks" : null,
    },
  };
  const artifactBytes: Record<string, Buffer> = {
    openapi: Buffer.from(fx("openapi.v1.json")),
    sdkTs: Buffer.from(fx("sdk.d.ts.txt")),
    contractMd: Buffer.from(fx("CONTENT-CONTRACT.md")),
    sdkPhp: Buffer.from(fx("sdk.php.txt")),
    blockLibrary: TARBALL,
  };
  const callTool: AgentDeps["callTool"] = async (name, args, envelope) => {
    calls.push({ name, args, envelope });
    if (name === "webdev.contracts.get") {
      if (args.snapshotId !== SNAPSHOT) throw new Error("hub 404: contract snapshot not found");
      return JSON.stringify(meta);
    }
    if (name === "webdev.contracts.artifact") {
      return JSON.stringify({ base64: artifactBytes[String(args.artifact)].toString("base64") });
    }
    if (name === "pipeline.artifacts.get") {
      if (args.artifactRef === PRD_REF) return JSON.stringify({ resolvable: true, content: PRD });
      if (args.artifactRef === PROTO_REF) return JSON.stringify({ resolvable: true, content: PROTOTYPE });
      return JSON.stringify({ resolvable: false, reason: "artifact_ref is not a stored file id", content: null });
    }
    throw new Error(`unexpected hub tool ${name}`);
  };
  return { callTool, calls };
}

// ---- a minimal in-memory GoalStore (the Pg one needs a database) ----
class MemGoalStore implements GoalStore {
  goals = new Map<string, GoalInput & { id: string; status: GoalListItem["status"]; outcome: string | null; errorKind: string | null; blackboard: GoalDetail["blackboard"] }>();
  runs: RunInput[] = [];
  events: RunEventRow[] = [];
  async init(): Promise<void> {}
  async insertGoal(input: GoalInput): Promise<string> {
    const id = randomUUID();
    this.goals.set(id, { ...input, id, status: "queued", outcome: null, errorKind: null, blackboard: null });
    return id;
  }
  async claimForRun(id: string): Promise<GoalRunContext | null> {
    const g = this.goals.get(id);
    if (!g || g.status !== "queued") return null;
    g.status = "running";
    return { id, tenantId: g.tenantId, goal: g.goal, agent: g.agent, envelopeProvider: g.envelopeProvider, envelopeExternalId: g.envelopeExternalId, budget: g.budget };
  }
  async finishGoal(id: string, patch: FinishGoalPatch): Promise<void> {
    const g = this.goals.get(id);
    if (!g) return;
    g.status = patch.status;
    g.outcome = patch.outcome ?? null;
    g.errorKind = patch.errorKind ?? null;
    g.blackboard = patch.blackboard ?? null;
  }
  async insertRun(run: RunInput): Promise<void> {
    this.runs.push(run);
  }
  private item(g: { id: string; tenantId: string; goal: string; agent: string; status: GoalListItem["status"]; outcome: string | null; errorKind: string | null; budget: GoalInput["budget"] }): GoalListItem {
    return {
      id: g.id, tenantId: g.tenantId, goal: g.goal, agent: g.agent, status: g.status, outcome: g.outcome, errorKind: g.errorKind,
      approvalId: null, modelCalls: 0, toolCalls: 0, fanOut: 0, budget: g.budget, createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
    };
  }
  async listGoals(tenantId: string): Promise<GoalListItem[]> {
    return [...this.goals.values()].filter((g) => g.tenantId === tenantId).map((g) => this.item(g));
  }
  async getGoal(id: string, tenantId: string): Promise<GoalDetail | null> {
    const g = this.goals.get(id);
    if (!g || g.tenantId !== tenantId) return null;
    return { ...this.item(g), blackboard: g.blackboard, runs: [] };
  }
  async getRun(): Promise<RunRow | null> {
    return null;
  }
  async cancel(): Promise<CancelResult> {
    return "not_found";
  }
  async sweepInterrupted(): Promise<number> {
    return 0;
  }
  async insertEvent(e: RunEventInput): Promise<RunEventRow> {
    const row: RunEventRow = { eventId: randomUUID(), ts: new Date().toISOString(), runId: e.runId, goalId: e.goalId, tenantId: e.tenantId, seq: e.seq, kind: e.kind, detail: e.detail, durationMs: e.durationMs ?? null, parentRunId: e.parentRunId ?? null };
    this.events.push(row);
    return row;
  }
  async listEvents(): Promise<RunEventRow[]> {
    return [];
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

function scaffoldGoal(siteKind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: "run-1",
    repoUrl: "https://github.com/gaiada/acme-site",
    siteKind,
    prdArtifact: PRD_REF,
    prototypeArtifact: PROTO_REF,
    contractSnapshotId: SNAPSHOT,
    constraints: { blockLibraryVersion: "", maxRevise: 3 },
    ...extra,
  });
}

/** Posts the goal to the real runner app, waits for it to finish, returns the goal detail and the parsed result. */
async function runGoal(goal: string, fixtureOpts: FixtureOpts = {}) {
  const hub = fakeHub(fixtureOpts);
  const store = new MemGoalStore();
  const app = buildRunnerApp({
    store,
    agentDeps: { complete: async () => { throw new Error("the scaffold job must not call a model"); }, callTool: hub.callTool, lastProvider: () => undefined },
    config: { token: TOKEN, maxConcurrent: 1, maxQueue: 5 },
  });
  apps.push(app);
  const post = await app.inject({
    method: "POST",
    url: "/goals",
    headers: AUTH,
    payload: { tenantId: TENANT, goal, agent: CODE_SCAFFOLD_AGENT, envelope: OBO },
  });
  expect(post.statusCode).toBe(202);
  const id = post.json().id as string;
  let detail: GoalDetail | undefined;
  for (let i = 0; i < 400; i++) {
    const res = await app.inject({ method: "GET", url: `/goals/${id}?tenant=${TENANT}`, headers: AUTH });
    detail = res.json() as GoalDetail;
    if (detail.status !== "queued" && detail.status !== "running") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const entry = detail!.blackboard?.[0];
  const result = entry ? (JSON.parse(entry.summary) as ScaffoldJobResult) : undefined;
  return { detail: detail!, result, hub, store };
}

function paths(files: ScaffoldFileEntry[] | undefined): string[] {
  return (files ?? []).map((f) => f.path);
}

function scaffoldTmpDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("wsk20-scaffold-"));
}

let leftoverBefore: string[] = [];
beforeAll(() => {
  leftoverBefore = scaffoldTmpDirs();
});

function expectCommonDryRunInvariants(detail: GoalDetail, result: ScaffoldJobResult | undefined) {
  expect(detail.status).toBe("ok");
  expect(result).toBeDefined();
  expect(result!.outcome).toBe("dry_run");
  expect(result!.mode).toBe("dry_run");
  const files = result!.files!;
  // CONTRACT.lock at the repo root, pinned to the snapshot id, and its exact text is in the result with a matching hash.
  expect(paths(files)).toContain("CONTRACT.lock");
  const lock = JSON.parse(result!.contractLockContent!) as Record<string, string>;
  expect(lock.snapshotId).toBe(SNAPSHOT);
  expect(lock.contractVersion).toBe("1.0.0");
  expect(lock.blockLibraryVersion).toBe("0.1.0"); // empty in the goal: taken from the snapshot
  expect(result!.contractLock!.snapshotId).toBe(SNAPSHOT);
  expect(files.find((f) => f.path === "CONTRACT.lock")!.sha256).toBe(sha(result!.contractLockContent!));
  // every entry is complete and the paths are unique and sorted
  for (const f of files) {
    expect(f.bytes).toBeGreaterThan(0);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(new Set(paths(files)).size).toBe(files.length);
  expect(paths(files)).toEqual([...paths(files)].sort());
  // no path escapes the repo
  for (const p of paths(files)) expect(p.startsWith("/") || p.split("/").includes("..")).toBe(false);
}

describe("code.scaffold v2 dry run through the real runner path", () => {
  it("astro: a static Astro repo at the root, with the vendored SDK and block library", async () => {
    resetExecLog();
    const { detail, result } = await runGoal(scaffoldGoal("astro"));
    expectCommonDryRunInvariants(detail, result);
    const p = paths(result!.files);
    expect(p).toEqual(
      expect.arrayContaining([
        ".github/workflows/qa-harness.yml",
        "astro.config.mjs",
        "package.json",
        "src/lib/webdesk-sdk.ts",
        "src/pages/index.astro",
        "src/pages/about.astro",
        "src/pages/case-studies.astro",
        "src/pages/case-studies/[slug].astro",
        "src/pages/articles.astro",
        "vendor/webdesk-blocks.tgz",
        "vendor/webdesk-sdk/index.d.ts",
        "vendor/webdesk-sdk/package.json",
      ]),
    );
    expect(p.some((x) => x.startsWith("apps/"))).toBe(false);
    // the vendored SDK is the tenant's real generated one, byte for byte
    const sdk = result!.files!.find((f) => f.path === "vendor/webdesk-sdk/index.d.ts")!;
    expect(sdk.sha256).toBe(sha(fx("sdk.d.ts.txt")));
    expect(result!.files!.find((f) => f.path === "vendor/webdesk-blocks.tgz")!.sha256).toBe(sha(TARBALL));
    // the vocabulary gap is reported, with its proposal draft
    expect(result!.gaps!.map((g) => g.reference)).toEqual(["team-member"]);
    expect(p).toContain("webdesk-schema-proposals/unknown-collection-team-member.json");
  });

  it("node (fullstack): fills apps/web only; the workspace root and apps/api are untouched", async () => {
    resetExecLog();
    const { detail, result } = await runGoal(scaffoldGoal("node"));
    expectCommonDryRunInvariants(detail, result);
    const p = paths(result!.files);

    // nothing outside the template's allowed areas
    expect(p.filter((x) => !isNodeAllowedPath(x))).toEqual([]);
    // the template-owned files are never written
    for (const owned of ["package.json", "README.md", ".gitignore", ".env.example", "docker-compose.yml", "tsconfig.json", "astro.config.mjs", ".github/workflows/site.yml"]) {
      expect(p).not.toContain(owned);
    }
    expect(p.some((x) => x.startsWith("apps/api/"))).toBe(false);
    expect(p.some((x) => x.endsWith(".astro"))).toBe(false);
    // the Astro block library is not vendored: a Next app cannot render it
    expect(p).not.toContain("vendor/webdesk-blocks.tgz");
    expect(p.some((x) => x.includes("webdesk-blocks"))).toBe(false);

    expect(p).toEqual(
      expect.arrayContaining([
        "CONTRACT.lock",
        "docs/PRD.md",
        "docs/PROTOTYPE.md",
        "apps/web/package.json",
        "apps/web/.env.example",
        "apps/web/src/app/page.tsx", // replaces the template's placeholder home page
        "apps/web/src/app/about/page.tsx",
        "apps/web/src/app/case-studies/page.tsx",
        "apps/web/src/app/case-studies/[slug]/page.tsx",
        "apps/web/src/app/articles/page.tsx",
        "apps/web/src/lib/webdesk-sdk.ts",
        "apps/web/src/lib/blocks.tsx",
        "apps/web/src/lib/block-types.ts",
        "apps/web/src/__generated__/contract-conformance.test.ts",
        "apps/web/vendor/webdesk-sdk/index.d.ts",
        "apps/web/vendor/webdesk-sdk/package.json",
        "apps/web/webdesk-schema-proposals/unknown-collection-team-member.json",
        "apps/web/src/app/team/page.tsx",
      ]),
    );
    const sdk = result!.files!.find((f) => f.path === "apps/web/vendor/webdesk-sdk/index.d.ts")!;
    expect(sdk.sha256).toBe(sha(fx("sdk.d.ts.txt")));
    expect(result!.gaps!.map((g) => g.todoFilePath)).toEqual(["apps/web/src/app/team/page.tsx"]);
  });

  it("node needs no block library: a snapshot without one still scaffolds (astro refuses it)", async () => {
    const node = await runGoal(scaffoldGoal("node"), { withBlockLibrary: false });
    expect(node.detail.status).toBe("ok");
    expect(node.result!.outcome).toBe("dry_run");
    const astro = await runGoal(scaffoldGoal("astro"), { withBlockLibrary: false });
    expect(astro.detail.status).toBe("failed");
    expect(astro.detail.errorKind).toBe("rejected_site_kind");
    expect(astro.result!.files).toBeUndefined();
  });

  it("wp: the headless theme, with the tenant's own sdk.php in place of the fixture one", async () => {
    resetExecLog();
    const { detail, result } = await runGoal(scaffoldGoal("wp"));
    expectCommonDryRunInvariants(detail, result);
    const p = paths(result!.files);
    expect(p).toEqual(
      expect.arrayContaining(["style.css", "index.php", "functions.php", "inc/block-renderer.php", "inc/router.php", "vendor/gaiada-sdk/sdk.php", "CONTRACT.lock"]),
    );
    expect(p.filter((x) => x.endsWith("sdk.php"))).toEqual(["vendor/gaiada-sdk/sdk.php"]);
    expect(result!.files!.find((f) => f.path === "vendor/gaiada-sdk/sdk.php")!.sha256).toBe(sha(fx("sdk.php.txt")));
    expect(p.some((x) => x.startsWith("apps/") || x === "package.json" || x.startsWith("vendor/webdesk"))).toBe(false);
  });

  it("wp without a pinned PHP SDK is refused, not composed around", async () => {
    const { detail, result } = await runGoal(scaffoldGoal("wp"), { withSdkPhp: false });
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("rejected_site_kind");
    expect(result!.content).toMatch(/PHP SDK/);
  });
});

describe("the job never pushes and never leaks authority", () => {
  it("runs git locally and nothing else: no push, no remote, even when the goal asks for one", async () => {
    resetExecLog();
    const { detail, result } = await runGoal(scaffoldGoal("node", { mode: "push", pushTarget: { mode: "push", remoteUrl: "https://github.com/gaiada/acme-site.git" }, remoteUrl: "https://github.com/gaiada/acme-site.git" }));
    expect(detail.status).toBe("ok");
    expect(result!.mode).toBe("dry_run");
    expect(result!.outcome).toBe("dry_run");
    const log = getExecLog();
    expect(log.length).toBeGreaterThan(0);
    for (const cmd of log) expect(cmd.startsWith("git ")).toBe(true);
    expect(log.some((c) => /\bpush\b|\bremote\b/.test(c))).toBe(false);
  });

  it("returns data, not a path: no work dir is reported and none is left behind", async () => {
    const { result } = await runGoal(scaffoldGoal("astro"));
    expect(JSON.stringify(result)).not.toContain("wsk20-scaffold-");
    expect(scaffoldTmpDirs().filter((n) => !leftoverBefore.includes(n))).toEqual([]);
  });

  it("every hub read is scoped to the goal's tenant and carries the goal's OBO identity", async () => {
    const { hub } = await runGoal(scaffoldGoal("astro"));
    expect(hub.calls.length).toBeGreaterThan(5);
    for (const c of hub.calls) {
      expect(c.args.tenantId).toBe(TENANT);
      expect(c.envelope).toEqual(OBO);
    }
    const names = new Set(hub.calls.map((c) => c.name));
    expect([...names].sort()).toEqual(["pipeline.artifacts.get", "webdev.contracts.artifact", "webdev.contracts.get"]);
    expect(hub.calls.filter((c) => c.name === "webdev.contracts.artifact").every((c) => c.args.snapshotId === SNAPSHOT)).toBe(true);
  });

  it("makes no model call (the fake model throws if asked)", async () => {
    const { detail } = await runGoal(scaffoldGoal("node"));
    expect(detail.status).toBe("ok");
  });
});

describe("failures are honest results, never a green empty repo", () => {
  it("a goal that is not the envelope fails as invalid_job", async () => {
    const { detail, result } = await runGoal("scaffold my site please");
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("invalid_job");
    expect(result!.outcome).toBe("invalid_job");
  });

  it("an unknown siteKind fails as invalid_job", async () => {
    const { detail } = await runGoal(scaffoldGoal("php-legacy"));
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("invalid_job");
  });

  it("an unknown snapshot id fails as snapshot_fetch_failed", async () => {
    const { detail } = await runGoal(scaffoldGoal("astro", { contractSnapshotId: "cccccccc-0000-4000-8000-000000000003" }));
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("snapshot_fetch_failed");
  });

  it("a PRD ref that is not stored text fails as artifact_fetch_failed (it must not scaffold from an empty PRD)", async () => {
    const { detail, result } = await runGoal(scaffoldGoal("astro", { prdArtifact: "# an inline PRD, not a file id" }));
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("artifact_fetch_failed");
    expect(result!.content).toMatch(/not stored text/);
  });

  it("a prototype page whose slug would escape the app directory is refused (node)", async () => {
    const hub = fakeHub();
    const evil = JSON.stringify({ pages: [{ slug: "../../etc", title: "x" }] });
    const wrapped: AgentDeps["callTool"] = async (name, args, e) =>
      name === "pipeline.artifacts.get" && args.artifactRef === PROTO_REF ? JSON.stringify({ resolvable: true, content: evil }) : hub.callTool(name, args, e);
    const store = new MemGoalStore();
    const app = buildRunnerApp({ store, agentDeps: { complete: async () => "", callTool: wrapped, lastProvider: () => undefined }, config: { token: TOKEN, maxConcurrent: 1, maxQueue: 5 } });
    apps.push(app);
    const post = await app.inject({ method: "POST", url: "/goals", headers: AUTH, payload: { tenantId: TENANT, goal: scaffoldGoal("node"), agent: CODE_SCAFFOLD_AGENT, envelope: OBO } });
    const id = post.json().id as string;
    for (let i = 0; i < 400 && ["queued", "running"].includes(store.goals.get(id)!.status); i++) await new Promise((r) => setTimeout(r, 25));
    expect(store.goals.get(id)!.status).toBe("failed");
    expect(store.goals.get(id)!.errorKind).toBe("prototype_invalid");
  });
});

describe("the runner accepts the agent and caps its goal text", () => {
  it("POST /goals takes a scaffold goal far larger than 4000 chars, and still caps other agents at 4000", async () => {
    const store = new MemGoalStore();
    const app = buildRunnerApp({ store, agentDeps: { complete: async () => "", callTool: async () => { throw new Error("hub down"); }, lastProvider: () => undefined }, config: { token: TOKEN, maxConcurrent: 1, maxQueue: 5 } });
    apps.push(app);
    const big = scaffoldGoal("astro", { prdArtifact: "x".repeat(20_000) });
    const ok = await app.inject({ method: "POST", url: "/goals", headers: AUTH, payload: { tenantId: TENANT, goal: big, agent: CODE_SCAFFOLD_AGENT, envelope: OBO } });
    expect(ok.statusCode).toBe(202);
    const other = await app.inject({ method: "POST", url: "/goals", headers: AUTH, payload: { tenantId: TENANT, goal: "x".repeat(5000), agent: "supervisor", envelope: OBO } });
    expect(other.statusCode).toBe(400);
  });

  it("GET /health lists the job agent", async () => {
    const app = buildRunnerApp({ store: new MemGoalStore(), agentDeps: { complete: async () => "", callTool: async () => { throw new Error("hub down"); }, lastProvider: () => undefined }, config: { token: TOKEN } });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json().jobAgents).toEqual([CODE_SCAFFOLD_AGENT]);
  });
});
