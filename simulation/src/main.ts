// The driver. One continuous loop that keeps the agency doing plausible work until it is stopped.
//
// SHAPE OF A TICK
// ---------------
// Each tick advances several independent strands rather than running one scenario to completion:
// departments work in parallel, agents are kept in flight, reads happen constantly, and the edge
// probes fire periodically. That matters for the office animation as well as for coverage — a floor
// where one room is busy and four are idle does not read as an office.
//
// FAST vs LIVE
// ------------
// `fast` drives hard to shake out defects and build the corpus. `live` leaves human-sized gaps so
// the office reads as a naturally busy floor rather than a stress test. Both use the same scenarios;
// only the pacing and the per-tick breadth differ.
//
// FAILURE POSTURE
// ---------------
// A scenario that throws is caught, recorded and skipped. The loop never dies on one bad endpoint —
// a harness that stops at the first defect finds exactly one defect.
import { config } from "./config.js";
import { initCorpus, writeSummary, logFinding, corpusPaths } from "./log.js";
import { departments, rosterSummary, staff, type Person } from "./roster.js";
import { tokenFor, humanPathLive } from "./token.js";
import { startFakeExternals } from "./fake-externals.js";
import {
  agentWork,
  approvalTouch,
  dailyReads,
  deliveryChain,
  edgeProbes,
  followAgentRuns,
  whatsappInbound,
  type ScenarioContext,
  type ScenarioResult,
} from "./scenarios.js";

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Flush and exit on the NEXT tick boundary rather than mid-scenario, so the corpus never ends
    // with a half-written piece of work that looks like a defect.
    console.log(`[sim] ${sig} received — finishing the current tick and stopping`);
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a scenario without letting it take the loop down. */
async function guard(name: string, fn: () => Promise<ScenarioResult>): Promise<ScenarioResult> {
  try {
    return await fn();
  } catch (err) {
    logFinding({
      key: "scenario-threw:" + name,
      severity: "medium",
      title: "Scenario threw: " + name,
      detail: "The harness itself failed here, which is worth separating from an estate defect when reading the corpus.",
      evidence: { scenario: name, error: (err as Error).message, stack: (err as Error).stack?.slice(0, 500) },
    });
    return { name, ran: false, note: "threw: " + (err as Error).message };
  }
}

