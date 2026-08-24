// The work itself. Each scenario is one recognisable piece of agency business, driven end to end
// through the REAL endpoints, by REAL named people, on a chosen identity path.
//
// DESIGN RULE: a scenario never asserts success. It reports what happened and lets `http.ts` judge.
// A scenario that threw on the first 500 would stop the simulation at exactly the moment it started
// being useful — the point is to keep working through a broken estate and accumulate evidence.
//
// DESIGN RULE 2: every record created carries `config.marker` in a human-visible field and is
// written to the teardown ledger the instant it exists. A simulated task that cannot be told apart
// from real work, on an estate the owner demos from, is a mess somebody else has to clean up.
import { config } from "./config.js";
import { call } from "./http.js";
import { logCreated, logFinding, type ActorPath } from "./log.js";
import { actorFor, doersIn, leadOf, pick, staff, staffIn, placeholders, type Person } from "./roster.js";
import { wahaInboundMessage, wahaSessionStatus } from "./fake-externals.js";

const T = config.tenantId;

/** Discovered once per run: creating a task needs a real project, and inventing a projectId would
 *  just produce 400s that say more about the harness than the estate. */
let projectCache: { id: string; name: string }[] | null = null;

async function projects(driver: Person): Promise<{ id: string; name: string }[]> {
  if (projectCache) return projectCache;
  const { actor, obo } = actorFor(driver, "obo");
  const res = await call<{ id: string; name: string }[]>({
    path: `/api/${T}/projects`,
    actor,
    obo,
    scenario: "bootstrap",
    step: "list-projects",
  });
  projectCache = Array.isArray(res.body) ? res.body.filter((p) => p && p.id) : [];
  if (projectCache.length === 0) {
    logFinding({
      key: "no-projects-available",
      severity: "medium",
      title: "No projects readable — task scenarios cannot run",
      detail:
        "GET /api/:t/projects returned nothing for a real staff principal. Either the tenant genuinely has no projects, or project reads are denied on this identity path. Every task-creating scenario is skipped while this holds.",
      evidence: { status: res.status, actor: driver.email },
    });
  }
  return projectCache;
}

/** A short, plausible line of work text. Deliberately hand-written rather than model-generated: the
 *  simulation is testing the ERP, not a language model, and a fixed bank keeps runs comparable. */
const BRIEFS: Record<string, string[]> = {
  "Web Dev": [
    "Landing page hero not rendering on Safari 17",
    "Add booking form validation for the villa enquiry flow",
    "Migrate the blog templates to the new component library",
    "Page speed regression on the packages listing",
  ],
  SEO: [
    "Keyword gap analysis against the two nearest competitors",
    "Fix the duplicate meta descriptions across 40 service pages",
    "Internal linking pass for the wedding-venue cluster",
    "Recover rankings lost after the template migration",
  ],
  Creatives: [
    "Three carousel concepts for the September promotion",
    "Re-grade the villa twilight set for the brochure",
    "Logo lockup variants for the co-branded campaign",
    "Storyboard the 20-second reel cutdown",
  ],
  "Social Media": [
    "Draft the week's content calendar for review",
    "Community replies backlog from the weekend",
    "Repurpose the reel into three story frames",
  ],
  GM: [
    "Consolidate the monthly client health summary",
    "Review scope creep on the retainer accounts",
  ],
};

const HANDOFF_NOTES = [
  "Passing this over — my part is done, the copy still needs your eye.",
  "Blocked on assets, handing the ball to you with what I have.",
  "Reviewed and happy. Over to you for the final pass.",
  "Picked this up, found a second issue underneath — noting it here before I move it on.",
];

const PROGRESS_NOTES = [
  "Started on this. First pass looks straightforward.",
  "Halfway. The tricky part is the mobile breakpoint.",
  "Client came back with one more change; folding it in.",
  "Done on my side, leaving notes for whoever picks this up next.",
];

