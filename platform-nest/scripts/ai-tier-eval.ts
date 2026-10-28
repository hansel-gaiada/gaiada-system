// AIP-09 — dev-checkout entry point of the gateway tier eval:  npx tsx scripts/ai-tier-eval.ts --out /tmp/aip09.json
// The implementation is `src/modules/ai-usage/evals/run-eval.ts` (read its header: verdicts, exit codes, the gate rule). The platform image
// compiles only `src/` and has no `tsx`, so the container runs `node dist/modules/ai-usage/evals/run-eval.js` (same arguments).
import { main } from "../src/modules/ai-usage/evals/run-eval";

void main().then((code) => process.exit(code));
