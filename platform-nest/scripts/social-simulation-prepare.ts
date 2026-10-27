// SCP-Sb — dev-checkout entry point for the social simulator's database preparation:
//   npx tsx scripts/social-simulation-prepare.ts            (DRY RUN: lists what would make boot refuse the switch)
//   npx tsx scripts/social-simulation-prepare.ts --apply    (marks the plainly-mock CP-21 seed accounts as simulated)
// The implementation is `src/seed/social-simulation-prepare.ts`: the platform image compiles only `src/` and has no `tsx`, so the
// container runs `node dist/seed/social-simulation-prepare.js` (same arguments). See that file's header and
// infra/runbooks/social-simulation.md.
import { main } from "../src/seed/social-simulation-prepare";

void main().then((code) => process.exit(code));
