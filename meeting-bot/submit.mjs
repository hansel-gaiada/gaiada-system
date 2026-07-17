// WS11 meeting-bot STUB (build item 11). Contract-faithful poster to the dispatcher webhook — drives
// the pipeline from a pasted transcript until the real recording bot is chosen (WS11 plan §10).
// Usage: N8N_URL=.. N8N_BRIDGE_SECRET=.. AGENCY_TENANT_ID=.. node submit.mjs <transcript-file> [title] [meetingId]
import { readFileSync } from "node:fs";

const N8N = process.env.N8N_URL ?? "http://localhost:5678";
const SECRET = process.env.N8N_BRIDGE_SECRET ?? "";
const TENANT = process.env.AGENCY_TENANT_ID ?? "";

const [file, title = "Untitled meeting", meetingId] = process.argv.slice(2);
if (!file) { console.error("usage: node submit.mjs <transcript-file> [title] [meetingId]"); process.exit(1); }
if (!SECRET || !TENANT) { console.error("set N8N_BRIDGE_SECRET and AGENCY_TENANT_ID"); process.exit(1); }

const transcript = readFileSync(file, "utf8");
// A deterministic-ish id when none is given (fine for a manual stub; the real bot supplies a stable id).
const id = meetingId ?? `mtg-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`;

const res = await fetch(`${N8N}/webhook/mtg/recording-complete`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-gaiada-bridge-secret": SECRET },
  body: JSON.stringify({ v: 1, meetingId: id, tenantId: TENANT, title, transcript }),
});
const text = await res.text();
console.log(`HTTP ${res.status}: ${text}`);
process.exit(res.ok ? 0 : 1);