export interface ScenarioContext {
  tick: number;
  /** Supplies a real IdP token for the human path, or null when staff logins are not enabled yet. */
  humanToken: (p: Person) => Promise<string | null>;
}

export interface ScenarioResult {
  name: string;
  ran: boolean;
  note?: string;
  /** Task ids this scenario left in flight, so the office has something to keep being busy about. */
  taskIds?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. A piece of work moves through a department, and the ball changes hands.
//
// This is the scenario that produces the employee-to-employee data flow the whole exercise is about:
// two real named people, one real task, a real assignee change, real comments on both sides, and
// real time entries. It is also the one the "anyone can pass the ball" owner decision made possible,
// so it doubles as a live check on that decision.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function deliveryChain(department: string, ctx: ScenarioContext, path: ActorPath): Promise<ScenarioResult> {
  const name = `delivery:${department}`;

  // WHO MAY RAISE WORK IS NOT WHO DOES IT. resource_pm_task.yaml reserves `create` for
  // company_admin/manager, so the chain has to start with the department lead. The first smoke run
  // of this harness skipped three departments outright on "task create failed (403)" until this was
  // modelled properly — which is itself the finding: an ordinary employee cannot raise a task.
  const lead = leadOf(department);
  if (!lead) return { name, ran: false, note: `no lead with create rights in ${department}` };

  // The doer is an ordinary member. Preferably in the same department; if the department has no
  // member at all (GM and Social Media each have exactly one real person, their lead), the ball goes
  // to a member ELSEWHERE — a cross-department handoff, which is real agency behaviour, and is
  // labelled as such rather than quietly presented as an intra-department flow.
  const local = doersIn(department);
  const crossDept = local.length === 0;
  const doer = crossDept
    ? pick(staff.filter((p) => p.department !== department && doersIn(p.department).includes(p)), ctx.tick)
    : pick(local, ctx.tick);
  if (!doer) return { name, ran: false, note: "no member available to do the work" };

  const projs = await projects(lead);
  if (projs.length === 0) return { name, ran: false, note: "no projects available" };
  const project = pick(projs, ctx.tick)!;

  const briefs = BRIEFS[department] ?? BRIEFS.GM!;
  const title = `${config.marker} ${pick(briefs, ctx.tick)}`;

  const leadActor = actorFor(lead, path);
  const doerActor = actorFor(doer, path);
  const leadToken = path === "human" ? await ctx.humanToken(lead) : undefined;
  const doerToken = path === "human" ? await ctx.humanToken(doer) : undefined;
  if (path === "human" && (!leadToken || !doerToken)) {
    return { name, ran: false, note: "human path unavailable (staff logins not enabled)" };
  }

  // ── the lead raises it and puts the ball on the doer ────────────────────────────────────────────
  const created = await call<{ id: string }>({
    method: "POST",
    path: `/api/${T}/pm/tasks`,
    body: {
      projectId: project.id,
      title,
      priority: ctx.tick % 5 === 0 ? "high" : "normal",
      description:
        `Simulated work item, run ${config.runId}. Raised in ${department} by ${lead.name}` +
        (crossDept ? `, delegated to ${doer.name} in ${doer.department}.` : "."),
      assignee: {
        kind: "person",
        refId: doer.userId,
        refName: doer.name,
        // The LEAD stays responsible; the doer holds the ball. This is the distinction the PATCH
        // handler escalates on, and getting it backwards would silently test `manage` instead.
        responsibleId: lead.userId,
        responsibleName: lead.name,
      },
    },
    actor: leadActor.actor,
    obo: leadActor.obo,
    token: leadToken ?? undefined,
    scenario: name,
    step: "lead-raises-task",
  });

  const taskId = created.body?.id;
  if (!taskId) return { name, ran: false, note: `task create failed (${created.status})` };
  logCreated("pm_task", taskId, title);

  // ── the doer picks it up, works, and talks about it ─────────────────────────────────────────────
  const doerBase = { actor: doerActor.actor, obo: doerActor.obo, token: doerToken ?? undefined, scenario: name };

