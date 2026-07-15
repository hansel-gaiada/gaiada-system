// Run a specialist from the command line:
//   npm run run-agent -- status-reporter "How are our projects doing? tenant=<uuid>" whatsapp 628110@c.us
import { runAgent } from "./agent";
import { runOrchestrator } from "./orchestrator";
import { runWriteAgent } from "./write-agent";
import { specialists, writeSpecialists, supervisor } from "./specialists";
import { liveDeps } from "./deps";

const [name, goal, provider = "telegram", externalId = ""] = process.argv.slice(2);
const names = [...Object.keys(specialists), ...Object.keys(writeSpecialists), "supervisor"];
if (!name || !names.includes(name) || !goal || !externalId) {
  console.error(`usage: npm run run-agent -- <${names.join("|")}> "<goal>" <provider> <external-id>`);
  process.exit(1);
}

// A write-capable specialist runs through runWriteAgent: the D13 provider gate + D14 approval filing.
// tenantId (for a filed approval) + the serving provider come from env.
const tenantId = process.env.AGENCY_TENANT_ID ?? "";
const servingProvider = process.env.GATEWAY_PROVIDER ?? "echo";

const run =
  name === "supervisor"
    ? runOrchestrator(supervisor, goal, { provider, externalId }, liveDeps).then((r) => ({
        header: `supervisor (${r.blackboard.length} subtasks)`,
        outcome: r.outcome,
      }))
    : writeSpecialists[name]
      ? runWriteAgent(writeSpecialists[name], goal, { provider, externalId }, liveDeps, tenantId, servingProvider).then((r) => ({
          header: `${name} [${r.status}]`,
          outcome:
            r.status === "completed" || r.status === "forced_read_only"
              ? r.run.outcome + (r.status === "forced_read_only" ? `\n(note: ${r.reason})` : "")
              : `suspended for approval — filed ${r.filed.approvalId ?? "(id unknown)"} for ${r.filed.tool} (${r.filed.impact})`,
        }))
      : runAgent(specialists[name], goal, { provider, externalId }, liveDeps).then((r) => ({
          header: `${name} (${r.steps.length} steps)`,
          outcome: r.outcome,
        }));

run
  .then(({ header, outcome }) => console.log(`\n=== ${header} ===\n${outcome}`))
  .catch((err) => {
    console.error(`[${(err as Error).constructor.name}] ${(err as Error).message}`);
    process.exit(2);
  });
