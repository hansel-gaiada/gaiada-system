import { describe, it, expect } from "vitest";
import { gitignore, envExample, readme, tsconfig, packageJson } from "./common";

describe("shared template fragments", () => {
  it("gitignore excludes node_modules/dist/.env", () => {
    expect(gitignore().content).toContain("node_modules/");
    expect(gitignore().content).toContain(".env");
  });

  it(".env.example never carries a real secret value", () => {
    const content = String(envExample().content);
    expect(content).toContain("WEBDESK_API_KEY=\n");
    expect(content).not.toMatch(/WEBDESK_API_KEY=\S/);
  });

  it("README names the never-execute rule and the vocabulary-gap convention", () => {
    const content = String(readme({ siteKind: "astro", tenantSlug: "acme", blockLibraryVersion: "1.3.2" }).content);
    expect(content).toMatch(/never `npm install`-ed or run/);
    expect(content).toContain("webdesk-schema-proposals/");
  });

  it("package.json installs the block library + SDK as file: deps, never a registry version (OQ-6)", () => {
    const pkg = JSON.parse(String(packageJson({ name: "site", siteKind: "astro", blockLibraryVersion: "1.3.2" }).content));
    expect(pkg.dependencies["@gaiada/webdesk-blocks"]).toMatch(/^file:/);
    expect(pkg.dependencies["@gaiada/webdesk-sdk"]).toMatch(/^file:/);
    expect(pkg.dependencies["@astrojs/node"]).toBeUndefined();
  });

  it("a node-siteKind package.json also declares @astrojs/node", () => {
    const pkg = JSON.parse(String(packageJson({ name: "site", siteKind: "node", blockLibraryVersion: "1.3.2" }).content));
    expect(pkg.dependencies["@astrojs/node"]).toBeDefined();
  });

  it("tsconfig extends astro's strict preset", () => {
    const tc = JSON.parse(String(tsconfig().content));
    expect(tc.extends).toBe("astro/tsconfigs/strict");
  });
});
