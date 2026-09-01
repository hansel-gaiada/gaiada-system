// GH-12 — repo-creation.ts unit tests, with `authorize()`, `githubRequest()` and `withGithubLedger()`
// MOCKED (same discipline as repo-sync.service.test.ts: never call the live GitHub API from a test,
// and never touch the ledger's real DB write from a pure unit test — see
// `automation-approvals-github-decide.db.test.ts` for the real-Postgres+real-Cerbos integration
// coverage of the whole decide() path).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import * as http from "../http";
import * as githubAppService from "./github-app.service";
import * as ledger from "./ledger";
import { config } from "../../config";
import {
  GITHUB_CREATE_REPO_WORKFLOW,
  isGithubRepoCreationRequest,
  parseCreateRepoArgs,
  executeApprovedGithubRepoCreation,
} from "./repo-creation";
import type { Principal } from "../../rbac/principal";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return { ...actual, authorize: vi.fn() };
});
vi.mock("./github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});
vi.mock("./ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ledger")>();
  return {
    ...actual,
    withGithubLedger: vi.fn(async (_req: unknown, perform: (ctx: { correlationId: string }) => Promise<{ data: unknown }>) => {
      const result = await perform({ correlationId: "corr-1" });
      return { data: result.data, correlationId: "corr-1" };
    }),
  };
});

const TENANT = "tenant-1";
const decider = { userId: "u-decider", assurance: "high" } as unknown as Principal;

beforeEach(() => {
  vi.mocked(http.authorize).mockReset().mockResolvedValue(undefined);
  vi.mocked(githubAppService.githubRequest).mockReset();
  vi.mocked(ledger.withGithubLedger).mockClear();
  config.githubOrg = "gaiadabali";
});

describe("isGithubRepoCreationRequest", () => {
  it("matches only origin='github' AND the exact workflow id", () => {
    expect(isGithubRepoCreationRequest("github", GITHUB_CREATE_REPO_WORKFLOW)).toBe(true);
    expect(isGithubRepoCreationRequest("github", "something-else")).toBe(false);
    expect(isGithubRepoCreationRequest("iam", GITHUB_CREATE_REPO_WORKFLOW)).toBe(false);
    expect(isGithubRepoCreationRequest("automation", GITHUB_CREATE_REPO_WORKFLOW)).toBe(false);
  });
});

describe("parseCreateRepoArgs", () => {
  it("requires a name matching GitHub's charset", () => {
    expect(parseCreateRepoArgs({})).toMatchObject({ ok: false });
    expect(parseCreateRepoArgs({ name: "bad name!" })).toMatchObject({ ok: false });
    expect(parseCreateRepoArgs({ name: "" })).toMatchObject({ ok: false });
  });

  it("accepts a valid bare-repo request, defaulting to private", () => {
    const r = parseCreateRepoArgs({ name: "my-repo_1.0" });
    expect(r).toEqual({ ok: true, args: { name: "my-repo_1.0", private: true } });
  });

  it("private:false is honoured explicitly", () => {
    const r = parseCreateRepoArgs({ name: "my-repo", private: false });
    expect(r.ok && r.args.private).toBe(false);
  });

  it("templateOwner and templateRepo must both be set or both omitted", () => {
    expect(parseCreateRepoArgs({ name: "x", templateOwner: "gaiadabali" })).toMatchObject({ ok: false });
    expect(parseCreateRepoArgs({ name: "x", templateRepo: "provision-fullstack-cms" })).toMatchObject({ ok: false });
    const ok = parseCreateRepoArgs({ name: "x", templateOwner: "gaiadabali", templateRepo: "provision-fullstack-cms" });
    expect(ok).toEqual({
      ok: true,
      args: { name: "x", private: true, templateOwner: "gaiadabali", templateRepo: "provision-fullstack-cms" },
    });
  });

  it("description is trimmed to 350 chars", () => {
    const long = "x".repeat(500);
    const r = parseCreateRepoArgs({ name: "x", description: long });
    expect(r.ok && r.args.description?.length).toBe(350);
  });
});