  await call({ ...doerBase, method: "POST", path: `/api/${T}/pm/tasks/${taskId}/follow`, step: "doer-follows" });
  await call({
    ...doerBase,
    method: "POST",
    path: `/api/${T}/comments`,
    body: { entityType: "task", entityId: taskId, body: `${pick(PROGRESS_NOTES, ctx.tick)} ${config.marker}` },
    step: "doer-comments-progress",
  });
  await call({
    ...doerBase,
    method: "POST",
    path: `/api/${T}/pm/tasks/${taskId}/time`,
    body: { minutes: 25 + (ctx.tick % 4) * 15, note: `${config.marker} focus block` },
    step: "doer-logs-time",
  });

  // A member moving a task's STATUS is `update`, which they hold — unlike create. Exercising it here
  // is what proves the split is real rather than assumed.
  await call({
    ...doerBase,
    method: "PATCH",
    path: `/api/${T}/pm/tasks/${taskId}`,
    body: { priority: ctx.tick % 3 === 0 ? "high" : "normal" },
    step: "doer-updates-task",
  });

  // ── THE HANDOFF BACK — the ball returns to the lead for sign-off ────────────────────────────────
  // "Anyone can pass the ball" (owner decision, 2026-08-06) means a plain member may do this even
  // though they could not have created the task. That asymmetry is worth exercising every tick.
  await call({
    ...doerBase,
    method: "PATCH",
    path: `/api/${T}/pm/tasks/${taskId}`,
    body: {
      assignee: {
        kind: "person",
        refId: lead.userId,
        refName: lead.name,
        responsibleId: lead.userId,
        responsibleName: lead.name,
      },
    },
    step: "doer-passes-ball-back",
  });
  await call({
    ...doerBase,
    method: "POST",
    path: `/api/${T}/comments`,
    body: { entityType: "task", entityId: taskId, body: `${pick(HANDOFF_NOTES, ctx.tick)} ${config.marker}` },
    step: "doer-comments-handoff",
  });

  // ── the lead reviews and closes out ────────────────────────────────────────────────────────────
  const leadBase = { actor: leadActor.actor, obo: leadActor.obo, token: leadToken ?? undefined, scenario: name };
  await call({
    ...leadBase,
    method: "POST",
    path: `/api/${T}/comments`,
    body: { entityType: "task", entityId: taskId, body: `Reviewed. ${config.marker}` },
    step: "lead-reviews",
  });
  await call({ ...leadBase, path: `/api/${T}/pm/tasks/${taskId}/assignment-history`, step: "lead-reads-ball-history", expect: [200, 403, 404] });

