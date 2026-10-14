import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// DW-6c2: the wiring. The pilot (`prefs.shell === "workspaces"`) shows the menu with the right workspace's tools and
// context; the classic shell shows nothing and reads nothing. A repository registry that cannot be read falls back to
// home links, never to "no repository".

vi.mock("@/lib/prefs", () => ({ getPrefs: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-1", companies: [{ id: "co-1", vertical: "agency" }], roles: [] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/entities", () => ({ getProject: vi.fn() }));
vi.mock("@/lib/departments", () => ({ listDepartmentBriefs: vi.fn() }));
vi.mock("@/lib/workspaces-data", () => ({ myWorkspaces: vi.fn() }));
vi.mock("@/lib/githubRepos-data", () => ({ listGithubRepos: vi.fn() }));
vi.mock("@/lib/searchMarketing", () => ({ listProperties: vi.fn() }));

import { getPrefs } from "@/lib/prefs";
import { getProject } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { myWorkspaces } from "@/lib/workspaces-data";
import { listGithubRepos } from "@/lib/githubRepos-data";
import { listProperties } from "@/lib/searchMarketing";
import { workspaceFor } from "@/lib/workspaces";
import { OpenInSlot, type OpenInScope } from "./OpenInSlot";

const webDevTools = workspaceFor("agency", "Web Dev").tools;
const seoTools = workspaceFor("agency", "SEO").tools;

const mount = async (p: OpenInScope) => render(await OpenInSlot(p));
const pilot = () => vi.mocked(getPrefs).mockResolvedValue({ shell: "workspaces" } as never);
const classic = () => vi.mocked(getPrefs).mockResolvedValue({ shell: "classic" } as never);
const labels = () => screen.getAllByRole("menuitem").map((a) => a.querySelector(".open-in__text > span")?.textContent);
const repo = (fullName: string, projectId: string | null) => ({ fullName, projectId });
const reposOk = (repos: unknown[], total = repos.length) =>
  vi.mocked(listGithubRepos).mockResolvedValue({ ok: true, data: { repos, total, limit: 200, offset: 0, org: {} } } as never);

beforeEach(() => {
  for (const m of [getPrefs, getProject, listDepartmentBriefs, myWorkspaces, listGithubRepos, listProperties]) vi.mocked(m).mockReset();
  vi.mocked(getProject).mockResolvedValue({ id: "p-1", department_id: "dept-1", shortCode: "WEB" } as never);
  vi.mocked(listDepartmentBriefs).mockResolvedValue([{ id: "dept-1", name: "Web Dev" }, { id: "dept-3", name: "SEO" }]);
  reposOk([]);
  vi.mocked(listProperties).mockResolvedValue([]);
});

describe("OpenInSlot · classic shell", () => {
  it("renders nothing and reads nothing", async () => {
    classic();
    const { container } = await mount({ scope: "project", projectId: "p-1" });
    expect(container.innerHTML).toBe("");
    expect(getProject).not.toHaveBeenCalled();
    expect(listGithubRepos).not.toHaveBeenCalled();
  });
});

describe("OpenInSlot · pilot, project and task", () => {
  it("lists the project's department workspace tools in registry order", async () => {
    pilot();
    await mount({ scope: "project", projectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(labels()).toEqual(webDevTools.map((t) => t.label));
  });

  it("uses the department of the project, not Web Dev's", async () => {
    pilot();
    vi.mocked(getProject).mockResolvedValue({ id: "p-3", department_id: "dept-3" } as never);
    await mount({ scope: "project", projectId: "p-3" });
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(labels()).toEqual(seoTools.map((t) => t.label));
  });

  it("renders no menu for a project with no department, or one not in the org tree", async () => {
    pilot();
    vi.mocked(getProject).mockResolvedValue({ id: "p-1", department_id: null } as never);
    expect((await mountContainer({ scope: "project", projectId: "p-1" })).innerHTML).toBe("");
    vi.mocked(getProject).mockResolvedValue({ id: "p-1", department_id: "dept-gone" } as never);
    expect((await mountContainer({ scope: "project", projectId: "p-1" })).innerHTML).toBe("");
    vi.mocked(getProject).mockRejectedValue(new Error("boom"));
    expect((await mountContainer({ scope: "project", projectId: "p-1" })).innerHTML).toBe("");
  });

  it("links the project's one linked repository, from a single registry read", async () => {
    pilot();
    reposOk([repo("gaiada/web-site", "p-1"), repo("gaiada/other", "p-9"), repo("gaiada/unlinked", null)]);
    await mount({ scope: "project", projectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(screen.getByRole("menuitem", { name: "GitHub, gaiada/web-site" })).toHaveAttribute("href", "https://github.com/gaiada/web-site");
    expect(screen.getByRole("menuitem", { name: "VS Code, clone gaiada/web-site" })).toHaveAttribute(
      "href",
      "vscode://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Fgaiada%2Fweb-site.git",
    );
    expect(listGithubRepos).toHaveBeenCalledTimes(1);
  });

  it("filters the task's pull requests by its key", async () => {
    pilot();
    reposOk([repo("gaiada/web-site", "p-1")]);
    await mount({ scope: "task", projectId: "p-1", taskKey: "WEB-12" });
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(screen.getByRole("menuitem", { name: "GitHub, gaiada/web-site pull requests for WEB-12" })).toHaveAttribute(
      "href",
      "https://github.com/gaiada/web-site/pulls?q=WEB-12",
    );
  });

  it("falls back to home links when the registry cannot be read, or the page was truncated, never 'no repo'", async () => {
    pilot();
    for (const failing of [
      () => vi.mocked(listGithubRepos).mockResolvedValue({ ok: false, reason: "refused" } as never),
      () => vi.mocked(listGithubRepos).mockResolvedValue({ ok: false, reason: "unavailable" } as never),
      () => vi.mocked(listGithubRepos).mockRejectedValue(new Error("boom")),
      () => reposOk([repo("gaiada/other", "p-9")], 500),
    ]) {
      failing();
      const { unmount } = await mount({ scope: "project", projectId: "p-1" });
      fireEvent.click(screen.getByRole("button", { name: "Open in" }));
      expect(screen.getByRole("menuitem", { name: "GitHub, home page" })).toHaveAttribute("href", "https://github.com");
      expect(screen.getByRole("menuitem", { name: "VS Code, home page" })).toHaveAttribute("href", "vscode://");
      unmount();
    }
  });
});

describe("OpenInSlot · pilot, client", () => {
  const home = (tools: readonly unknown[]) =>
    vi.mocked(myWorkspaces).mockResolvedValue({ home: { kind: "workspace", ref: { workspace: { tools } } } } as never);

  it("lists the viewer's home workspace tools", async () => {
    pilot();
    home(seoTools);
    await mount({ scope: "client", clientId: "cl-1" });
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(labels()).toEqual(seoTools.map((t) => t.label));
    expect(listGithubRepos).not.toHaveBeenCalled();
  });

  it("opens Search Console at its home while the property row does not say which kind it is", async () => {
    pilot();
    home(seoTools);
    vi.mocked(listProperties).mockResolvedValue([
      { id: "sp-1", clientId: "cl-1", domain: "example.com", siteUrl: "https://example.com/" },
      { id: "sp-2", clientId: "cl-2", domain: "other.com", siteUrl: null },
    ] as never);
    await mount({ scope: "client", clientId: "cl-1" });
    fireEvent.click(screen.getByRole("button", { name: "Open in" }));
    expect(screen.getByRole("menuitem", { name: "Search Console, home page" })).toHaveAttribute("href", "https://search.google.com/search-console");
  });

  it("renders no menu for a Company home or an empty tool set", async () => {
    pilot();
    vi.mocked(myWorkspaces).mockResolvedValue({ home: { kind: "company" } } as never);
    expect((await mountContainer({ scope: "client", clientId: "cl-1" })).innerHTML).toBe("");
    home([]);
    expect((await mountContainer({ scope: "client", clientId: "cl-1" })).innerHTML).toBe("");
  });
});

async function mountContainer(p: OpenInScope) {
  const { container, unmount } = await mount(p);
  const html = container.innerHTML;
  unmount();
  return { innerHTML: html };
}
