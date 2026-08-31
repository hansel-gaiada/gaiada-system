// WSK-29 — a THIN, read-only diagnostic wrapper over webdesk/deploy's own HTTP service (see that
// package's server.ts header). Registered as an ordinary hub tool so an operator or an automation
// flow can ask "is delphi/helios reachable right now" through the same MCP surface as everything
// else, without SSH access of their own.
//
// DELIBERATELY NOT A WRITE TOOL, and there is no `webdesk.deploy.driver.deploy` here or anywhere in
// this file. The mutating call (webdesk/deploy's `deploy()`) is reachable ONLY as a library call —
// its own HTTP service does not even expose it (see that file's header for why: no Cerbos, no WS4,
// no principal model on that side, so it must never be the thing a network caller can invoke to
// change a live host). The AUTHORIZED path for an actual WebDesk deploy is the aggregated
// `webdesk.deploy.staging` / `webdesk.site.promote` tools (WSK-31, platform-nest's webdev module),
// which run the real Cerbos + ALWAYS_WS4 gate before ever reaching Zone B. Do not "complete" this
// file by adding a deploy tool that bypasses that — see this ticket's report for the full reasoning.
import { config } from "./config";
import { registerTool } from "./registry";

export interface WebdeskProbeResult {
  target: "staging" | "production";
  host: string;
  reachable: boolean;
  checkedAt: string;
  detail: string;
  latencyMs?: number;
}

export function registerWebdeskDeployTools(): void {
  registerTool({
    name: "webdesk.deploy.probeReachability",
    description:
      "Read-only: check whether the WebDesk (Zone A) frontend-deploy service can currently reach " +
      "delphi (staging) or helios (production) over SSH. Never deploys anything. Returns a " +
      "ReachabilityResult { target, host, reachable, checkedAt, detail }.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["staging", "production"], description: "which host to probe" },
      },
      required: ["target"],
    },
    handler: async (args) => {
      if (!config.webdeskDeployUrl) {
        throw new Error("webdesk.deploy.probeReachability not enabled: set WEBDESK_DEPLOY_URL (the webdesk/deploy service's base URL)");
      }
      const target = String(args.target ?? "");
      if (target !== "staging" && target !== "production") {
        throw new Error('target must be "staging" or "production"');
      }
      const res = await fetch(`${config.webdeskDeployUrl}/probe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.webdeskDeployToken ? { Authorization: `Bearer ${config.webdeskDeployToken}` } : {}),
        },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `webdesk-deploy /probe ${res.status}`);
      }
      const result = (await res.json()) as WebdeskProbeResult;
      return JSON.stringify(result);
    },
  });
}
