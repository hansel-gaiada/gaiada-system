// SCP-Sf — dev-checkout entry point for the social simulator's purge:
//   npx tsx scripts/social-simulation-purge.ts            (DRY RUN: lists, per company, every row it would remove or put back)
//   npx tsx scripts/social-simulation-purge.ts --apply    (removes the simulator's footprint, one transaction per company)
// The implementation is `src/seed/social-simulation-purge.ts` (rules: `src/seed/social-simulation-purge-plan.ts`): the platform
// image compiles only `src/` and has no `tsx`, so the container runs `node dist/seed/social-simulation-purge.js` (same arguments).
// It refuses while SOCIAL_SIMULATION_ENABLED is on. See infra/runbooks/social-simulation.md, step 7.
import { main } from "../src/seed/social-simulation-purge";

void main().then((code) => process.exit(code));
