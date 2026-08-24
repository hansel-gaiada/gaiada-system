// THE GENERAL TRACK — the mandatory course every employee passes, seeded as real content.
//
// Design: docs/blueprints/lms-foundation.md §4. Owner ask, 2026-08-24: "we should have a general
// category too that all employee have to pass. something like ERP usage training. claude usage
// training. something basic and fundamental."
//
// Three courses, one ordered path, marked mandatory so the assignment runner enrols every active
// employee without anybody remembering to. Zero sandbox — this is the wave with the widest reach
// and the least execution risk, which is why it ships before any lab exists.
//
// ── NOT A ROW OF PERSONAL DATA ────────────────────────────────────────────────────────────────
// Course content only. No enrolments, no progress, no scores — this seed publishes material and
// stops. Enrolment is `lms:assign-mandatory`, a separate deliberate act, for the same reason
// `seed:hr-config` seeds policy and not people: material is company configuration, and an
// enrolment is a claim about a person.
//
// ⚠ THE LMS WALL IS A THIRD GUC. Every lms_* table composes
//   `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('lms')`. A `withTenants([t], fn)`
//   without `{ modules: ["lms"] }` writes ZERO rows and reports success. Every call below passes it,
//   and the verification at the bottom goes through withTenants for the same reason — the
//   `set_config(..., true)` inside `withGlobal` that produced a confidently wrong survey of
//   production on 2026-08-23 is a no-op, because withGlobal opens no transaction.
//
// ⚠ AND THE ANSWER KEY. Quiz answers live in `lms_activities.spec`, and `GET /courses/:id` used to
//   return that column verbatim to any `member`. That is fixed (spec-redaction.ts) — but it means
//   this file is the first place answers are ever written, so if the redaction regresses, these
//   rows are what leaks. `lms-spec-redaction.test.ts` is the guard.
//
// ── IDEMPOTENT, AND IT WILL NOT REWRITE PUBLISHED MATERIAL ────────────────────────────────────
// Keyed on `course_key` / `path_key`. A course that already exists is left ALONE — not updated,
// not re-versioned. Somebody may have edited it, and somebody else may be mid-way through it; a
// seed that silently rewrites published training is the exact failure the version discipline in
// 202608241322 exists to prevent.
import { withTenants, withGlobal, closePool, newId } from "../db";

const AGENCY_NAME = "Gaia Digital Agency";

type Kind = "read" | "watch" | "quiz" | "scenario";
type Grading = "auto" | "review" | "none";

interface ActivitySpec {
  kind: Kind;
  title: string;
  spec: Record<string, unknown>;
  isRequired?: boolean;
  passThreshold?: number;
  grading?: Grading;
  maxAttempts?: number;
  minutes?: number;
}
interface ModuleSpec { title: string; summary: string; activities: ActivitySpec[] }
interface CourseSpec {
  key: string; title: string; summary: string; level: "foundation"; minutes: number;
  modules: ModuleSpec[];
}

/**
 * A multiple-choice question.
 *
 * `answer` is the graded key — `lms-learn.controller.ts` compares `JSON.stringify(submitted) ===
 * JSON.stringify(answer)`, so the value here must match what the UI submits exactly. Option INDEX
 * rather than option text: an author fixing a typo in an option would otherwise silently invalidate
 * every correct answer already recorded against it.
 */
const q = (id: string, prompt: string, options: string[], answer: number, explanation: string) =>
  ({ id, prompt, options, answer, explanation });

