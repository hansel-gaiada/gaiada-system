import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebdeskDeployTools } from "./webdesk-deploy-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:wd-contract-watch" });

describe("webdesk.deploy.probeReachability (retired, M6-P6j)", () => {
  beforeEach(() => {
    resetRegistry();
    registerWebdeskDeployTools();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays registered as a read-only tool and its description says it is retired", () => {
    const t = getTool("webdesk.deploy.probeReachability");
    expect(t).toBeDefined();
    expect(t!.write).toBeFalsy();
    expect(t!.description).toMatch(/^RETIRED/);
    expect(t!.description).toMatch(/WSK-D79/);
  });

  it.each([{ target: "staging" }, { target: "production" }, {}])("answers retired and probes nothing for %j", async (args) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = JSON.parse(await getTool("webdesk.deploy.probeReachability")!.handler(args, principal));
    expect(out.retired).toBe(true);
    expect(out.reachable).toBeNull(); // never a guessed true/false
    expect(out.detail).toBe(
      "retired: the control plane no longer reaches delivery hosts; delivery is per site via the site's CI (WSK-D79)",
    );
    expect(out.replacement).toMatch(/delivery-binding/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
