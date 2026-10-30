// SCP-5f (BFF §63.27.4) — the DEMO_MODE answer of the cycle health's `steps`: the six steps of each demo cycle, in every state. INVENTED data on the demo
// pipeline's own cycles and posts (`demoSocialPipeline.ts`), so what the Plan tab's strip and the Team dashboard say matches the posts in the same demo.
//
// The steps are the seeded defaults of the company's rules (BFF §63.30, `cycle.steps`); the server reads them per company, the demo has the default six. Each
// step's state is computed from the cycle's posts on the SAME conditions as the server (platform-nest `pipeline/cycle-steps.ts`, §63.27.2), so a stage action
// in the demo moves the strip as it moves the server's PM tasks. The due dates walk back from ready-by by the client's step estimates, in working days; with no
// estimates every step but the report falls due on ready-by, and the report on the client's report day in the month before the cycle's.
//
// ONE STEP CLOSED BY HAND, THEN REOPENED. A person may close a step task by hand in PM, and the pipeline reopens it at its next recompute when its condition
// does not hold (§63.27.3). The demo seeds one such step (`handSeed`); it stays done while the cycle's posts are exactly as they were, and the first stage action
// on any of them (any change of a counted post's status) is that recompute: the step reopens. Nothing is stored but the posts' state at the time it was closed.
//
// Pure but for that one mark, pinned to globalThis like the other demo stores. No real client, person or task: `taskId` is an invented id.

export interface DemoStepPost {
  id: string; pipelineStatus: string; isExtra: boolean; format: string | null;
  changeCase: string | null; changedOnly: boolean; blockedFrom: string | null; archivedAt: string | null;
}

export interface DemoStepInput {
  cycleId: string;
  /** `YYYY-MM`. */
  month: string;
  readyBy: string;
  today: string;
  target: number | null;
  /** The client's step estimates, in working days (`proofread`, `hod`, `design`, `final`, `client`, `schedule`). */
  estimates: Readonly<Record<string, number>>;
  reportDueDay: number | null;
  posts: readonly DemoStepPost[];
  /** The client's monthly report for the month two before this cycle's is delivered. */
  reportDelivered: boolean;
  walkBack: (iso: string, workingDays: number) => string;
  /** A step key to seed as closed by hand (the first time this cycle is read), or null. */
  handSeed?: string | null;
}