  return {
    name,
    ran: true,
    note: crossDept ? `cross-dept: ${lead.name} (${department}) -> ${doer.name} (${doer.department})` : `${lead.name} -> ${doer.name}`,
    taskIds: [taskId],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Real agent work.
//
// This is the ONLY thing on the estate that makes the office canvas animate: `office-data.ts` sets
// `activeRunId` for a goal with an open run, and the canvas then polls that run's events and shows a
// working desk while events stay fresher than 45 seconds. So keeping goals genuinely in flight is
// what makes the floor look busy — and, usefully, it is also a real end-to-end exercise of the
// runner, the gateway, the model and the MCP tool surface.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const READ_AGENTS = ["status-reporter", "pm-reporter", "approvals-chaser"] as const;

export async function agentWork(ctx: ScenarioContext): Promise<ScenarioResult> {
  const requester = pick(staffIn("GM").length ? staffIn("GM") : staffIn("Web Dev"), ctx.tick);
  if (!requester) return { name: "agent:goal", ran: false, note: "no requester available" };
  // `staff` is already filtered to people with a verified link, so this holds today — but it is
  // checked rather than asserted, because an envelope that cannot resolve does not fail loudly: it
  // silently becomes the anonymous principal and every tool call is denied, which reads like a
  // policy problem rather than a missing row. That misdiagnosis is exactly what this guard prevents.
  if (!requester.whatsapp) {
    return { name: "agent:goal", ran: false, note: `${requester.email} has no verified link — the agent would run as anonymous` };
  }

  const agent = READ_AGENTS[ctx.tick % READ_AGENTS.length]!;
  const goals = [
    "Summarise the open task load per department and name the biggest risk.",
    "Which tasks have been sitting unchanged the longest, and who holds them?",
    "List approvals waiting on someone, oldest first.",
    "Report this week's completed work by department.",
  ];

  const { actor } = actorFor(requester, "agent", agent);
  const res = await call<{ id: string; status: string }>({
    method: "POST",
    base: config.runnerUrl,
    path: "/goals",
    body: {
      tenantId: T,
      goal: `${pick(goals, ctx.tick)} (${config.marker} run ${config.runId})`,
      agent,
      // ⚠ THE ENVELOPE MUST RESOLVE TO A REAL PERSON, and getting this wrong cost a whole run.
      //
      // This used to send `{provider: "simulation", externalId: "<runId>-t<tick>"}` on the reasoning
      // that "simulation" was the honest name for the channel. That reasoning was wrong twice over:
      //
      //   1. It is not more honest. The envelope's job is to name the HUMAN this work is done for —
      //      the runner passes it verbatim to every tool call, and the platform resolves it through
      //      `identity_links` to decide what the agent may see. A real person genuinely did request
      //      this goal. Their envelope IS the truthful answer; the channel is what `requestedBy` and
      //      the goal text are for.
      //   2. There is no `identity_links` row for provider "simulation", so the platform resolved it
      //      to the ANONYMOUS principal and Cerbos denied every tool call. Once the tenant bug (F9)
      //      was fixed, this became the next wall: 73 of 74 goals failed with "cerbos denied read on
      //      pm_task" instead of the earlier uuid 500s.
      //
      // So the agent now acts on behalf of the requesting employee, with that employee's reach —
      // which is also the correct security model: an agent should never see more than the person who
      // asked it. `x-obo-agent` still records the agent as co-author, so provenance is not lost.
      envelope: { provider: "whatsapp", externalId: requester.whatsapp },
      requestedBy: requester.userId,
    },
    actor: { ...actor, path: "agent" },
    scenario: "agent:goal",
    step: `submit-${agent}`,
    // The runner answers 202 on accept and 429 when its queue is full. A full queue is real
    // backpressure, not a defect, so both are expected.
    expect: [202, 429],
    // The runner requires its own bearer, not the platform's.
    token: config.runnerToken,
  });

  const goalId = res.body?.id;
  if (!goalId) return { name: "agent:goal", ran: false, note: `goal not accepted (${res.status})` };
  logCreated("agent_goal", goalId, `${agent}: ${config.marker}`);
  return { name: "agent:goal", ran: true, note: `${agent} goal ${goalId}` };
}

/** Follow a goal's run events — the same data the office canvas polls. Confirms the animation has
 *  something real to render, and surfaces a run that dies without ever emitting. */
export async function followAgentRuns(ctx: ScenarioContext): Promise<ScenarioResult> {
  const anyone = pick(staffIn("GM"), ctx.tick) ?? pick(staffIn("Web Dev"), ctx.tick);
  if (!anyone) return { name: "agent:follow", ran: false };
  const { actor } = actorFor(anyone, "agent");

  const list = await call<{ goals: { id: string; status: string; agent?: string }[] }>({
    base: config.runnerUrl,
    path: `/goals?tenant=${T}&limit=20`,
    actor: { ...actor, path: "agent" },
    scenario: "agent:follow",
    step: "list-goals",
    token: config.runnerToken,
  });

  const inFlight = (list.body?.goals ?? []).filter((g) => g.status === "queued" || g.status === "running");
  let eventTotal = 0;
  for (const g of inFlight.slice(0, 3)) {
    const detail = await call<{ activeRunIds?: string[]; runs?: { runId: string }[] }>({
      base: config.runnerUrl,
      path: `/goals/${g.id}?tenant=${T}`,
      actor: { ...actor, path: "agent" },
      scenario: "agent:follow",
      step: "goal-detail",
      token: config.runnerToken,
    });
    const runId = detail.body?.activeRunIds?.[0] ?? detail.body?.runs?.[0]?.runId;
    if (!runId) continue;
    const events = await call<{ events: { seq: number; kind: string }[] }>({
      base: config.runnerUrl,
      path: `/runs/${runId}/events?tenant=${T}&since=0`,
      actor: { ...actor, path: "agent" },
      scenario: "agent:follow",
      step: "run-events",
      token: config.runnerToken,
    });
    eventTotal += events.body?.events?.length ?? 0;
  }

  return { name: "agent:follow", ran: true, note: `${inFlight.length} in flight, ${eventTotal} events seen` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Edge probes — the part that actually finds bugs.
//
// Ordinary happy-path work exercises what already works. These are the malformed, boundary and
// wrong-shape requests real callers genuinely make: an agent that omits an argument, a client that
// sends a string where a number belongs, an id that does not exist. Every one of them should produce
// a 4xx. A 5xx is a defect, and `http.ts` records it as one automatically.
//
// The first probe run of this harness found exactly this class: a missing tenantId became the literal
// text "undefined" in a URL and Postgres raised an unhandled uuid cast error, surfacing as a 500.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function edgeProbes(ctx: ScenarioContext): Promise<ScenarioResult> {
  const who = pick(staffIn("Web Dev"), ctx.tick);
  if (!who) return { name: "probe:edges", ran: false };
  const { actor, obo } = actorFor(who, "obo");
  const base = { actor, obo, scenario: "probe:edges" as const };

  // A malformed tenant path segment. This is the exact shape the mcp-hub produced, and it must be a
  // 400, never a 500 — a path parameter should never reach the database as raw text.
  await call({ ...base, path: `/api/undefined/projects`, step: "tenant-literal-undefined", expect: [400, 401, 403, 404] });
  await call({ ...base, path: `/api/not-a-uuid/pm/tasks`, step: "tenant-not-a-uuid", expect: [400, 401, 403, 404] });

  // A well-formed uuid that does not exist. Should be 404 (or 403 before the lookup), never 500.
  await call({ ...base, path: `/api/${T}/pm/tasks/00000000-0000-4000-8000-000000000000`, step: "task-absent", expect: [403, 404] });

  // Wrong types and missing required fields on a write.
  await call({
    ...base,
    method: "POST",
    path: `/api/${T}/pm/tasks`,
    body: { title: `${config.marker} probe with no project` },
    step: "create-task-no-project",
    expect: [400, 403],
  });
  await call({
    ...base,
    method: "POST",
    path: `/api/${T}/pm/tasks`,
    body: { projectId: "not-a-uuid", title: `${config.marker} probe bad project id` },
    step: "create-task-bad-project",
    expect: [400, 403, 404],
  });
  await call({
    ...base,
    method: "POST",
    path: `/api/${T}/comments`,
    body: { entityType: "task", entityId: "not-a-uuid", body: "probe" },
    step: "comment-bad-entity-id",
    expect: [400, 403, 404],
  });

  // A boundary the contract states explicitly: limit must be 1..MAX.
  await call({ ...base, path: `/api/${T}/pm/tasks?limit=0`, step: "limit-zero", expect: [400] });
  await call({ ...base, path: `/api/${T}/pm/tasks?limit=999999`, step: "limit-huge", expect: [400] });
  await call({ ...base, path: `/api/${T}/pm/tasks?status=<script>`, step: "status-injection-shape", expect: [400] });

  // An oversized body. The contract caps a goal at 4000 chars; a task title has its own limit. This
  // checks the cap exists rather than the string reaching the column and raising a DB error.
  await call({
    ...base,
    method: "POST",
    path: `/api/${T}/pm/tasks`,
    body: { projectId: (await projects(who))[0]?.id, title: `${config.marker} ` + "x".repeat(9000) },
    step: "title-oversized",
    expect: [400, 403, 413],
  });

  // An unresolvable OBO envelope. This SHOULD be distinguishable from an authorization failure — it
  // currently is not, which cost real diagnostic time during this harness's own bring-up, so it is
  // probed deliberately rather than left as folklore.
  await call({
    path: `/api/${T}/pm/tasks?limit=1`,
    actor: { name: "unknown envelope", path: "obo" },
    obo: { provider: "whatsapp", externalId: "+99900009999" },
    scenario: "probe:edges",
    step: "obo-unknown-identity",
    expect: [401, 403],
  });

  return { name: "probe:edges", ran: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Approvals — the one flow that legitimately needs a retained placeholder actor, because no real
//    employee currently holds the approver role.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function approvalTouch(ctx: ScenarioContext): Promise<ScenarioResult> {
  const approver = placeholders.find((p) => /approver|client lead|owner/i.test(p.name));
  if (!approver || !approver.whatsapp) {
    return { name: "approval:queue", ran: false, note: "no drivable approver actor (placeholders have no whatsapp link)" };
  }
  const { actor, obo } = actorFor(approver, "obo");
  await call({
    path: `/api/${T}/agency/approvals`,
    actor,
    obo,
    scenario: "approval:queue",
    step: "list-approvals",
    expect: [200, 403, 404],
  });
  return { name: "approval:queue", ran: true, note: `read as ${approver.name} (retained placeholder actor)` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6. The world calls in — a WhatsApp message arrives at the bot.
//
// This is the inbound half of the fake boundary, and the more valuable half: inbound is where the
// estate does its own parsing, durable persistence and dispatch. The payload is WAHA's real shape,
// read off `wa-chat-bot/src/waha.ts::normalize()` rather than invented — a plausible-but-wrong
// envelope would be silently dropped by `normalizeWahaEvent` and the scenario would report a
// cheerful 200 while the bot ignored every message.
//
// ⚠ THE SAFETY GATE, AND WHY IT IS A RUNTIME CHECK RATHER THAN A FLAG.
// Processing an inbound message can make the bot attempt an outbound REPLY through the REAL WAHA
// container on this box. So before injecting anything, this asks WAHA what its session status is,
// and proceeds ONLY if the session provably cannot deliver (anything other than WORKING). If the
// session is live, the scenario skips and says so. A config flag alone is one typo away from
// messaging a stranger's handset; a flag plus a live check is not.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
let wahaDeliveryPossible: boolean | null = null;

async function sessionCouldDeliver(): Promise<boolean> {
  if (wahaDeliveryPossible !== null) return wahaDeliveryPossible;

  // ASK THE BOT, NOT WAHA. Two reasons, and the second is the important one:
  //   1. WAHA's `/api/sessions` requires an API key (it answers 401 without one), and the harness
  //      has no business holding another credential just to ask a yes/no safety question.
  //   2. The BOT is the component that would actually send the reply. Its own `/health` reports the
  //      session state it would use, so it is the more truthful source for "could a reply leave
  //      this estate" — WAHA being reachable says nothing about whether the bot is wired to it.
  //
  // Anything other than a definite non-delivering state FAILS CLOSED. "I could not check" is not
  // "it is safe": the cost of being wrong one way is a skipped scenario, and the other way is a
  // real message to a real person.
  try {
    const res = await fetch(`${config.botUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      wahaDeliveryPossible = true;
      return true;
    }
    const body = (await res.json()) as { session?: string };
    const session = String(body.session ?? "").toUpperCase();
    // The states in which WhatsApp cannot deliver. Deliberately an ALLOW-LIST of safe states rather
    // than a deny-list of unsafe ones: a WAHA release that adds a new status must default to unsafe.
    const cannotDeliver = new Set(["STOPPED", "FAILED", "SCAN_QR_CODE", "STARTING", ""]);
    wahaDeliveryPossible = !cannotDeliver.has(session);
  } catch {
    wahaDeliveryPossible = true;
  }
  return wahaDeliveryPossible;
}

export async function whatsappInbound(ctx: ScenarioContext): Promise<ScenarioResult> {
  const name = "external:whatsapp-inbound";
  if (!config.inboundWhatsapp) return { name, ran: false, note: "disabled by SIM_INBOUND_WHATSAPP=0" };
  if (!config.botWebhookSecret) {
    return { name, ran: false, note: "no bot webhook secret in env — the webhook is fail-closed and would 401" };
  }
  if (await sessionCouldDeliver()) {
    logFinding({
      key: "inbound-skipped-live-waha",
      severity: "info",
      title: "WhatsApp inbound injection skipped — the real session could deliver",
      detail:
        "The WAHA session is WORKING (or its state could not be read, which fails closed). Injecting an inbound message could make the bot reply to a real handset, so the scenario refused. This is the gate working, not a defect.",
      evidence: { wahaUrl: config.wahaUrl },
    });
    return { name, ran: false, note: "real WAHA session could deliver — refusing to inject" };
  }

  const who = pick(staff, ctx.tick);
  if (!who || !who.whatsapp) return { name, ran: false, note: "no drivable staff phone" };

  const messages = [
    "Morning — any update on the villa landing page?",
    "Client just called about the September promo, can someone look?",
    "The booking form is throwing an error on mobile.",
    "Sending the new brand assets over shortly.",
  ];

  const envelope = wahaInboundMessage({
    fromPhone: who.whatsapp,
    senderName: `${who.name} ${config.marker}`,
    text: `${pick(messages, ctx.tick)} ${config.marker}`,
  });

  // The bot authenticates the hook with `?token=<secret>`, matching how WAHA is configured to call
  // it. Sent as a query parameter rather than a header because that is the shape the real caller
  // uses, and testing a different shape would prove nothing about the real path.
  const res = await call({
    method: "POST",
    base: config.botUrl,
    path: `/webhook?token=${encodeURIComponent(config.botWebhookSecret)}`,
    body: envelope,
    actor: { name: who.name, userId: who.userId, email: who.email, department: who.department, path: "external" },
    scenario: name,
    step: "inbound-message",
    // 200 = accepted. 503 = the bot could not make the event durable, which it returns deliberately
    // so WAHA retries — real backpressure, not a defect.
    expect: [200, 503],
  });

  // A session lifecycle event too: the disconnect case is the one operators care about most, and it
  // was silently dropped by the bot until recently.
  if (ctx.tick % 7 === 0) {
    await call({
      method: "POST",
      base: config.botUrl,
      path: `/webhook?token=${encodeURIComponent(config.botWebhookSecret)}`,
      body: wahaSessionStatus("FAILED"),
      actor: { name: "waha", path: "external" },
      scenario: name,
      step: "inbound-session-failed",
      expect: [200, 503],
    });
  }

  return { name, ran: true, note: `inbound as ${who.name} (${res.status})` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. Read-heavy surfaces every employee actually opens. Cheap, and they catch the frontend-first
//    drift class: an endpoint the UI reads that quietly stopped answering.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function dailyReads(department: string, ctx: ScenarioContext): Promise<ScenarioResult> {
  const who = pick(staffIn(department), ctx.tick);
  if (!who) return { name: `reads:${department}`, ran: false };
  const { actor, obo } = actorFor(who, "obo");
  const base = { actor, obo, scenario: `reads:${department}` as const };

  await call({ ...base, path: `/api/tasks/mine`, step: "my-tasks" });
  await call({ ...base, path: `/api/${T}/notifications`, step: "notifications" });
  await call({ ...base, path: `/api/${T}/pm/tasks?assignee=me&limit=10`, step: "tasks-assigned-to-me" });
  await call({ ...base, path: `/api/${T}/projects`, step: "projects" });
  await call({ ...base, path: `/api/${T}/pm/productivity`, step: "productivity", expect: [200, 403] });

  return { name: `reads:${department}`, ran: true };
}
