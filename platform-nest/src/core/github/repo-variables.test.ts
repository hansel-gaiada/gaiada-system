// M5-P4 (WSK-D92) — the repository-variable calls against the in-memory GitHub (git-data.testkit.ts). No network.
import { describe, it, expect, beforeEach } from "vitest";
import {
  ALLOWED_REPO_VARIABLES, LINKEDIN_PARTNER_ID_VARIABLE, REPO_VARIABLES_PERMISSION, RepoVariableError,
  createRepoVariable, deleteRepoVariable, getRepoVariable, setRepoVariable, updateRepoVariable,
} from "./repo-variables";
import { FakeGithub } from "./git-data.testkit";

const NAME = LINKEDIN_PARTNER_ID_VARIABLE;

describe("repo variables (fake GitHub)", () => {
  let gh: FakeGithub;
  let call: ReturnType<FakeGithub["caller"]>;
  const repo = { owner: "acme-org", name: "acme-site" };
  beforeEach(() => {
    gh = new FakeGithub(repo.owner, repo.name);
    call = gh.caller();
  });

  it("the allow-list is exactly the one variable the feature exists for", () => {
    expect(ALLOWED_REPO_VARIABLES).toEqual(["PUBLIC_LINKEDIN_PARTNER_ID"]);
  });

  it("an unset variable is null (404 is an answer), a set one comes back with its value", async () => {
    expect(await getRepoVariable(call, repo, NAME)).toBeNull();
    gh.variables.set(NAME, { value: "123456", updatedAt: "2026-10-30T00:00:00.000Z" });
    expect(await getRepoVariable(call, repo, NAME)).toEqual({ name: NAME, value: "123456", updatedAt: "2026-10-30T00:00:00.000Z" });
    expect(gh.calls.at(-1)).toMatchObject({ method: "GET", path: "/repos/acme-org/acme-site/actions/variables/PUBLIC_LINKEDIN_PARTNER_ID" });
  });

  it("create is POST {name, value} to the collection (201); the same name again is GitHub's 409, typed", async () => {
    await createRepoVariable(call, repo, NAME, "111");
    expect(gh.calls[0]).toMatchObject({ method: "POST", path: "/repos/acme-org/acme-site/actions/variables", body: { name: NAME, value: "111" } });
    expect(gh.variables.get(NAME)?.value).toBe("111");
    await expect(createRepoVariable(call, repo, NAME, "222")).rejects.toMatchObject({ reason: "github_request_failed" });
    expect(gh.variables.get(NAME)?.value).toBe("111");
  });

  it("update is PATCH (204) and says false when the variable does not exist", async () => {
    expect(await updateRepoVariable(call, repo, NAME, "1")).toBe(false);
    gh.variables.set(NAME, { value: "1", updatedAt: "x" });
    expect(await updateRepoVariable(call, repo, NAME, "2")).toBe(true);
    expect(gh.variables.get(NAME)?.value).toBe("2");
    expect(gh.calls.at(-1)).toMatchObject({ method: "PATCH", body: { name: NAME, value: "2" } });
  });

  it("delete is DELETE (204); one already gone is 'absent', an answer", async () => {
    gh.variables.set(NAME, { value: "1", updatedAt: "x" });
    expect(await deleteRepoVariable(call, repo, NAME)).toBe("deleted");
    expect(gh.variables.has(NAME)).toBe(false);
    expect(await deleteRepoVariable(call, repo, NAME)).toBe("absent");
  });

  it("setRepoVariable creates when absent and updates when present", async () => {
    expect(await setRepoVariable(call, repo, NAME, "1")).toBe("created");
    expect(await setRepoVariable(call, repo, NAME, "2")).toBe("updated");
    expect(gh.variables.get(NAME)?.value).toBe("2");
  });

  it("setRepoVariable recovers when its create loses a race (409), by updating once", async () => {
    gh.beforeRequest = (method, path) => {
      // The PATCH answered 404; before the POST lands, somebody else creates the variable.
      if (method === "POST" && !gh.variables.has(NAME)) gh.variables.set(NAME, { value: "other", updatedAt: "x" });
      void path;
    };
    expect(await setRepoVariable(call, repo, NAME, "mine")).toBe("updated");
    expect(gh.variables.get(NAME)?.value).toBe("mine");
  });

  it("a 403 on any call is github_permission_missing naming actions_variables", async () => {
    gh.variablesPermission = false;
    for (const run of [
      () => getRepoVariable(call, repo, NAME),
      () => createRepoVariable(call, repo, NAME, "1"),
      () => updateRepoVariable(call, repo, NAME, "1"),
      () => deleteRepoVariable(call, repo, NAME),
      () => setRepoVariable(call, repo, NAME, "1"),
    ]) {
      const err = await run().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RepoVariableError);
      expect(err).toMatchObject({ reason: "github_permission_missing", permission: REPO_VARIABLES_PERMISSION });
      expect((err as Error).message).toContain("actions_variables");
    }
  });

  it("a repository the App cannot see answers 404, which a read reports as unset (the caller confirms the repo separately)", async () => {
    const other = { owner: "someone-else", name: "unseen" };
    expect(await getRepoVariable(call, other, NAME)).toBeNull();
    expect(await deleteRepoVariable(call, other, NAME)).toBe("absent");
  });

  it("any other name is refused BEFORE a request is made, on every call", async () => {
    for (const bad of ["WEBDESK_DEPLOY_TOKEN", "public_linkedin_partner_id", "../x", ""]) {
      for (const run of [
        () => getRepoVariable(call, repo, bad),
        () => createRepoVariable(call, repo, bad, "1"),
        () => updateRepoVariable(call, repo, bad, "1"),
        () => deleteRepoVariable(call, repo, bad),
        () => setRepoVariable(call, repo, bad, "1"),
      ]) {
        await expect(run()).rejects.toMatchObject({ reason: "variable_not_allowed" });
      }
    }
    expect(gh.calls).toHaveLength(0);
  });
});