const COURSES: CourseSpec[] = [
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
    key: "general-erp-usage",
    title: "Using the ERP",
    summary:
      "The surfaces every employee touches, whichever department you are in: your own hub, filing " +
      "leave, logging time, the approvals inbox, and what a department console is actually for.",
    level: "foundation",
    minutes: 90,
    modules: [
      {
        title: "Finding your way around",
        summary: "The shell, the company switcher, and where your own things live.",
        activities: [
          {
            kind: "read", grading: "none", isRequired: true, minutes: 15,
            title: "The shell, the sidebar and the company switcher",
            spec: {
              body:
                "The left rail groups everything into sections. **Me** is first and is never gated — " +
                "your leave, your loans, your payslips, your inbox and your learning. **Workspace** is " +
                "the shared surface. **Departments** opens each department's own console.\n\n" +
                "The company selector at the top of the rail is not cosmetic. Nearly every page reads " +
                "data for the ACTIVE company only, so a list that looks empty is often a list for the " +
                "wrong company. If something you expect is missing, check the selector before " +
                "reporting it.\n\n" +
                "You will not see every section. Access follows your position, not your seniority, and " +
                "a section you cannot open is hidden rather than shown broken.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 15,
            title: "What a department console is for",
            spec: {
              body:
                "Each department has a console with its own tools — Web Dev has delivery pipelines, " +
                "SEO has properties and engagements, Creative has the studio. Opening another " +
                "department's console is not a permission error; you can look, and mostly you will " +
                "not be able to act.\n\n" +
                "This matters because work crosses departments constantly. Reading the other side's " +
                "console is usually faster and more accurate than asking, and it is deliberately open " +
                "for exactly that reason.",
            },
          },
        ],
      },
      {
        title: "Doing your own admin",
        summary: "Leave, time, approvals and pay — the four you will use every month.",
        activities: [
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "Filing leave, and reading your balance honestly",
            spec: {
              body:
                "Leave is filed from **Me → Leave**. Your balance is DERIVED from an accrual ledger, " +
                "not stored as a number somebody edits — which is why it can change when a policy " +
                "changes, and why the ledger is the answer to 'why is my balance that'.\n\n" +
                "Two Indonesian specifics worth knowing: statutory annual leave (UU 13/2003 art. 79) " +
                "accrues after twelve months of service, and *cuti bersama* — collective leave around " +
                "national holidays — is NOT worked but DOES deduct from your entitlement. It appears " +
                "as a deduction you did not file, and that is correct rather than a bug.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 15,
            title: "The approvals inbox: approve, reject, or send back",
            spec: {
              body:
                "An approval is a decision with a consequence attached. Approving does not merely " +
                "record agreement — for most request types it EXECUTES the thing. Read what you are " +
                "approving before you approve it.\n\n" +
                "Sending something back is not a rejection and does not count against anybody. It is " +
                "the correct action whenever the request is plausible but you cannot verify it from " +
                "what is in front of you.",
            },
          },
          {
            kind: "quiz", grading: "auto", isRequired: true, passThreshold: 80, maxAttempts: 3, minutes: 15,
            title: "ERP basics check",
            spec: {
              instructions: "Five questions. You need 80% to pass, and you have three attempts.",
              questions: [
                q("erp-1",
                  "A list you expect to have rows in it is empty. What is the first thing to check?",
                  [
                    "Report it as a bug straight away",
                    "The company selector at the top of the sidebar",
                    "Whether the server is down",
                    "Clear your browser cache",
                  ], 1,
                  "Nearly every page reads the ACTIVE company only. The wrong company is by far the most common cause of an empty list."),
                q("erp-2",
                  "Where do you file a leave request?",
                  ["The HR department console", "Me → Leave", "By emailing your manager", "Me → Inbox"], 1,
                  "Me → Leave is your own surface. The HR console is the administrator's view of everybody's."),
                q("erp-3",
                  "Your leave balance changed and you did not file anything. What is the most likely explanation?",
                  [
                    "A bug — balances never change on their own",
                    "Somebody edited your balance directly",
                    "Cuti bersama was applied, or an accrual policy changed",
                    "Your manager rejected a request",
                  ], 2,
                  "Balances are derived from an accrual ledger. Cuti bersama is not worked but does deduct entitlement."),
                q("erp-4",
                  "You are asked to approve a request you cannot verify from the information shown. What should you do?",
                  [
                    "Approve it — the requester is responsible for accuracy",
                    "Reject it, which is the safe default",
                    "Send it back and ask for what is missing",
                    "Leave it in the inbox until somebody asks",
                  ], 2,
                  "Sending back is not a rejection and counts against nobody. Approving mostly EXECUTES the thing, so approving something you cannot verify is the one option with a consequence."),
                q("erp-5",
                  "You can open another department's console but cannot act in it. Is that a problem?",
                  [
                    "Yes — report it to IT",
                    "No — reading across departments is deliberately open",
                    "Yes — you should not be able to see it at all",
                    "Only if you are a manager",
                  ], 1,
                  "Work crosses departments constantly. Reading the other side's console is faster and more accurate than asking, so it is open by design."),
              ],
            },
          },
        ],
      },
    ],
  },
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
    key: "general-claude-usage",
    title: "Working with Claude",
    summary:
      "What the assistant can reach, what it must never be given, when a write needs a human, and " +
      "why an agent's answer is a claim rather than a fact.",
    level: "foundation",
    minutes: 100,
    modules: [
      {
        title: "What the assistant is, and is not",
        summary: "Reach, limits, and the one habit that separates useful from dangerous.",
        activities: [
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "An answer is a claim, not a fact",
            spec: {
              body:
                "The assistant can read a great deal of the ERP and will answer confidently about all " +
                "of it. Confidence is not evidence. It is generated from the same process whether the " +
                "underlying data was found, mis-read, or absent.\n\n" +
                "The habit that matters: for anything you will act on, ask WHERE it came from and " +
                "check that one source. Not every claim — the one that would cost something if wrong.\n\n" +
                "This is not a limitation to be worked around; it is the same standard you would apply " +
                "to a colleague's verbal summary of a document you have not read.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "What never goes into a prompt",
            spec: {
              body:
                "Never paste: national identity numbers (NIK), full payment card numbers, passwords or " +
                "API keys, a client's credentials, or anything a client gave us under an NDA that " +
                "names them.\n\n" +
                "The rule is not 'the model might memorise it' — it is that a prompt travels to a " +
                "provider, is logged along the way, and stops being ours the moment it leaves. Once " +
                "sent, it cannot be recalled, even if the conversation is deleted afterwards.\n\n" +
                "If you need the assistant's help with a document that contains any of the above, " +
                "remove those fields first. The rest of the document is almost always the part you " +
                "actually needed help with.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "When a write needs a human",
            spec: {
              body:
                "The assistant may propose a write — assign a task, file a request, update a record — " +
                "but a proposal is not an action. It goes into an approval, and a person decides.\n\n" +
                "That is deliberate and it will not be streamlined away for convenience. The failure " +
                "mode it prevents is specific: an agent that is 95% right and acts autonomously " +
                "produces a steady trickle of wrong actions nobody reviewed, each individually " +
                "plausible.\n\n" +
                "When you approve an agent's proposal, you are the person who decided. Read it.",
            },
          },
        ],
      },
      {
        title: "Check",
        summary: "",
        activities: [
          {
            kind: "quiz", grading: "auto", isRequired: true, passThreshold: 80, maxAttempts: 3, minutes: 20,
            title: "Claude usage check",
            spec: {
              instructions: "Five questions. 80% to pass, three attempts.",
              questions: [
                q("cl-1",
                  "The assistant tells you a client's invoice is unpaid. You are about to email the client. What first?",
                  [
                    "Send the email — the assistant reads the real data",
                    "Open the invoice and confirm it",
                    "Ask the assistant whether it is sure",
                    "Ask a colleague if it sounds right",
                  ], 1,
                  "Check the ONE source that would cost something if wrong. Asking the assistant to confirm itself adds confidence, not evidence."),
                q("cl-2",
                  "Which of these is safe to paste into a prompt?",
                  [
                    "A client's NIK so it can fill a form",
                    "An API key so it can test an integration",
                    "A draft blog post the client has already published",
                    "A colleague's password so it can reproduce a bug",
                  ], 2,
                  "Already-published material is already public. The other three leave our control the moment they are sent and cannot be recalled."),
                q("cl-3",
                  "Why must a prompt not contain confidential data, at root?",
                  [
                    "The model might memorise it and repeat it",
                    "It travels to a provider, is logged, and cannot be recalled",
                    "It makes answers less accurate",
                    "It uses more tokens",
                  ], 1,
                  "Memorisation is a side issue. The decisive fact is that the data has left our control and deletion afterwards does not undo that."),
                q("cl-4",
                  "An agent proposes a write. What happens next?",
                  [
                    "It executes and notifies you",
                    "It executes unless you object within an hour",
                    "It becomes an approval and a person decides",
                    "It is discarded — agents cannot write",
                  ], 2,
                  "Proposals become approvals. Approving is deciding, which is why you are expected to read it."),
                q("cl-5",
                  "You approve an agent's proposal without reading it and it turns out to be wrong. Who decided?",
                  ["The agent", "You", "Nobody — it was automated", "Whoever configured the agent"], 1,
                  "The approval exists precisely so a person decides. Approving without reading does not move the decision elsewhere."),
              ],
            },
          },
        ],
      },
    ],
  },
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
    key: "general-fundamentals",
    title: "Fundamentals: security, data and the client line",
    summary:
      "Security basics that actually get used, how we handle personal data, and where the " +
      "client-confidentiality line sits.",
    level: "foundation",
    minutes: 110,
    modules: [
      {
        title: "Security you will actually use",
        summary: "The handful of habits that stop the attacks that reach an agency.",
        activities: [
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "Phishing, and why it works on careful people",
            spec: {
              body:
                "The messages that succeed are not the badly-spelled ones. They arrive in a real " +
                "thread, reference a real project, and ask for something ordinary — 'approve this', " +
                "'the bank details changed', 'sign in to see the file'.\n\n" +
                "Two checks defeat almost all of it. First: did the ASK change? A payment detail " +
                "changing mid-project is the single highest-value signal there is. Second: verify " +
                "through a channel you already had, never one the message gave you.\n\n" +
                "Reporting something that turns out to be genuine costs nothing and is expected.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "Credentials, and the shared-account problem",
            spec: {
              body:
                "Every client system we touch gets its own credential in the connections vault, never " +
                "a shared login passed around in chat. The reason is not tidiness: a shared account " +
                "means no action can be attributed to a person, so an incident cannot be investigated " +
                "and access cannot be removed when somebody leaves.\n\n" +
                "If you are handed a shared login, that is a thing to fix rather than a thing to use " +
                "carefully.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 20,
            title: "Personal data: what it is here, and what we do with it",
            spec: {
              body:
                "Personal data is anything that identifies a person — a name with a phone number, a " +
                "NIK, a payslip, a performance note, a health reason attached to a leave request.\n\n" +
                "Three rules cover nearly every case. Collect the minimum the task needs. Keep it " +
                "inside the system rather than copying it into a spreadsheet or a chat message. And " +
                "when somebody asks for a copy of what we hold about them, that is a request with a " +
                "process, not a favour to be improvised.\n\n" +
                "A failed assessment score is personal data too, and more sensitive than a passing " +
                "one. That is why this system reports training compliance as counts rather than as a " +
                "list of everybody's scores.",
            },
          },
          {
            kind: "read", grading: "none", isRequired: true, minutes: 15,
            title: "The client-confidentiality line",
            spec: {
              body:
                "Work we do for one client is not material for another, and this is sharper than it " +
                "sounds because the useful thing is usually the specific thing: their conversion " +
                "numbers, their upcoming campaign, the reason they left their last agency.\n\n" +
                "You may reuse what you LEARNED. You may not reuse what they TOLD you. In practice " +
                "the test is whether you could say it in front of them without embarrassment.\n\n" +
                "Same line inside the company: a client's data belongs to the people working on that " +
                "client, not to everybody who can technically reach it.",
            },
          },
        ],
      },
      {
        title: "Check",
        summary: "",
        activities: [
          {
            kind: "quiz", grading: "auto", isRequired: true, passThreshold: 80, maxAttempts: 3, minutes: 20,
            title: "Fundamentals check",
            spec: {
              instructions: "Six questions. 80% to pass, three attempts.",
              questions: [
                q("fu-1",
                  "A supplier emails mid-project saying their bank details have changed. What is the strongest signal here?",
                  [
                    "The email arrived outside office hours",
                    "The payment detail changed mid-project",
                    "There is an attachment",
                    "The wording is unusually formal",
                  ], 1,
                  "A payment detail changing mid-project is the highest-value signal there is; the successful messages otherwise look entirely ordinary."),
                q("fu-2",
                  "How should you verify it?",
                  [
                    "Reply to the email and ask",
                    "Call the number in the email signature",
                    "Contact them through a channel you already had",
                    "Check whether the domain looks right",
                  ], 2,
                  "Verify through a channel you already had. Every channel the message supplies is controlled by whoever sent it."),
                q("fu-3",
                  "Why is a shared client login a problem even if everybody using it is trustworthy?",
                  [
                    "It is against the client's terms",
                    "Actions cannot be attributed and access cannot be removed",
                    "It is slower to use",
                    "Passwords get forgotten",
                  ], 1,
                  "Attribution and revocation. Without them an incident cannot be investigated and a leaver keeps access."),
                q("fu-4",
                  "Which of these is NOT personal data?",
                  [
                    "A payslip",
                    "A leave request mentioning a health reason",
                    "A published client case study with no names",
                    "A failed assessment score",
                  ], 2,
                  "Published, unnamed material identifies nobody. A failed score very much is personal data — and more sensitive than a pass."),
                q("fu-5",
                  "You learned a technique while working on Client A. May you use it for Client B?",
                  [
                    "No — everything from a client engagement is confidential",
                    "Yes — you may reuse what you learned, not what they told you",
                    "Only with Client A's written permission",
                    "Only after the engagement ends",
                  ], 1,
                  "Skill you acquired travels with you. Their specific information does not."),
                q("fu-6",
                  "Why does training compliance report counts rather than a list of everybody's scores?",
                  [
                    "The list would be too long",
                    "Scores are inaccurate",
                    "A failed score is personal data and more sensitive than a pass",
                    "Managers asked for a summary",
                  ], 2,
                  "The compliance question is 'are we covered'. Answering it does not require spreading everybody's failures across a dashboard."),
              ],
            },
          },
        ],
      },
    ],
  },
];

