import { describe, it, expect } from "vitest";
import type { DeptLauncher } from "@/lib/deptToolkits";
import { toolContextLinks, toolLinkName } from "./toolContext";

const tool = (key: string, label: string, url: string): DeptLauncher => ({ key, label, desc: "", url, glyph: "x" });
const GITHUB = tool("github", "GitHub", "https://github.com");
const VSCODE = tool("vscode", "VS Code", "vscode://");
const GSC = tool("gsc", "Search Console", "https://search.google.com/search-console");
const FIGMA = tool("figma", "Figma", "https://www.figma.com");
const CLAUDE = tool("claude", "Claude", "https://claude.ai/new");

describe("toolContextLinks · GitHub", () => {
  it("opens GitHub's home, marked not contextual, when no repository is linked", () => {
    expect(toolContextLinks([GITHUB], {})).toEqual([{ key: "github", label: "GitHub", href: "https://github.com", contextual: false }]);
    expect(toolContextLinks([GITHUB], { repos: [] })[0].contextual).toBe(false);
    expect(toolContextLinks([GITHUB])[0].href).toBe("https://github.com");
  });

  it("links the repository for one repo", () => {
    expect(toolContextLinks([GITHUB], { repos: [{ fullName: "gaiada/web-site" }] })).toEqual([
      { key: "github", label: "GitHub", href: "https://github.com/gaiada/web-site", contextual: true, detail: "gaiada/web-site" },
    ]);
  });

  it("links that repo's pull requests filtered by the task key", () => {
    const [l] = toolContextLinks([GITHUB], { repos: [{ fullName: "gaiada/web-site" }], taskKey: "WEB-12" });
    expect(l.href).toBe("https://github.com/gaiada/web-site/pulls?q=WEB-12");
    expect(l.detail).toBe("gaiada/web-site pull requests for WEB-12");
    expect(l.contextual).toBe(true);
  });

  it("ignores an empty or blank task key", () => {
    expect(toolContextLinks([GITHUB], { repos: [{ fullName: "a/b" }], taskKey: null })[0].href).toBe("https://github.com/a/b");
    expect(toolContextLinks([GITHUB], { repos: [{ fullName: "a/b" }], taskKey: "  " })[0].href).toBe("https://github.com/a/b");
  });

  it("gives one entry per repo for several repos, in the order given", () => {
    const links = toolContextLinks([GITHUB], { repos: [{ fullName: "a/one" }, { fullName: "a/two" }], taskKey: "ABC-1" });
    expect(links.map((l) => l.href)).toEqual(["https://github.com/a/one/pulls?q=ABC-1", "https://github.com/a/two/pulls?q=ABC-1"]);
  });

  it("URL-encodes the task key", () => {
    const [l] = toolContextLinks([GITHUB], { repos: [{ fullName: "a/b" }], taskKey: "A&B C-1" });
    expect(l.href).toBe("https://github.com/a/b/pulls?q=A%26B%20C-1");
  });

  it("drops a repository whose name is not owner/name, and duplicates", () => {
    const links = toolContextLinks([GITHUB], { repos: [{ fullName: "nonsense" }, { fullName: "a/b?x=1" }, { fullName: "a/b" }, { fullName: "a/b" }] });
    expect(links.map((l) => l.href)).toEqual(["https://github.com/a/b"]);
    expect(toolContextLinks([GITHUB], { repos: [{ fullName: "nonsense" }] })[0].contextual).toBe(false);
  });
});

describe("toolContextLinks · VS Code", () => {
  it("opens the plain vscode:// home with no repo", () => {
    expect(toolContextLinks([VSCODE], {})).toEqual([{ key: "vscode", label: "VS Code", href: "vscode://", contextual: false }]);
  });

  it("builds the clone link with the encoded https clone url, for each repo", () => {
    const links = toolContextLinks([VSCODE], { repos: [{ fullName: "gaiada/web-site" }, { fullName: "gaiada/api" }] });
    expect(links.map((l) => l.href)).toEqual([
      "vscode://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Fgaiada%2Fweb-site.git",
      "vscode://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Fgaiada%2Fapi.git",
    ]);
    expect(links.every((l) => l.contextual)).toBe(true);
  });

  it("does not use the task key", () => {
    expect(toolContextLinks([VSCODE], { repos: [{ fullName: "a/b" }], taskKey: "X-1" })[0].href).toBe(
      "vscode://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Fa%2Fb.git",
    );
  });
});

describe("toolContextLinks · Search Console", () => {
  it("uses sc-domain:<domain> for a domain property", () => {
    const [l] = toolContextLinks([GSC], { searchProperties: [{ domain: "example.com", kind: "domain" }] });
    expect(l.href).toBe("https://search.google.com/search-console?resource_id=sc-domain%3Aexample.com");
    expect(l.contextual).toBe(true);
    expect(l.detail).toBe("example.com");
  });

  it("uses the URL itself for a URL-prefix property", () => {
    const [l] = toolContextLinks([GSC], { searchProperties: [{ domain: "example.com", siteUrl: "https://www.example.com/blog/", kind: "url-prefix" }] });
    expect(l.href).toBe("https://search.google.com/search-console?resource_id=https%3A%2F%2Fwww.example.com%2Fblog%2F");
    expect(l.detail).toBe("https://www.example.com/blog/");
  });

  it("gives one entry per property, once each", () => {
    const links = toolContextLinks([GSC], {
      searchProperties: [
        { domain: "a.com", kind: "domain" },
        { domain: "a.com", kind: "domain" },
        { domain: "b.com", siteUrl: "https://b.com/", kind: "url-prefix" },
      ],
    });
    expect(links).toHaveLength(2);
  });

  it("falls back to home when the row does not say which kind it is (never guesses)", () => {
    const [l] = toolContextLinks([GSC], { searchProperties: [{ domain: "example.com", siteUrl: "https://example.com/" }] });
    expect(l).toEqual({ key: "gsc", label: "Search Console", href: "https://search.google.com/search-console", contextual: false });
  });

  it("falls back to home for a url-prefix property with no url, and with no properties", () => {
    expect(toolContextLinks([GSC], { searchProperties: [{ domain: "x.com", siteUrl: null, kind: "url-prefix" }] })[0].contextual).toBe(false);
    expect(toolContextLinks([GSC], {})[0].contextual).toBe(false);
    expect(toolContextLinks([GSC], { searchProperties: [] })[0].href).toBe("https://search.google.com/search-console");
  });

  it("encodes characters that would break the query", () => {
    const [l] = toolContextLinks([GSC], { searchProperties: [{ domain: "x.com", siteUrl: "https://x.com/a?b=1&c=2#f", kind: "url-prefix" }] });
    expect(l.href).toBe("https://search.google.com/search-console?resource_id=https%3A%2F%2Fx.com%2Fa%3Fb%3D1%26c%3D2%23f");
    expect(new URL(l.href).searchParams.get("resource_id")).toBe("https://x.com/a?b=1&c=2#f");
  });
});