describe("executeApprovedGithubRepoCreation", () => {
  it("🔴 a malformed payload throws WITHOUT ever calling authorize() or githubRequest()", async () => {
    await expect(executeApprovedGithubRepoCreation(TENANT, "appr-1", { name: "bad name!" }, decider)).rejects.toThrow(
      /malformed/,
    );
    expect(http.authorize).not.toHaveBeenCalled();
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("🔴 an unconfigured GITHUB_ORG refuses with 503, before authorize() or any egress", async () => {
    config.githubOrg = "";
    await expect(
      executeApprovedGithubRepoCreation(TENANT, "appr-1", { name: "site" }, decider),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(http.authorize).not.toHaveBeenCalled();
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("🔴 THE REAL GATE — authorize() denying create_repo means githubRequest is NEVER called", async () => {
    vi.mocked(http.authorize).mockRejectedValueOnce(new ForbiddenException("not authorized: denied"));
    await expect(
      executeApprovedGithubRepoCreation(TENANT, "appr-1", { name: "site" }, decider),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(githubAppService.githubRequest).not.toHaveBeenCalled();
  });

  it("calls authorize() against create_repo on github_repo WITH this approval's own id as approvalId", async () => {
    vi.mocked(githubAppService.githubRequest).mockResolvedValue({
      data: { full_name: "gaiadabali/site", html_url: "https://github.com/gaiadabali/site", default_branch: "main" },
      status: 201,
      rateLimit: { limit: 12500, remaining: 12499, resetAtMs: null },
    });
    await executeApprovedGithubRepoCreation(TENANT, "appr-42", { name: "site" }, decider);
    expect(http.authorize).toHaveBeenCalledWith(
      decider,
      { kind: "github_repo", tenantId: TENANT, approvalId: "appr-42" },
      "create_repo",
    );
  });

  it("bare repo (no template) calls POST /orgs/{org}/repos with auto_init:true", async () => {
    vi.mocked(githubAppService.githubRequest).mockResolvedValue({
      data: { full_name: "gaiadabali/site", html_url: "https://github.com/gaiadabali/site", default_branch: "main" },
      status: 201,
      rateLimit: { limit: 12500, remaining: 12499, resetAtMs: null },
    });
    const result = await executeApprovedGithubRepoCreation(TENANT, "appr-1", { name: "site", private: true }, decider);
    expect(githubAppService.githubRequest).toHaveBeenCalledWith(TENANT, "erp", decider.userId, {
      method: "POST",
      path: "/orgs/gaiadabali/repos",
      body: { name: "site", private: true, description: undefined, auto_init: true },
    });
    expect(result).toEqual({
      fullName: "gaiadabali/site",
      htmlUrl: "https://github.com/gaiadabali/site",
      defaultBranch: "main",
      correlationId: "corr-1",
    });
  });

  it("🔴 template supplied ⇒ POST /repos/{owner}/{repo}/generate, owner=org in the body, NOT /orgs/.../repos", async () => {
    vi.mocked(githubAppService.githubRequest).mockResolvedValue({
      data: { full_name: "gaiadabali/site", html_url: "https://github.com/gaiadabali/site", default_branch: "main" },
      status: 201,
      rateLimit: { limit: 12500, remaining: 12499, resetAtMs: null },
    });
    await executeApprovedGithubRepoCreation(
      TENANT,
      "appr-1",
      { name: "site", templateOwner: "gaiadabali", templateRepo: "provision-fullstack-cms" },
      decider,
    );
    expect(githubAppService.githubRequest).toHaveBeenCalledWith(TENANT, "erp", decider.userId, {
      method: "POST",
      path: "/repos/gaiadabali/provision-fullstack-cms/generate",
      body: { owner: "gaiadabali", name: "site", private: true, description: undefined, include_all_branches: false },
    });
  });

  it("a failed GitHub call still resolves the ledger wrapper (which is what records the attempt) and re-throws", async () => {
    vi.mocked(githubAppService.githubRequest).mockRejectedValue(new Error("github 422"));
    await expect(executeApprovedGithubRepoCreation(TENANT, "appr-1", { name: "site" }, decider)).rejects.toThrow(
      /github 422/,
    );
    expect(ledger.withGithubLedger).toHaveBeenCalledTimes(1);
  });
});