const PATH = {
  key: "general-induction",
  title: "Everyone: the fundamentals",
  summary:
    "ERP usage, working with Claude, and the security and data basics. Required of every employee, " +
    "whatever department and whatever level.",
  dueDays: 30,
  certificationValidMonths: 24,
  certificationLabel: "Gaiada Fundamentals",
  // Order matters: you cannot sensibly be taught what not to paste into a prompt before you know
  // what the system holds. `requires_previous` is TRUE throughout — "difficulties in order".
  courseKeys: ["general-erp-usage", "general-claude-usage", "general-fundamentals"],
};

export interface GeneralTrackResult {
  tenantId: string;
  courses: { created: string[]; existing: string[] };
  activities: number;
  path: { created: boolean; published: boolean; courses: number };
}

export async function seedGeneralTrack(companyName = AGENCY_NAME): Promise<GeneralTrackResult> {
  const company = await withGlobal((c) =>
    c.query<{ id: string; enabled_modules: string[] }>(
      `SELECT id, enabled_modules FROM companies WHERE name = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [companyName],
    ),
  );
  const tenantId = company.rows[0]?.id;
  if (!tenantId) throw new Error(`company not found: ${companyName}`);
  // Refuse EARLY and loudly. Without `lms` enabled, every insert below passes the tenant check,
  // fails app_module_allowed, writes nothing, and reports success — the RLS zero-row trap, which
  // looks exactly like a seed that ran fine against an already-seeded estate.
  if (!company.rows[0].enabled_modules.includes("lms")) {
    throw new Error(
      `the 'lms' module is NOT enabled for ${companyName}. Every write would silently affect zero ` +
      `rows and this seed would report success. Enable it in Settings → Modules first.`,
    );
  }

  const created: string[] = [];
  const existing: string[] = [];
  let activityCount = 0;

  for (const course of COURSES) {
    const done = await withTenants(
      [tenantId],
      async (c) => {
        const found = await c.query<{ id: string }>(
          `SELECT id FROM lms_courses WHERE course_key = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
          [course.key],
        );
        // Leave an existing course ALONE. Somebody may have edited it and somebody else may be
        // mid-way through it; rewriting published training under a learner is the exact failure
        // the version discipline exists to prevent.
        if (found.rows[0]) return { created: false, activities: 0 };

        const courseId = newId();
        await c.query(
          `INSERT INTO lms_courses (id, tenant_id, course_key, version, title, summary, track,
                                    unit_node_id, discipline, level, status, estimated_minutes,
                                    published_at, origin_site)
           VALUES ($1,$2,$3,1,$4,$5,'general',NULL,NULL,$6,'published',$7,now(),'central')`,
          [courseId, tenantId, course.key, course.title, course.summary, course.level, course.minutes],
        );

        let n = 0;
        for (const [mi, mod] of course.modules.entries()) {
          const moduleId = newId();
          await c.query(
            `INSERT INTO lms_modules (id, tenant_id, course_id, sort_order, title, summary)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [moduleId, tenantId, courseId, mi + 1, mod.title, mod.summary || null],
          );
          for (const [ai, act] of mod.activities.entries()) {
            await c.query(
              `INSERT INTO lms_activities (id, tenant_id, module_id, sort_order, kind, title, spec,
                                           is_required, pass_threshold, grading, max_attempts,
                                           estimated_minutes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [newId(), tenantId, moduleId, ai + 1, act.kind, act.title, JSON.stringify(act.spec),
               act.isRequired ?? true, act.passThreshold ?? null, act.grading ?? "auto",
               act.maxAttempts ?? null, act.minutes ?? null],
            );
            n += 1;
          }
        }
        return { created: true, activities: n };
      },
      { modules: ["lms"] },
    );
    if (done.created) created.push(course.key); else existing.push(course.key);
    activityCount += done.activities;
  }

  const path = await withTenants(
    [tenantId],
    async (c) => {
      const found = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM lms_paths WHERE path_key = $1 AND deleted_at IS NULL`,
        [PATH.key],
      );
      if (found.rows[0]) {
        const n = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM lms_path_courses WHERE path_id = $1`, [found.rows[0].id],
        );
        return { created: false, published: found.rows[0].status === "published", courses: Number(n.rows[0].n) };
      }
      const pathId = newId();
      await c.query(
        `INSERT INTO lms_paths (id, tenant_id, path_key, title, summary, track, unit_node_id,
                                discipline, level, status, is_mandatory, applies_to, due_days,
                                certification_valid_months, certification_label, published_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,'general',NULL,NULL,'foundation','published',true,'all',$6,$7,$8,now(),'central')`,
        [pathId, tenantId, PATH.key, PATH.title, PATH.summary, PATH.dueDays,
         PATH.certificationValidMonths, PATH.certificationLabel],
      );
      for (const [i, key] of PATH.courseKeys.entries()) {
        await c.query(
          `INSERT INTO lms_path_courses (id, tenant_id, path_id, course_key, position, requires_previous, is_optional)
           VALUES ($1,$2,$3,$4,$5,true,false)`,
          [newId(), tenantId, pathId, key, i + 1],
        );
      }
      return { created: true, published: true, courses: PATH.courseKeys.length };
    },
    { modules: ["lms"] },
  );

  return { tenantId, courses: { created, existing }, activities: activityCount, path };
}

