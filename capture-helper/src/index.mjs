#!/usr/bin/env node
// WS11 capture-helper entry. Starts the local control UI; the operator records from there.
import { config, assertReady, driveConfigured } from "./config.mjs";
import { startServer } from "./server.mjs";

const missing = assertReady();
if (missing.length) {
  console.error("capture-helper: missing config —", missing.join(", "));
  console.error("Set them in the environment / .env (see .env.example) and restart.");
  process.exit(1);
}

startServer();
console.log(`Gaiada Capture Helper → http://${config.uiHost}:${config.uiPort}`);
console.log(`  platform : ${config.platformUrl}  (tenant ${config.tenantId})`);
console.log(`  whisper  : ${config.whisperUrl} (${config.whisperModel})`);
console.log(`  recordings: ${config.recordingsDir}`);
console.log(`  drive    : ${driveConfigured() ? "configured" : "NOT configured (reminders only)"}`);
