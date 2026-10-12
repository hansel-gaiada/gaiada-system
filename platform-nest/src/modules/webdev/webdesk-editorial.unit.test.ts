// M5-W2d — the parts that need no services: the MCP tool registry carries exactly the stated impacts (design 4.3), every tool maps to a
// route the controller declares, and the review-flow body shapes are refused by the service only AFTER phase 2 (against stubs).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { webdevModule } from "./index";

const tools = () => webdevModule.mcpTools.filter((t) => t.name.startsWith("webdesk.editorial.") && !/(listGrants|grantRole|revokeRole)$/.test(t.name));
const byName = (n: string) => webdevModule.mcpTools.find((t) => t.name === n);

describe("M5-W2d MCP tools: the impact classes of design 4.3", () => {
  const low = ["submit", "withdraw", "requestChanges", "assign", "comment", "resolveComment"];
  const medium = ["seoSignoff", "approve", "setPolicy"];
  const reads = ["board", "calendar", "history"];
  it("low writes", () => {
    for (const n of low) expect(byName(`webdesk.editorial.${n}`), n).toMatchObject({ write: true, impact: "low" });
  });
  it("medium writes", () => {
    for (const n of medium) expect(byName(`webdesk.editorial.${n}`), n).toMatchObject({ write: true, impact: "medium" });
  });
  it("reads carry no write and no impact", () => {
    for (const n of reads) {
      const t = byName(`webdesk.editorial.${n}`);
      expect(t, n).toBeDefined();
      expect(t!.write).toBeFalsy();
      expect(t!.impact).toBeUndefined();
      expect(t!.method).toBe("GET");
    }
  });
  it("nothing here is high, and the set is exactly this one", () => {
    expect(tools().map((t) => t.name.replace("webdesk.editorial.", "")).sort()).toEqual([...low, ...medium, ...reads].sort());
    expect(tools().some((t) => t.impact === "high")).toBe(false);
  });
  it("approve and seoSignoff descriptions say Cerbos refuses automation and bots", () => {
    for (const n of ["approve", "seoSignoff"]) expect(byName(`webdesk.editorial.${n}`)!.description).toMatch(/refuses automation/i);
  });
  it("every path param of a template is a required input", () => {
    for (const t of tools()) {
      const params = [...(t.pathTemplate ?? "").matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
      for (const p of params) expect((t.inputSchema as { required: string[] }).required, `${t.name}:${p}`).toContain(p);
    }
  });
  it("every tool path is a route the content controller declares", () => {
    const src = readFileSync(join(__dirname, "webdesk-content.controller.ts"), "utf8");
    for (const t of tools()) {
      const rel = (t.pathTemplate as string).replace("/api/:tenantId/modules/webdev/content/", "");
      expect(src, t.name).toContain(`"${rel.replace(/:collectionKey/, ":collectionKey")}"`);
    }
  });
});

vi.mock("../../core/http", async (orig) => ({ ...(await orig<typeof import("../../core/http")>()), authorize: vi.fn(async () => undefined) }));

describe("M5-W2d service: the body is validated only after phase 2", () => {
  it("phase 2 runs first: a denial from openEditorialItem means the body parser never runs and nothing is written", async () => {
    const { WebdeskEditorialService } = await import("./webdesk-editorial.service");
    const write = vi.fn();
    const denied = vi.fn().mockRejectedValue(new Error("403"));
    const svc = new WebdeskEditorialService({ write } as never, { openEditorialItem: denied } as never);
    const gate = { require: () => undefined } as never;
    await expect(svc.itemCommand(gate, { tenantSlug: "t", siteId: "s" }, "i", "submit", { version: "not-a-number" }, "idem-0001")).rejects.toThrow("403");
    expect(denied).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });
  it("approve opens the gate as collection:read; every other item command as content_item:<its action>", async () => {
    const { WebdeskEditorialService } = await import("./webdesk-editorial.service");
    const seen: string[] = [];
    const open = vi.fn().mockRejectedValue(new Error("stop"));
    const svc = new WebdeskEditorialService({} as never, { openEditorialItem: open } as never);
    const gate = { require: (k: string, a: string) => { seen.push(`${k}:${a}`); } } as never;
    for (const c of ["submit", "withdraw", "requestChanges", "seoSignoff", "approve", "assign", "comment", "commentResolve"] as const) {
      await svc.itemCommand(gate, { tenantSlug: "t", siteId: "s" }, "i", c, {}, "idem-0001").catch(() => undefined);
    }
    expect(seen).toEqual([
      "webdesk_content_item:submit", "webdesk_content_item:submit", "webdesk_content_item:request_changes", "webdesk_content_item:seo_signoff",
      "webdesk_collection:read", "webdesk_content_item:assign", "webdesk_content_item:comment", "webdesk_content_item:comment",
    ]);
    expect(open.mock.calls.map((c) => c[3])).toEqual(["submit", "submit", "request_changes", "seo_signoff", "approve", "assign", "comment", "comment"]);
  });
  it("after phase 2, a bad body is a 400 and nothing is written", async () => {
    const { WebdeskEditorialService } = await import("./webdesk-editorial.service");
    const write = vi.fn();
    const svc = new WebdeskEditorialService({ write } as never, { openEditorialItem: vi.fn().mockResolvedValue({}) } as never);
    const gate = { require: () => undefined } as never;
    for (const [cmd, body] of [["submit", { version: 0 }], ["submit", { version: 1, extra: 1 }], ["requestChanges", { version: 1 }], ["comment", { version: 1, body: "x", anchor: "no-slash" }], ["assign", {}]] as const) {
      await expect(svc.itemCommand(gate, { tenantSlug: "t", siteId: "s" }, "i", cmd, body, "idem-0001"), cmd).rejects.toMatchObject({ status: 400 });
    }
    expect(write).not.toHaveBeenCalled();
  });
});
