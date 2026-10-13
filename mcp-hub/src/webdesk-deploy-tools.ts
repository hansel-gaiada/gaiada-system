// RETIRED (M6-P6j, WSK-D29 / WSK-D79). This tool used to be a thin wrapper over webdesk/deploy's
// HTTP service, which SSHed to delphi/helios to see whether they answered. The control plane no
// longer reaches delivery hosts: delivery is per site, run by the site's own CI (SFTP, the scripts
// in webdesk/templates/_deploy/), with the per-site binding set by `POST sites/:id/delivery-binding`.
//
// The tool stays registered, and honest, because automation flows and agent personas may still
// call it by name; a missing tool would read as an outage, a "retired" answer reads as what it is.
// The handler makes NO network call of any kind (the test stubs fetch and asserts it is never
// touched). There is no deploy tool here either: the authorised write path is the aggregated
// `webdesk.deploy.staging` / `webdesk.site.promote` tools (Cerbos + ALWAYS_WS4), which dispatch the
// SITE'S workflow, not a control-plane executor.
import { registerTool } from "./registry";

export interface WebdeskProbeRetired {
  retired: true;
  reachable: null;
  detail: string;
  replacement: string;
}

export const WEBDESK_PROBE_RETIRED_DETAIL =
  "retired: the control plane no longer reaches delivery hosts; delivery is per site via the site's CI (WSK-D79)";

export function registerWebdeskDeployTools(): void {
  registerTool({
    name: "webdesk.deploy.probeReachability",
    description:
      "RETIRED. Does not probe anything. The control plane no longer reaches delivery hosts " +
      "(WSK-D29); delivery is per site, run by the site's own CI over SFTP (WSK-D79). Always answers " +
      "{ retired: true, reachable: null, detail, replacement }. To see whether a site's delivery " +
      "works, read its delivery binding and its last deploy run, or rebuild it through the " +
      "webdesk.deploy.staging tool.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["staging", "production"], description: "ignored; kept so existing callers still validate" },
      },
    },
    handler: async () => {
      const result: WebdeskProbeRetired = {
        retired: true,
        reachable: null,
        detail: WEBDESK_PROBE_RETIRED_DETAIL,
        replacement:
          "the site's own CI deploys over SFTP (webdesk/templates/_deploy/deploy.sh); bind it with " +
          "POST sites/:id/delivery-binding; runbook infra/runbooks/webdesk-staging-rebuild.md",
      };
      return JSON.stringify(result);
    },
  });
}