// DW-6k: Figma links to each linked file or frame by its stored (normalised) url; no link, or none usable, opens the home page.
describe("toolContextLinks · Figma", () => {
  const FRAME = "https://www.figma.com/design/abc123?node-id=1-2";
  const FILE = "https://www.figma.com/design/def456";

  it("opens the home page, marked not contextual, when the task has no links", () => {
    expect(toolContextLinks([FIGMA], {})).toEqual([{ key: "figma", label: "Figma", href: "https://www.figma.com", contextual: false }]);
    expect(toolContextLinks([FIGMA], { figmaLinks: [] })[0].contextual).toBe(false);
  });

  it("links the file or frame for one link, with the title as the detail", () => {
    expect(toolContextLinks([FIGMA], { figmaLinks: [{ url: FRAME, title: "Brand / Hero" }] })).toEqual([
      { key: "figma", label: "Figma", href: FRAME, contextual: true, detail: "Brand / Hero" },
    ]);
  });

  it("gives one entry per link, in the order given, expanding in place", () => {
    const links = toolContextLinks([CLAUDE, FIGMA, VSCODE], { figmaLinks: [{ url: FRAME, title: "Hero" }, { url: FILE, title: "Brand" }] });
    expect(links.map((l) => [l.key, l.href])).toEqual([["claude", "https://claude.ai/new"], ["figma", FRAME], ["figma", FILE], ["vscode", "vscode://"]]);
  });

  it("names a link whose title Figma has not given yet, and lists a repeated address once", () => {
    const links = toolContextLinks([FIGMA], { figmaLinks: [{ url: FRAME, title: null }, { url: FRAME, title: "Again" }, { url: FILE, title: "  " }] });
    expect(links.map((l) => l.detail)).toEqual(["linked Figma file", "linked Figma file"]);
    expect(links).toHaveLength(2);
  });

  it("never links an address that is not a Figma https one; with none left it opens the home page", () => {
    const links = toolContextLinks([FIGMA], { figmaLinks: [{ url: "javascript:alert(1)", title: "x" }, { url: "https://evil.example/design/a", title: "y" }] });
    expect(links).toEqual([{ key: "figma", label: "Figma", href: "https://www.figma.com", contextual: false }]);
  });

  it("is not changed by the other tools' context, and does not change theirs", () => {
    const ctx = { repos: [{ fullName: "a/b" }], taskKey: "A-1", figmaLinks: [{ url: FRAME, title: "Hero" }] };
    const links = toolContextLinks([GITHUB, FIGMA], ctx);
    expect(links.map((l) => l.href)).toEqual(["https://github.com/a/b/pulls?q=A-1", FRAME]);
  });

  it("reads as what it opens in the accessible name", () => {
    const [l] = toolContextLinks([FIGMA], { figmaLinks: [{ url: FRAME, title: "Brand / Hero" }] });
    expect(toolLinkName(l)).toBe("Figma, Brand / Hero");
  });
});

describe("toolContextLinks · the rest", () => {
  it("opens every other tool at its home, even with a full context", () => {
    const ctx = { repos: [{ fullName: "a/b" }], taskKey: "A-1", searchProperties: [{ domain: "x.com", kind: "domain" as const }] };
    const links = toolContextLinks([FIGMA, CLAUDE], ctx);
    expect(links).toEqual([
      { key: "figma", label: "Figma", href: "https://www.figma.com", contextual: false },
      { key: "claude", label: "Claude", href: "https://claude.ai/new", contextual: false },
    ]);
  });

  it("keeps the registry's order, expanding a multi-repo tool in place", () => {
    const links = toolContextLinks([CLAUDE, GITHUB, FIGMA, VSCODE], { repos: [{ fullName: "a/one" }, { fullName: "a/two" }] });
    expect(links.map((l) => l.key)).toEqual(["claude", "github", "github", "figma", "vscode", "vscode"]);
  });

  it("returns nothing for no tools", () => {
    expect(toolContextLinks([], { repos: [{ fullName: "a/b" }] })).toEqual([]);
  });
});

describe("toolLinkName", () => {
  it("says what a contextual link opens", () => {
    const [l] = toolContextLinks([GITHUB], { repos: [{ fullName: "gaiada/web-site" }], taskKey: "WEB-12" });
    expect(toolLinkName(l)).toBe("GitHub, gaiada/web-site pull requests for WEB-12");
  });

  it("says a home link is the tool's home page", () => {
    expect(toolLinkName(toolContextLinks([FIGMA])[0])).toBe("Figma, home page");
  });
});