async function main(): Promise<void> {
  initCorpus();
  const paths = corpusPaths();
  const summary = rosterSummary();

  console.log("[sim] run", config.runId, "mode", config.mode);
  console.log("[sim] tenant", config.tenantId);
  console.log("[sim] corpus", paths.runDir);
  console.log(
    "[sim] cast:",
    summary.realStaff,
    "real staff,",
    summary.placeholders,
    "retained placeholders across",
    summary.departments.length,
    "departments",
  );
  if (staff.length === 0) throw new Error("no drivable staff — run scripts/link-identities.sh");

  const ctx: ScenarioContext = {
    tick: 0,
    humanToken: (p: Person) => tokenFor(p.email),
  };

  // Probe the human path ONCE at startup rather than per scenario: if staff logins are not enabled
  // the answer will not change during the run, and retrying 19 accounts every tick would add
  // pointless load against Keycloak.
  const humanProbe = staff[0] ? await tokenFor(staff[0].email) : null;
  const humanAvailable = humanProbe !== null;
  console.log("[sim] human identity path:", humanAvailable ? "AVAILABLE" : "unavailable (service/agent paths only)");
  if (!humanAvailable) {
    logFinding({
      key: "parity-arm-missing",
      severity: "medium",
      title: "Agentic-native parity cannot be measured this run",
      detail:
        "Only the service/agent identity paths are live, so summary.json's parityGaps table has a single arm and cannot show a capability that works for a human but fails for an agent. Run scripts/enable-staff-logins.sh to add the human arm.",
      evidence: { probed: staff[0]?.email ?? null },
    });
  }

  // The fake external boundary. Started BEFORE any scenario runs so an outbound call can never
  // race a not-yet-listening stub and get recorded as a transport failure that was really a startup
  // ordering bug in the harness.
  const externals = await startFakeExternals(config.fakeExternalsPort);
  console.log("[sim] fake external boundary listening on", externals.port, "(nothing it receives leaves this container)");

  let tick = 0;
  const started = Date.now();

  while (!stopping && (config.maxTicks === 0 || tick < config.maxTicks)) {
    tick += 1;
    ctx.tick = tick;
    const ran: string[] = [];
    const skipped: string[] = [];

    // ── Strand A: department work. In `fast` every department each tick; in `live` two per tick, so
    //    the floor has movement without every desk changing at once.
    const deptsThisTick = config.mode === "fast" ? departments : departments.filter((_, i) => (i + tick) % 2 === 0);
    for (const dept of deptsThisTick) {
      // Alternate the identity path when both are available: the SAME business action performed by a
      // human and by a service is exactly the comparison the parity table needs.
      const path = humanAvailable && tick % 2 === 0 ? "human" : "obo";
      const r = await guard("delivery:" + dept, () => deliveryChain(dept, ctx, path));
      (r.ran ? ran : skipped).push(r.name + (r.note ? " (" + r.note + ")" : ""));
    }

    // ── Strand B: keep agents genuinely in flight. This is what animates the office.
    const a = await guard("agent:goal", () => agentWork(ctx));
    (a.ran ? ran : skipped).push(a.name + (a.note ? " (" + a.note + ")" : ""));
    const f = await guard("agent:follow", () => followAgentRuns(ctx));
    (f.ran ? ran : skipped).push(f.name + (f.note ? " (" + f.note + ")" : ""));

    // ── Strand C: the reads everybody does all day.
    for (const dept of deptsThisTick) {
      const r = await guard("reads:" + dept, () => dailyReads(dept, ctx));
      (r.ran ? ran : skipped).push(r.name);
    }

    // ── Strand D: approvals, and the edge probes. Probes on a stride: they are the highest-value
    //    strand for finding defects but pure noise once a defect is already recorded, and firing them
    //    every tick would drown the corpus in duplicates of the same finding.
    if (tick % 3 === 0) {
      const r = await guard("approval:queue", () => approvalTouch(ctx));
      (r.ran ? ran : skipped).push(r.name + (r.note ? " (" + r.note + ")" : ""));
    }
    if (tick % 5 === 1) {
      const r = await guard("probe:edges", () => edgeProbes(ctx));
      (r.ran ? ran : skipped).push(r.name);
    }

    // ── Strand E: the world calls in. Gated twice (config + a live WAHA session check) before it
    //    injects anything, because an inbound message can provoke a real outbound reply.
    if (tick % 2 === 0) {
      const r = await guard("external:whatsapp-inbound", () => whatsappInbound(ctx));
      (r.ran ? ran : skipped).push(r.name + (r.note ? " (" + r.note + ")" : ""));
    }

    writeSummary({
      tick,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      mode: config.mode,
      humanPathLive: humanPathLive(),
      roster: summary,
      lastTick: { ran, skipped },
    });

    console.log(
      `[sim] tick ${tick} — ran ${ran.length}, skipped ${skipped.length}` +
        (skipped.length ? " | skipped: " + skipped.join("; ") : ""),
    );

    if (stopping) break;
    await sleep(config.tickSeconds * 1000);
  }

  writeSummary({
    tick,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    finishedAt: new Date().toISOString(),
    stopped: true,
  });
  await externals.close();
  console.log("[sim] stopped after", tick, "ticks. Corpus at", paths.runDir);
}

main().catch((err) => {
  console.error("[sim] fatal:", err);
  // A fatal is itself corpus-worthy: a run that ended early for a reason nobody recorded is a run
  // whose absence of findings means nothing.
  try {
    logFinding({
      key: "driver-fatal",
      severity: "high",
      title: "The driver stopped with a fatal error",
      detail: "Everything after this point is missing from the corpus. Treat the run as truncated, not as clean.",
      evidence: { error: (err as Error).message, stack: (err as Error).stack?.slice(0, 800) },
    });
    writeSummary({ fatal: (err as Error).message });
  } catch {
    // Nothing useful left to do — the corpus itself is unwritable.
  }
  process.exit(1);
});
