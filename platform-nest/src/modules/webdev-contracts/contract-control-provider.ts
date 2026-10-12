// M6-P4j (WSK-D81) -- the ONE place that decides which control channel the contract mirror talks to.
//
//   1. The real four-layer channel (`WebdeskChannelContractProvider`) when `config.webdeskControl` is configured
//      (`WEBDESK_CONTROL_BASE_URL` set). This is what production has.
//   2. else the WSK-19 bearer stub (`WebdevControlHttpDriver`) when `config.webdevControl.baseUrl` is set: a dev
//      stack that points the mirror at a plain-http fixture WebDesk.
//   3. else `ContractControlNotConfiguredError`, which every caller already maps (completion: `not_yet`
//      `contract_channel_not_configured`; the console reads: no live source; the snapshots controller: 503).
//
// The real channel wins when both are set: a plain bearer cannot pass `ControlAuthGuard`, so preferring the stub would
// only ever be right on a box with no real channel. A real channel that is set but cannot be built (an unreadable
// certificate, say) is NOT a reason to fall back to the stub: it is reported as not configured, with what is missing.
import { config } from "../../config";
import { WebdeskControlNotConfiguredError, getWebdeskControlClient } from "../webdev/webdesk-control-client";
import { createWebdevControlHttpDriver } from "./contract-fetch-http";
import { WebdeskChannelContractProvider, type ContractChannelClient } from "./contract-fetch-webdesk";
import { ContractControlNotConfiguredError, type WebdevControlProvider } from "./contract-fetch-provider";

export interface ContractControlProviderOptions {
  /** Test seams; production passes none. `client` replaces the process-wide `WebdeskControlClient`. */
  client?: ContractChannelClient;
  /** Replace `config.webdeskControl.baseUrl` / `config.webdevControl.baseUrl` for the "is it configured" decision. */
  webdeskBaseUrl?: string;
  stubBaseUrl?: string;
}

export function resolveContractControlProvider(opts: ContractControlProviderOptions = {}): WebdevControlProvider {
  const webdeskBaseUrl = opts.webdeskBaseUrl ?? config.webdeskControl.baseUrl;
  if (webdeskBaseUrl) {
    try {
      return new WebdeskChannelContractProvider(opts.client ?? getWebdeskControlClient());
    } catch (err) {
      if (err instanceof WebdeskControlNotConfiguredError) throw new ContractControlNotConfiguredError(err.message);
      throw err;
    }
  }
  const stubBaseUrl = opts.stubBaseUrl ?? config.webdevControl.baseUrl;
  if (stubBaseUrl) return createWebdevControlHttpDriver();
  throw new ContractControlNotConfiguredError(
    "contract control channel not configured (WEBDESK_CONTROL_BASE_URL unset, and no WEBDEV_CONTROL_BASE_URL stub)",
  );
}
