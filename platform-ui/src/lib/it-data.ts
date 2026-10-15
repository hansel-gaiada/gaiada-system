import "server-only";
// DW-7e: the honest device list, for the Overview's Pulse. `listDevices` (lib/it.ts) turns a 403 and a 404 into `[]`, so a
// "devices offline" tile fed by it would say 0 for a viewer who was refused, or for an IT module that is not served. This
// returns a `ReadResult` (403 `forbidden`, 404 and 5xx `unavailable`). The route is `GET /api/:t/it/devices`.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { Device } from "./it";

export function listDevicesResult(u: string, t: string): Promise<ReadResult<Device[]>> {
  return readResult(platformFetch<Device[]>(`/api/${t}/it/devices`, u));
}
