// Unit test for the settings-UI module catalog. No DB/guard needed — the controller just projects
// the module registry (same shape of test as mcp-tools.controller.test.ts).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ModuleCatalogController } from "./module-catalog.controller";
import { resetModules, registerModule, enabledModuleKeys } from "./registry";
import { agencyModule } from "./agency";
import { hrModule } from "./hr";
import { reportsModule } from "./reports";

describe("ModuleCatalogController", () => {
  beforeEach(() => resetModules());

  it("lists every registered module regardless of any tenant's enabled_modules", () => {
    [agencyModule, hrModule, reportsModule].forEach(registerModule);
    expect(new ModuleCatalogController().catalog().map((m) => m.key)).toEqual(["agency", "hr", "reports"]);
  });

  it("carries the uiManifest label + paths so the toggle row can name what it darks", () => {
    registerModule(hrModule);
    expect(new ModuleCatalogController().catalog()[0]).toMatchObject({
      key: "hr",
      label: "HR Workspace",
      paths: expect.arrayContaining(["/hr", "/hr/leave"]),
    });
  });

  it("falls back to the key when a module declares no uiManifest entries", () => {
    registerModule({ ...hrModule, key: "bare", uiManifest: [] });
    expect(new ModuleCatalogController().catalog()).toEqual([{ key: "bare", label: "bare", paths: [] }]);
  });

  it("is empty when no modules are registered", () => {
    expect(new ModuleCatalogController().catalog()).toEqual([]);
  });
});

// The per-tenant read is membership-gated; the effective-set computation itself lives in
// enabledModuleKeys (DB-backed, covered by the hr/reports module suites against live PG).
vi.mock("./registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry")>()),
  enabledModuleKeys: vi.fn(),
}));

const req = (companies: string[], roles: { role: string; scopeType: string }[] = []) =>
  ({ principal: { userId: "u-1", companies, roles } }) as unknown as FastifyRequest;

describe("ModuleCatalogController — per-tenant enablement", () => {
  beforeEach(() => vi.mocked(enabledModuleKeys).mockReset());

  it("returns the effective set for a company the caller belongs to", async () => {
    vi.mocked(enabledModuleKeys).mockResolvedValue(["agency", "hr"]);
    await expect(new ModuleCatalogController().enabled(req(["t-1"]), "t-1")).resolves.toEqual({
      tenantId: "t-1",
      enabled: ["agency", "hr"],
    });
  });

  it("403s a caller with no membership in that company (and never queries)", async () => {
    await expect(new ModuleCatalogController().enabled(req(["t-other"]), "t-1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(enabledModuleKeys).not.toHaveBeenCalled();
  });

  it("lets a global platform_admin read any company's set", async () => {
    vi.mocked(enabledModuleKeys).mockResolvedValue([]);
    const r = req([], [{ role: "platform_admin", scopeType: "global" }]);
    await expect(new ModuleCatalogController().enabled(r, "t-1")).resolves.toEqual({ tenantId: "t-1", enabled: [] });
  });

  it("a company-scoped platform_admin grant is NOT a global one", async () => {
    const r = req([], [{ role: "platform_admin", scopeType: "company" }]);
    await expect(new ModuleCatalogController().enabled(r, "t-1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});
