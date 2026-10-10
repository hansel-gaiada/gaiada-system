// WSK-67 — dev-checkout entry point for the gaiada.com content importer:
//   npx tsx scripts/webdesk-import.ts --tenant-id <erpCompanyId> --site <tenantSlug>/<siteId> \
//        --bundle <path> --principal <importerUserId> [--apply] [--request-publish]
//
// The implementation is `src/seed/webdesk-import.ts`: the platform image compiles only `src/` and has no
// `tsx`, so the container runs `node dist/seed/webdesk-import.js` (same arguments). See that file's header.
import { main } from "../src/seed/webdesk-import";

void main().then((code) => process.exit(code));
