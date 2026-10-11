import { describe, it, expect, vi, beforeEach } from "vitest";

// switchTenant's `return` field (PV1-06b) must only ever send the person to a same-site path; anything
// else falls back to the dashboard, so the field can never become an open redirect.
const set = vi.fn();
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); });
vi.mock("next/headers", () => ({ cookies: async () => ({ set, get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

import { switchTenant } from "./tenant";

async function landing(ret?: string): Promise<string> {
  const fd = new FormData();
  fd.set("tenantId", "co-agency");
  if (ret !== undefined) fd.set("return", ret);
  try {
    await switchTenant(fd);
  } catch (e) {
    return String((e as Error).message).replace("REDIRECT:", "");
  }
  throw new Error("switchTenant did not redirect");
}

describe("switchTenant return path", () => {
  beforeEach(() => { set.mockClear(); redirect.mockClear(); });

  it("sets the tenant cookie and lands on the dashboard by default", async () => {
    expect(await landing()).toBe("/");
    expect(set).toHaveBeenCalledWith("gaiada_tenant", "co-agency", expect.objectContaining({ httpOnly: true }));
  });

  it("in production writes __Host-gaiada_tenant, Secure, Path=/ (B0: a sibling subdomain cannot toss it)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(await landing()).toBe("/");
      expect(set).toHaveBeenCalledWith(
        "__Host-gaiada_tenant", "co-agency", expect.objectContaining({ httpOnly: true, secure: true, path: "/" }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("honours a same-site path", async () => {
    expect(await landing("/reports/company")).toBe("/reports/company");
  });

  it("refuses anything that could leave the site", async () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "evil", ""]) {
      expect(await landing(bad), bad).toBe("/");
    }
  });
});
