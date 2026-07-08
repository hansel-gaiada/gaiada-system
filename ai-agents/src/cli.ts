// Run a specialist from the command line:
//   npm run run-agent -- status-reporter "How are our projects doing? tenant=<uuid>" whatsapp 628110@c.us
import { runAgent } from "./agent";
import { runOrchestrator } from "./orchestrator";
import { specialists, supervisor } from "./specialists";
import { liveDeps } from "./deps";

const [name, goal, provider = "telegram", externalId = ""] = process.argv.slice(2);
const names = [...Object.keys(specialists), "supervisor"];
if (!name || !names.includes(name) || !goal || !externalId) {
  console.error(`usage: npm run run-agent -- <${names.join("|")}> "<goal>" <provider> <external-id>`);
  process.exit(1);
}

const run =
  name === "supervisor"
    ? runOrchestrator(supervisor, goal, { provider, externalId }, liveDeps).then((r) => ({
        header: `supervisor (${r.blackboard.length} subtasks)`,
        outcome: r.outcome,
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
