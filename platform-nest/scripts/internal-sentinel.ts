// M5-G0 — dev-checkout entry point for the internal sentinel client + internal site property:
//   npx tsx scripts/internal-sentinel.ts --tenant-id <companyId> --name "<display name>" --domain <domain> [--apply]
// The implementation is `src/seed/internal-sentinel.ts`: the platform image compiles only `src/` and has no
// `tsx`, so the container runs `node dist/seed/internal-sentinel.js` (same arguments). See that file's header.
import { main } from "../src/seed/internal-sentinel";

void main().then((code) => process.exit(code));
