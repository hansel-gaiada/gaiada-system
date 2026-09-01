import { describe, it, expect } from "vitest";
import { githubReposDemo as demo } from "./demoGithubRepos";

// Drives the demo dispatcher directly (same call shape demoFixtures.ts uses), same convention as
// demoWebdevProvisionedSites.test.ts. GH-10 added the link/unlink writes to a fixture that was
// previously read-only; this file's job is proving the write half actually mutates the
// `globalThis`-pinned store the read half serves from (the STORE_KEY comment's whole point —
// nothing here would catch a regression back to a per-module-graph copy).
function get(params: URLSearchParams = new URLSearchParams()) {
  return demo("GET", "/api/co-agency/github/repos", params);
}
function link(id: string, body: unknown) {
  return demo("POST", `/api/co-agency/github/repos/${id}/link`, new URLSearchParams(), JSON.stringify(body));
}
function unlink(id: string, body: unknown = {}) {
  return demo("POST", `/api/co-agency/github/repos/${id}/unlink`, new URLSearchParams(), JSON.stringify(body));
}

describe("ghr-17 — the seeded suggestion-path fixture", () => {
  it("is unlinked and named to fuzzy-match the one real demo webdev site slug", () => {
    const r = get(new URLSearchParams({ search: "northwind-site-redesign-kickoff-preview" }));
    expect(r?.status).toBe(200);
    const { repos } = r!.json as { repos: Array<{ id: string; webdevSiteId: string | null; projectId: string | null }> };
    const row = repos.find((x) => x.id === "ghr-17");
    expect(row).toBeTruthy();
    expect(row!.webdevSiteId).toBeNull();
    expect(row!.projectId).toBeNull();
  });
});

describe("POST .../link", () => {
  it("sets webdevSiteId and returns the updated link columns", () => {
    const r = link("ghr-17", { webdevSiteId: "wps-demo-1b" });
    expect(r?.status).toBe(200);
    expect(r!.json).toEqual({ id: "ghr-17", webdevSiteId: "wps-demo-1b", projectId: null });
  });

  it("sets projectId when linked to a project instead", () => {
    const r = link("ghr-05", { projectId: "proj-demo-99" });
    expect(r?.status).toBe(200);
    expect(r!.json).toEqual({ id: "ghr-05", webdevSiteId: null, projectId: "proj-demo-99" });
  });

  it("is a 400 when neither target is given — mirrors §25's 'at least one required'", () => {
    const r = link("ghr-06", {});
    expect(r?.status).toBe(400);
  });

  it("is a 404 for an id not on file", () => {
    const r = link("ghr-does-not-exist", { webdevSiteId: "wps-demo-1b" });
    expect(r?.status).toBe(404);
  });

  it("a subsequent GET reflects the link — the store is shared across calls, not per-call state", () => {
    link("ghr-07", { webdevSiteId: "wps-demo-1b" });
    const r = get(new URLSearchParams({ search: "internal-billing-scripts" }));
    const { repos } = r!.json as { repos: Array<{ id: string; webdevSiteId: string | null }> };
    expect(repos.find((x) => x.id === "ghr-07")?.webdevSiteId).toBe("wps-demo-1b");
  });
});

describe("POST .../unlink", () => {
  it("target:webdev_site clears only the site link, leaving a project link untouched", () => {
    link("ghr-10", { webdevSiteId: "wps-demo-1b" }); // ghr-10 already carries projectId proj-demo-5
    const r = unlink("ghr-10", { target: "webdev_site" });
    expect(r?.status).toBe(200);
    const body = r!.json as { webdevSiteId: string | null; projectId: string | null };
    expect(body.webdevSiteId).toBeNull();
    expect(body.projectId).toBe("proj-demo-5");
  });

  it("default target ('both') clears whichever link(s) are set", () => {
    link("ghr-12", { webdevSiteId: "wps-demo-1b" });
    const r = unlink("ghr-12");
    expect(r?.status).toBe(200);
    expect(r!.json).toEqual({ id: "ghr-12", webdevSiteId: null, projectId: null });
  });

  it("is a 404 for an id not on file", () => {
    expect(unlink("ghr-does-not-exist")?.status).toBe(404);
  });
});

describe("routes this fixture does not own", () => {
  it("returns null for a GET on an unrelated path, letting the dispatcher fall through", () => {
    expect(demo("GET", "/api/co-agency/modules/webdev/provisioned-sites", new URLSearchParams())).toBeNull();
  });
});
