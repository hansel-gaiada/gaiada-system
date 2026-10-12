// M6-P3b — dev-checkout entry point for the internal webdev_sites client backfill:
//   npx tsx scripts/internal-sites-backfill.ts --tenant-id <companyId> --domains-file <path> [--apply]
// The implementation is `src/seed/internal-sites-backfill.ts`: the platform image compiles only `src/` and has no
// `tsx`, so the container runs `node dist/seed/internal-sites-backfill.js` (same arguments). See that file's header.
import { main } from "../src/seed/internal-sites-backfill";

void main().then((code) => process.exit(code));