/** Counted through withTenants, never withGlobal — see the header. */
export async function verifyGeneralTrack(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const out: Record<string, number> = {};
      for (const table of ["lms_courses", "lms_modules", "lms_activities", "lms_paths", "lms_path_courses"]) {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        out[table] = Number(r.rows[0].n);
      }
      const quizzes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities WHERE kind = 'quiz'`,
      );
      out.quizzes = Number(quizzes.rows[0].n);
      return out;
    },
    { modules: ["lms"] },
  );
}

if (require.main === module) {
  seedGeneralTrack()
    .then(async (r) => {
      console.log("[seed:lms-general-track] tenant", r.tenantId);
      console.log("  courses    ", `created=[${r.courses.created}] existing=[${r.courses.existing}]`);
      console.log("  activities ", r.activities, "written");
      console.log("  path       ", r.path.created ? "created + published" : `existing (published=${r.path.published})`,
                  `· ${r.path.courses} course(s)`);
      const counts = await verifyGeneralTrack(r.tenantId);
      console.log("[seed:lms-general-track] verified through withTenants:", JSON.stringify(counts));
      if (counts.lms_courses === 0 || counts.lms_paths === 0) {
        throw new Error(
          "[seed:lms-general-track] verification read ZERO rows — the lms module scope was not open. " +
          "Nothing was written.",
        );
      }
      console.log(
        "\nNOBODY IS ENROLLED YET. Publishing a mandatory path does not assign it — run " +
        "`npm run lms:assign-mandatory` to enrol active employees. That is a separate, deliberate " +
        "act because an enrolment is a claim about a person, not company configuration.",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:lms-general-track] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
