// Simulation configuration — every value is read from the environment, and every SECRET is read
// from the environment the container was GIVEN rather than from anything in this repo.
//
// The harness runs as its own compose project (`gaiada-sim`) attached to the existing external
// `gaiada_default` network, so it reaches the estate by service alias exactly as the estate's own
// services reach each other. Two consequences worth stating, because both were deliberate:
//
//  1. It inherits `infra/compose/.env` through `env_file`. That is how PLATFORM_SERVICE_TOKEN and
//     AGENT_RUNNER_TOKEN arrive. Nobody reads, copies or transports those values to author or run
//     this harness — the same mechanism every other service already uses.
//  2. It is a SEPARATE compose project on purpose. Adding a service to the `gaiada` project would
//     put it in range of `docker compose ... --remove-orphans`, which deletes any `gaiada`-project
//     container whose profile is absent from the command — a trap that has already cost this
//     program real containers. A distinct project name is immune to that.

/** Fail loudly at startup rather than sending `undefined` at a live estate. A missing token here
 *  would otherwise surface as a wall of 401s twenty minutes into a run. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  // `Number("")` is 0 and `Number(undefined)` is NaN — an empty compose variable becoming a real
  // 0 is exactly the footgun that once pinned a service at 46% CPU in a busy loop. Treat any
  // non-finite or non-positive value as "not configured".
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** `fast` compresses a working week into minutes to shake out defects and build the log corpus.
 *  `live` paces actions at human speed so the office reads as a naturally busy floor. */
export type SimMode = "fast" | "live";

export const config = {
  /** Gaia Digital Agency — the first-deploy child company the program requires to be genuinely
   *  operable. Overridable so the harness can be pointed at another tenant without a rebuild. */
  tenantId: optional("SIM_TENANT_ID", "019fb652-c68b-728f-b779-04465fcec5ae"),

  platformUrl: optional("SIM_PLATFORM_URL", "http://platform:3004"),
  runnerUrl: optional("SIM_RUNNER_URL", "http://agent-runner:3006"),
  hubUrl: optional("SIM_HUB_URL", "http://mcp-hub:3003"),
  n8nUrl: optional("SIM_N8N_URL", "http://n8n:5678"),
  botUrl: optional("SIM_BOT_URL", "http://bot:3001"),
  /** The real WAHA container, consulted ONLY to ask whether its session could actually deliver a
   *  message. Never used to send. */
  wahaUrl: optional("SIM_WAHA_URL", "http://waha:3000"),
  /** The PUBLIC origin, used only for the OIDC token exchange — Keycloak issues tokens against the
   *  public issuer, so minting one over the internal alias would produce an issuer the platform
   *  rejects. */
  publicUrl: optional("SIM_PUBLIC_URL", "https://erp.gaiada.online"),

  serviceToken: required("PLATFORM_SERVICE_TOKEN"),
  runnerToken: required("AGENT_RUNNER_TOKEN"),

  /** Mounted read-only from /etc/gaiada/sim-staff.pw on the host. The password never enters this
   *  repo, an image layer, a log line or a compose variable — the file is the only carrier, and
   *  `identity.ts` is the only reader. */
  simPasswordFile: optional("SIM_PASSWORD_FILE", "/run/secrets/sim-staff.pw"),

  mode: (optional("SIM_MODE", "fast") === "live" ? "live" : "fast") as SimMode,

  /** Where the corpus lands. A mounted volume, so a container replacement never loses a run. */
  logDir: optional("SIM_LOG_DIR", "/var/lib/gaiada-sim/logs"),

  /** Identifies this run in every log line AND in every record the run creates, which is what
   *  makes a precise teardown possible. Injected by the launcher so a restart of the same run
   *  keeps writing to the same corpus. */
  runId: optional("SIM_RUN_ID", `sim-${new Date().toISOString().replace(/[:.]/g, "-")}`),

  /** How many scenario "actors" advance concurrently. Deliberately modest: the point is a busy
   *  office, not a load test — k6 is the tool for load, and hammering a live estate would produce
   *  findings about saturation rather than about correctness. */
  concurrency: intEnv("SIM_CONCURRENCY", 4),

  /** Wall-clock seconds between scheduler ticks. `fast` drives hard; `live` leaves human-sized
   *  gaps so the office animation looks like people working rather than a stress test. */
  tickSeconds: intEnv("SIM_TICK_SECONDS", 0) || (optional("SIM_MODE", "fast") === "live" ? 20 : 2),

  /** Hard stop. 0 means run until stopped — the intended posture for the live-paced loop. */
  maxTicks: intEnv("SIM_MAX_TICKS", 0),

  /** Every record the simulation creates carries this marker in a human-visible field, so a person
   *  looking at the ERP can always tell simulated work from real work without consulting a table.
   *  Teardown matches on it as a backstop to the precise id ledger. */
  marker: optional("SIM_MARKER", "[SIM]"),

  /** Belt-and-braces guard against ever pointing this at something that is not a dev estate.
   *  Set SIM_ALLOW_TENANT to override deliberately. */
  dryRun: optional("SIM_DRY_RUN", "0") === "1",

  /** Port the fake external boundary listens on, inside the container. */
  fakeExternalsPort: intEnv("SIM_FAKE_EXTERNALS_PORT", 4599),

  /** Submit an agent goal only every Nth tick.
   *
   *  ⚠ THIS EXISTS BECAUSE THE SIMULATION EXHAUSTED A REAL BUDGET. The AI Gateway enforces a
   *  per-tenant DAILY cap on model calls (1000 for this estate). Submitting one goal per tick, with
   *  each goal making several model calls, burned through it in roughly three hours — after which
   *  every agent goal failed with an opaque `gateway 429` and the agent strand measured nothing
   *  except the cap.
   *
   *  Two costs, and the second is the one that matters: the measurement window closes, AND the calls
   *  before it were real spend against a real provider. A harness that quietly consumes a day's
   *  budget is not a harness anyone can leave running.
   *
   *  Default 6: at the live pace (20s ticks) that is one goal every two minutes, ~30/hour, which
   *  leaves the cap intact across a full working day while still keeping the office animated — the
   *  agent desks only need SOME run in flight, not a continuous stream. */
  agentEveryNTicks: intEnv("SIM_AGENT_EVERY_N_TICKS", 6),

  /** The bot's webhook shared secret, inherited from the estate's env. The webhook is FAIL-CLOSED
   *  without it — every event is rejected 401. Optional here so the harness still starts when it is
   *  absent; the inbound scenario then reports why it skipped rather than 401-ing in a loop. */
  botWebhookSecret: optional("WEBHOOK_SECRET", ""),

  /** Inject simulated WhatsApp messages at the bot?
   *
   *  Default on, but the scenario ALSO refuses at runtime unless the real WAHA session is provably
   *  unable to deliver (see `whatsappInbound`). Two independent gates, because processing an inbound
   *  message can make the bot attempt an outbound REPLY, and this estate runs a live WAHA container.
   *  A flag on its own would be one typo away from messaging a real handset. */
  inboundWhatsapp: optional("SIM_INBOUND_WHATSAPP", "1") === "1",
} as const;

export type Config = typeof config;