export interface DemoStepRow {
  step: string; title: string; taskId: string | null; dueDate: string | null; done: boolean; progress: number;
  autoClose: "auto" | "manual"; holder: { role: "officer"; label: string } | null; late: boolean;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string): string => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const monthPlus = (m: string, k: number): string => {
  const t = Number(m.slice(0, 4)) * 12 + (Number(m.slice(5, 7)) - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const lastDayOf = (m: string): number => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

type Rule = "report_delivered" | "plan_laid_out" | "copy_locked" | "artwork_done" | "client_approved" | "all_scheduled";
/** The seeded defaults: key, title, the estimates still to run after the step (its `lessEstimatesFrom` and on), and what closes it. */
const STEPS: ReadonlyArray<{ key: string; title: (m: string) => string; from: readonly string[] | null; rule: Rule }> = [
  { key: "report", title: (m) => `Monthly report for ${monthName(monthPlus(m, -2))}`, from: null, rule: "report_delivered" },
  { key: "planning", title: (m) => `${monthName(m)} plan`, from: ["proofread", "hod", "design", "final", "client", "schedule"], rule: "plan_laid_out" },
  { key: "copy_lock", title: (m) => `${monthName(m)} copy locked`, from: ["design", "final", "client", "schedule"], rule: "copy_locked" },
  { key: "artwork", title: (m) => `${monthName(m)} artwork`, from: ["final", "client", "schedule"], rule: "artwork_done" },
  { key: "client_window", title: (m) => `${monthName(m)} client approval`, from: ["schedule"], rule: "client_approved" },
  { key: "deploy", title: (m) => `${monthName(m)} scheduled`, from: [], rule: "all_scheduled" },
];

// The server's sets (cycle-steps.ts), restated: a status that has passed each step's point.
const PAST_COPY = new Set(["design", "final", "client", "approved", "scheduled", "live"]);
const PAST_COPY_CASES = new Set(["final_design", "client_design"]);
const PAST_ART = new Set(["final", "client", "approved", "scheduled", "live"]);
const PAST_ART_CASES = new Set(["final_copy", "client_copy"]);
const PAST_CLIENT = new Set(["approved", "scheduled", "live"]);
const SCHEDULED = new Set(["scheduled", "live"]);
const UNPLANNED = new Set(["planned", "drafting"]);

const statusOf = (p: DemoStepPost): string => (p.pipelineStatus === "blocked" ? p.blockedFrom ?? "blocked" : p.pipelineStatus);
function meets(rule: Exclude<Rule, "report_delivered">, p: DemoStepPost): boolean {
  const st = statusOf(p);
  const cc = st === "changes" ? p.changeCase : null;
  switch (rule) {
    case "plan_laid_out": return !UNPLANNED.has(st);
    case "copy_locked": return PAST_COPY.has(st) || (cc !== null && PAST_COPY_CASES.has(cc));
    case "artwork_done": return PAST_ART.has(st) || (cc !== null && PAST_ART_CASES.has(cc)) || (st === "proofread" && p.changedOnly);
    case "client_approved": return PAST_CLIENT.has(st);
    case "all_scheduled": return SCHEDULED.has(st);
  }
}

/** The step's own condition over the cycle's counted posts: done, and the share of posts meeting it (0 to 99 until done). */
function figures(rule: Rule, posts: readonly DemoStepPost[], target: number | null, delivered: boolean): { done: boolean; progress: number } {
  if (rule === "report_delivered") return delivered ? { done: true, progress: 100 } : { done: false, progress: 0 };
  const counted = posts.filter((p) => !p.isExtra && p.format !== "story");
  const meeting = counted.filter((p) => meets(rule, p)).length;
  const all = counted.length > 0 && meeting === counted.length;
  const goal = target !== null && target > 0 ? target : null;
  const targetMet = goal === null ? counted.length >= 1 : counted.length >= goal;
  const done = rule === "copy_locked" || rule === "artwork_done" ? all : all && targetMet;
  if (done) return { done: true, progress: 100 };
  return { done: false, progress: counted.length > 0 ? Math.min(99, Math.round((meeting / counted.length) * 100)) : 0 };
}

// ── the one step closed by hand ────────────────────────────────────────────────────────────────────────────────────────────
const HAND = Symbol.for("gaiada.demoSocial.cycleStepsHand");
type HandMarks = Map<string, { step: string; sig: string } | null>;
const hand = (): HandMarks => {
  const g = globalThis as unknown as Record<symbol, HandMarks | undefined>;
  return (g[HAND] ??= new Map());
};
/** The cycle's counted posts as a stage action leaves them: a change of any post's status is a recompute. */
const sigOf = (posts: readonly DemoStepPost[]): string =>
  posts.filter((p) => !p.isExtra && p.format !== "story").map((p) => `${p.id}:${statusOf(p)}:${p.changeCase ?? ""}`).sort().join("|");

/** Test seam: forget the hand-closed marks (a test that wants a fresh seed). */
export function resetDemoStepMarks(): void { hand().clear(); }

export function demoCycleSteps(i: DemoStepInput): DemoStepRow[] {
  const posts = i.posts.filter((p) => !p.archivedAt);
  const marks = hand();
  const sig = sigOf(posts);
  if (!marks.has(i.cycleId)) marks.set(i.cycleId, i.handSeed ? { step: i.handSeed, sig } : null);
  const mark = marks.get(i.cycleId) ?? null;
  // The next recompute after the hand close: any change of a post's status reopens it (when its condition does not hold, which is what the seed picks).
  const handClosed = mark && mark.sig === sig ? mark.step : null;
  if (mark && mark.sig !== sig) marks.set(i.cycleId, null);

  const last = (k: string): number => (i.estimates[k] ?? 0);
  return STEPS.map((s): DemoStepRow => {
    const f = figures(s.rule, posts, i.target, i.reportDelivered);
    const done = f.done || handClosed === s.key;
    let dueDate: string | null;
    if (s.key === "report") {
      const prev = monthPlus(i.month, -1);
      dueDate = i.reportDueDay === null ? null : `${prev}-${String(Math.min(i.reportDueDay, lastDayOf(prev))).padStart(2, "0")}`;
    } else {
      const lead = (s.from ?? []).reduce((n, k) => n + last(k), 0);
      dueDate = lead > 0 ? i.walkBack(i.readyBy, lead) : i.readyBy;
    }
    return {
      step: s.key, title: s.title(i.month), taskId: `demo-step-${i.cycleId}-${s.key}`, dueDate, done, progress: done ? 100 : f.progress,
      autoClose: "auto", holder: done ? null : { role: "officer", label: "The officer" }, late: !done && dueDate !== null && dueDate < i.today,
    };
  });
}
