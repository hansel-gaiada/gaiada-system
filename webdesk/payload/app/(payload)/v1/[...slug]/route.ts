/**
 * WSK-06's public /v1 entry point — wired by the coordinator, not by WSK-06 itself
 * (that worker was fenced out of app/** while WSK-04 was live in the same tree).
 *
 * WHY THIS FILE EXISTS AT ALL, rather than Payload's own config.endpoints:
 * Payload's REST dispatcher (payload/dist/utilities/handleEndpoints.js) will only
 * consult config.endpoints for paths under `config.routes.api` (default `/api`).
 * Registering /v1 there would expose it as `/api/v1/...`; re-pointing routes.api
 * at `/v1` would put Payload's automatic, UNSCOPED collection REST on the same
 * public prefix — which is exactly the WSK-D20 leak this platform exists to
 * prevent. A thin Next route handler is the narrow way through.
 *
 * The handler itself is a plain Request -> Response function so it stays testable
 * without Next in the loop (see test/envelope-contract.test.mjs, 60 assertions).
 */
import { handleV1Request } from '../../../../collections/router'

export const GET = handleV1Request
