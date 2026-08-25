// THE HR AND IT CURRICULUM — two FUNCTIONAL departments, foundation through lead.
//
// Modelled directly on `lms-webdev-curriculum.ts`: same helpers, same idempotency, same module-gate
// refusal, same shape of verification. Read that file's header first if this one is unclear.
//
// ── HR AND IT ARE NOT IN THE ROSTER'S DEPARTMENT SPINE, AND THAT IS NOT A BUG ─────────────────
// `seed/roster.ts`'s `AGENCY_DEPTS` enumerates the AGENCY departments (Web Dev, SEO/SEM, SMM,
// Creative, ...) — the org-chart divisions that exist because Gaia Digital Agency sells that work.
// HR and IT are FUNCTIONAL departments: every company in the holding gets one, they are not part of
// any single agency's division tree, and `platform-ui/src/components/shell/nav.ts` lists them as
// always-present rows precisely because they sit outside that spine. If a later audit greps
// `AGENCY_DEPTS` for "hr" or "it" and finds nothing, that absence is the design, not a missed seed —
// this curriculum still anchors both to real org-blob node ids (`d-hr`, `d-it`) so the LMS unit
// scoping works the same way it does for every agency department.
//
// ── NO `lab` ACTIVITIES ARE AUTHORED HERE ─────────────────────────────────────────────────────
// Same reason as the Web Dev file: a `lab` is graded by a runner that does not exist yet. A required
// activity nothing can ever pass makes its whole path permanently uncompletable. Quizzes and
// `scenario` only, until a lab runner exists to attach to these course keys.
//
// ── GRADING IS MIXED ───────────────────────────────────────────────────────────────────────────
// Statutory and technical facts are `auto` — there is a right answer and the answer key is public
// knowledge that does not change per company. A performance conversation, a leave dispute, and the
// standardise-vs-choose call are `scenario` / `review` — grading a judgement call automatically
// teaches people to satisfy the grader instead of making the call.
//
// ── STATUTORY ACCURACY ─────────────────────────────────────────────────────────────────────────
// Every statutory claim here is either (a) a stable, well-documented rule of Indonesian labour law
// (UU 13/2003 art. 79's 12-day/12-month leave entitlement; THR's one-month-wage-at-full-tenure and
// pre-holiday payment deadline; the existence and purpose of BPJS Kesehatan and BPJS Ketenagakerjaan;
// the PP 58/2023 TER mechanism as a withholding SHORTCUT reconciled at year end) or is deliberately
// taught as a PRINCIPLE with the actual number left to the ratified parameter set. Nowhere does this
// file invent a percentage, a rupiah figure, or a contribution rate — a wrong statutory figure taught
// to twenty people is worse than no course, per the ticket's own hard rule.
//
// ⚠ THE LMS WALL IS A THIRD GUC. Without `{ modules: ["lms"] }` every insert below writes ZERO rows
//   and reports success — the seed refuses loudly instead, see `seedHrItCurriculum` below.
//
// Idempotent: this will NOT rewrite an existing course.
import { withTenants, withGlobal, closePool, newId } from "../db";

const AGENCY_NAME = "Gaia Digital Agency";
/** Functional-department node ids — NOT in roster.ts's AGENCY_DEPTS. See header. */
const UNIT_HR = "d-hr";
const UNIT_IT = "d-it";

type Kind = "read" | "quiz" | "scenario";
type Grading = "auto" | "review" | "none";
type Level = "foundation" | "practitioner" | "advanced" | "lead";

interface Act {
  kind: Kind; title: string; spec: Record<string, unknown>;
  grading?: Grading; passThreshold?: number; maxAttempts?: number; minutes?: number; optional?: boolean;
}
interface Mod { title: string; summary?: string; activities: Act[] }
interface CourseSpec {
  key: string; title: string; summary: string; discipline: string; level: Level;
  unit: string; minutes: number; modules: Mod[];
}
interface PathSpec {
  key: string; title: string; summary: string; discipline: string; level: Level;
  unit: string; courses: string[]; certification?: string; validMonths?: number;
}

/** Prose. `read` activities are participation — the quiz is what is graded. */
const read = (title: string, body: string, minutes = 20): Act =>
  ({ kind: "read", title, spec: { body }, grading: "none", minutes });

/**
 * A question. `answer` is the graded key and the grader compares it with
 * `JSON.stringify(submitted) === JSON.stringify(answer)`, so it is the option INDEX.
 */
const q = (id: string, prompt: string, options: string[], answer: number, explanation: string) =>
  ({ id, prompt, options, answer, explanation });

const quiz = (title: string, questions: ReturnType<typeof q>[], minutes = 15): Act =>
  ({ kind: "quiz", title, spec: { questions }, grading: "auto", passThreshold: 75, maxAttempts: 3, minutes });

/** A judged exercise. Reviewed by a person — see the header on mixed grading. */
const scenario = (title: string, brief: string, rubric: string[], minutes = 45): Act =>
  ({ kind: "scenario", title, spec: { brief, rubric }, grading: "review", minutes });

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HR
// ══════════════════════════════════════════════════════════════════════════════════════════════
const COURSES: CourseSpec[] = [
  {
    key: "hr-foundations", title: "HR foundations", discipline: "HR", level: "foundation",
    unit: UNIT_HR, minutes: 140,
    summary: "The statutory frame this platform actually models: leave, collective leave, and social security.",
    modules: [
      {
        title: "Leave, and the calendar that eats into it",
        activities: [
          read("Annual leave under UU 13/2003, article 79",
            "Indonesian labour law sets a floor, not a company policy: article 79 of UU 13/2003 " +
            "entitles a worker to at least 12 working days of paid annual leave once they have " +
            "completed 12 consecutive months of continuous service with the same employer. Before " +
            "that anniversary, the entitlement has not yet accrued — a new hire in month six does not " +
            "have half of it available, they have none yet, because the law's trigger is the full " +
            "12-month mark, not a monthly accrual rate.\n\nThis platform models the ENTITLEMENT as a " +
            "statutory floor a company's own policy can sit on top of but never below. If HR ever " +
            "needs the exact figure a company should be running on — whether that floor, an enhanced " +
            "policy number, or a sector-specific variant — the number lives in the company's ratified " +
            "statutory parameter set, not in this reading. Teaching the number here and letting it " +
            "drift from what finance and counsel actually signed off on is exactly the failure mode " +
            "this course exists to prevent."),
          read("Cuti bersama: not worked, but it DOES come out of the balance",
            "The government declares cuti bersama — collective or 'joint' leave — around major " +
            "religious and national holidays, typically Idul Fitri and the year-end period. The day is " +
            "not a working day, in the same sense a public holiday is not a working day: nobody is " +
            "expected to be at their desk.\n\nThe detail that catches people who have not worked in " +
            "Indonesian HR before: cuti bersama is, by long-standing joint-decree practice, DEDUCTED " +
            "from an employee's annual leave entitlement rather than granted on top of it. So a company " +
            "that announces five days of cuti bersama across a year has not given five bonus days off " +
            "— it has spent five of the twelve statutory days on the employee's behalf, before that " +
            "employee has taken a single day of leave themselves. An HR system that shows an employee's " +
            "remaining balance without reflecting cuti bersama deductions will overstate what they " +
            "actually have left, and the gap only surfaces when someone tries to book a trip and " +
            "discovers seven days, not twelve."),
          read("BPJS: two programmes, two different purposes",
            "BPJS Kesehatan is Indonesia's mandatory national health insurance scheme — every worker is " +
            "meant to be enrolled, and it covers medical care, not income replacement. BPJS " +
            "Ketenagakerjaan is a separate, employment-focused social security body covering several " +
            "distinct programmes: old-age savings (JHT), a pension scheme (JP), workplace accident " +
            "cover (JKK), a death benefit (JKM), and a job-loss guarantee (JKP) added more recently. " +
            "They are administered separately, contributed to separately, and claimed separately — " +
            "conflating 'BPJS' as one thing is the single most common HR misunderstanding of the " +
            "system.\n\nThis course does not teach contribution percentages or premium splits between " +
            "employer and employee, because those figures move with regulation and belong in the " +
            "ratified parameter set, verified against the current rule, not memorised from a training " +
            "module that will eventually be a version behind."),
          quiz("HR foundations — check", [
            q("hrf-1", "A new hire joins in January. In August of the same year, how much annual leave has accrued under article 79?",
              ["8 of 12 days, pro-rated", "None yet — the entitlement triggers at 12 months of continuous service",
               "12 days, granted on day one", "6 days, granted at the halfway point"], 1,
              "Article 79 is a threshold at 12 continuous months, not a monthly accrual rate. Before the anniversary, none of it has accrued."),
            q("hrf-2", "The company declares 4 days of cuti bersama this year. What happens to the annual leave balance?",
              ["Nothing — cuti bersama is separate from annual leave", "It goes up by 4 days",
               "It goes down by 4 days", "It is unaffected until the employee opts in"], 2,
              "Cuti bersama is not worked, but it IS deducted from the statutory annual leave entitlement — it is spent leave, not bonus leave."),
            q("hrf-3", "An employee asks what their exact annual leave entitlement is this year, beyond the statutory floor. Where does that number live?",
              ["In this training", "In the company's ratified statutory parameter set", "In the offer letter only",
               "It is the same for every company by law"], 1,
              "The floor is statutory; the company's actual running figure — if enhanced — is a ratified, finance/counsel-signed parameter, not a training figure."),
            q("hrf-4", "BPJS Kesehatan and BPJS Ketenagakerjaan are:",
              ["The same programme under two names", "Health insurance and employment social security — separate programmes",
               "Two names for pension only", "Optional for companies under 50 staff"], 1,
              "Kesehatan is medical cover; Ketenagakerjaan bundles JHT, JP, JKK, JKM and JKP — distinct, separately administered programmes."),
            q("hrf-5", "Why does this course avoid stating BPJS contribution percentages?",
              ["They are confidential", "They move with regulation and belong in the ratified parameter set, not a training module",
               "They do not exist", "They are the same for every employee"], 1,
              "A rate that changes with regulation and is memorised from a training module will eventually be wrong — verify against the current, ratified figure instead."),
          ], 20),
        ],
      },
    ],
  },
  {
    key: "hr-practitioner", title: "HR in practice", discipline: "HR", level: "practitioner",
    unit: UNIT_HR, minutes: 200,
    summary: "The personal data HR holds, a leave dispute, and an offboarding that leaves no access behind.",
    modules: [
      {
        title: "What HR holds, and what it owes the person it is about",
        activities: [
          read("Personal data is not just 'the file'",
            "HR sits on the richest personal-data surface in the company: national ID numbers, bank " +
            "details, medical information behind leave and insurance claims, family and dependent data, " +
            "salary history, disciplinary records, and — for anyone who has ever raised a grievance — a " +
            "written account of a dispute. None of that is incidental. Each item exists because a " +
            "specific process needed it, and the discipline is to hold it for that process and nothing " +
            "wider.\n\nThe practical rule: access to an HR record should be explainable in one sentence " +
            "— 'payroll needs the bank account to pay this person' — and any access that cannot be " +
            "explained that plainly is over-broad. The same applies to how long a record is kept: a " +
            "disciplinary note from a role someone left four years ago is not a live business need, it " +
            "is a liability sitting in a database. And the same care applies to who is TOLD something, " +
            "not only who can query it — a medical reason behind a leave request is not a fact the rest " +
            "of a team needs in order to cover the work; 'on approved leave' is the whole sentence " +
            "anyone else is owed."),
          quiz("Personal data — check", [
            q("hrp-1", "What is the test for whether someone should have access to a given HR record?",
              ["Seniority", "Whether the access is needed by a specific process, statable in one sentence",
               "Whether they asked nicely", "Department headcount"], 1,
              "'Payroll needs the bank account to pay this person' is the shape of a justified access. Anything vaguer is over-broad."),
            q("hrp-2", "A teammate asks why a colleague is out this week. What should they be told?",
              ["The medical reason, so they understand", "That the person is on approved leave — nothing more",
               "Nothing at all, not even that they are away", "The exact return date and diagnosis"], 1,
              "The rest of the team needs to know coverage is arranged, not the medical reason behind it."),
            q("hrp-3", "A disciplinary note is four years old and the role it relates to no longer exists. What does keeping it represent?",
              ["A useful audit trail with no cost", "A live business need", "A liability with no current justification",
               "A legal requirement in every case"], 2,
              "Retention needs its own justification — 'we might need it someday' is not a live need, it is exposure sitting in a database."),
            q("hrp-4", "Which of these is the correct HR data discipline?",
              ["Broad access, narrow retention", "Narrow access, and retention justified by an active process",
               "Broad access, broad retention, for completeness", "Access tied to seniority, not to process"], 1,
              "Both dimensions matter: who can see it should map to a real need, and how long it is kept should map to a live process, not habit."),
          ]),
        ],
      },
      {
        title: "When it goes wrong: disputes and exits",
        activities: [
          scenario("A leave and attendance dispute",
            "An employee's leave balance shows 3 days remaining. They insist they have not taken any " +
            "leave this year and should have close to the full statutory entitlement. Attendance " +
            "records show two unexplained absences that were logged as 'cuti bersama' by a manager who " +
            "has since left the company, and the employee says they worked those days from home during " +
            "a client emergency and were never told those days would be treated as leave. Write, in " +
            "300–500 words: how you would investigate before concluding anything, what you would say to " +
            "the employee while that investigation is open, and how you would resolve it if the records " +
            "turn out to be wrong.",
            ["Investigates before asserting either side is correct — does not defend the system by default",
             "Distinguishes what is verifiable (attendance logs, correspondence) from what is only assertion",
             "Names what is said to the employee WHILE the investigation is open, not only the resolution",
             "If the record is wrong, states how the balance is corrected and who is told, not just that it 'will be fixed'"],
            50),
          read("Offboarding is an access problem HR starts",
            "The moment HR knows someone's last day, that date becomes the trigger for a chain of " +
            "actions well outside HR's own systems: email, VPN, building access, shared drives, any " +
            "system the person's role touched. HR does not execute most of that removal — but HR is " +
            "the party that knows the date first, and a leaver whose last-day notice arrives at IT the " +
            "morning after they have already left is a leaver whose access sat open for however long " +
            "the gap was.\n\nThe practical discipline: the offboarding notice goes out the moment the " +
            "date is confirmed, not on the last day itself, and it names a hard cutover time, not just a " +
            "date — 'end of business, Friday the 14th' is actionable; 'sometime next week' is not. Final " +
            "pay, exit paperwork and any handover are HR's part of this; the account and access " +
            "deactivation is a downstream dependency HR triggers but does not own executing."),
          quiz("Offboarding — check", [
            q("hro-1", "Who typically confirms an employee's last day first, before most systems know?",
              ["IT", "Facilities", "HR", "The employee's own team, informally"], 2,
              "HR is usually the first party to know the confirmed date, which is why HR's notice is the trigger for the access chain, not an afterthought to it."),
            q("hro-2", "What is wrong with an offboarding notice that says 'leaving sometime next week'?",
              ["Nothing, it gives IT time", "It names no hard cutover, so access removal has no clear deadline to hit",
               "It is too formal", "It should go to the employee, not IT"], 1,
              "A vague date is not actionable. 'End of business, Friday the 14th' is; 'sometime next week' leaves the window undefined."),
            q("hro-3", "Whose job is it to actually deactivate the leaver's accounts and access?",
              ["HR's — they hold the personal data", "A downstream dependency HR triggers but does not execute",
               "Nobody's, it is automatic", "The employee's manager"], 1,
              "HR starts the chain with the confirmed date; the technical deactivation itself belongs to whoever owns those systems."),
            q("hro-4", "An offboarding notice arrives at IT the morning after the person has already left. What is the risk?",
              ["None, it is close enough", "Access sat open for the gap between departure and notice",
               "Only a paperwork delay", "The person cannot be paid"], 1,
              "That gap is exactly the window an unrevoked account or badge stays live and unaccounted for."),
          ]),
        ],
      },
    ],
  },
  {
    key: "hr-lead-track", title: "Leading HR", discipline: "HR", level: "lead",
    unit: UNIT_HR, minutes: 220,
    summary: "A performance conversation, and why a statutory parameter set stays unratified until it is signed off.",
    modules: [
      {
        title: "The judgement calls",
        activities: [
          read("A performance conversation is evidence, not a verdict",
            "The instinct in a difficult performance conversation is to arrive with a conclusion and " +
            "defend it. The better shape is to arrive with specific, dated instances — what was " +
            "expected, what happened instead, on what date, with what impact — and let the conversation " +
            "test whether the picture is complete, not announce that it already is.\n\nThis matters " +
            "for two reasons that are easy to blur together: the conversation should genuinely leave " +
            "room to be wrong about a fact (was the person actually briefed on that expectation?), and " +
            "separately, whatever is agreed needs to be written down immediately afterward, in the " +
            "person's own hearing if possible, because a performance record that exists only in one " +
            "manager's memory is worth nothing in a dispute six months later and is unfair to the " +
            "employee in the meantime — they cannot address what was never actually put to them in a " +
            "form either side can point back to."),
          scenario("A performance conversation you have to have",
            "A team member has missed the same kind of deadline three times in two months, each time " +
            "with a plausible-sounding individual reason. Their manager has mentioned it informally twice " +
            "but nothing is written down, and the employee does not appear to think there is a pattern. " +
            "Write, in 400–600 words, how you would prepare for and open this conversation: what " +
            "evidence you would bring, how you would test whether the employee sees what you see, and " +
            "what you would commit to writing afterward and to whom.",
            ["Brings specific, dated instances rather than a general impression",
             "Genuinely tests the employee's account rather than treating the conversation as a formality",
             "States what gets written down afterward and who receives it",
             "Distinguishes a pattern from three unrelated one-off excuses, and says how"],
            60),
          read("Why a statutory parameter set stays unratified",
            "A number like a leave entitlement, a contribution rate, or a tax withholding parameter " +
            "looks like a fact you could just type in. It is not, in this system, until finance and " +
            "counsel have both signed off on it — because the number carries consequences the HR " +
            "system itself cannot see: a payroll liability, a tax filing exposure, a labour-law " +
            "compliance question that depends on facts outside HR's remit. An unratified parameter set " +
            "is not an oversight to chase down before launch; it is a deliberate gate that stops a " +
            "plausible-looking number from becoming policy before the two functions that actually carry " +
            "the risk have looked at it.\n\nAs a lead, the failure mode to avoid is treating 'we already " +
            "modelled it in the system' as equivalent to 'it is approved'. A modelled, unratified " +
            "parameter is a draft with a UI, and shipping against a draft is how a wrong figure reaches " +
            "twenty payslips before anyone with the authority to catch it has seen it."),
          quiz("Statutory governance — check", [
            q("hrl-1", "A statutory parameter is modelled in the system but not yet ratified by finance and counsel. What is it?",
              ["Approved policy, ready to use", "A draft with a UI, not yet policy", "A legal requirement regardless",
               "Irrelevant until audit"], 1,
              "Being modelled in the system is not the same as being signed off — the gate exists because the number carries risk outside HR's own visibility."),
            q("hrl-2", "Why does ratification require BOTH finance and counsel, not just HR?",
              ["Tradition", "The number carries payroll and compliance consequences neither HR alone can fully see",
               "It is faster with two approvers", "Counsel must approve all HR content"], 1,
              "A leave, tax or contribution figure has a payroll liability side and a legal-compliance side — neither is HR's to clear alone."),
            q("hrl-3", "In a performance conversation, what should a lead bring rather than a pre-formed verdict?",
              ["A list of consequences", "Specific, dated instances the conversation can test",
               "A written warning to sign on the spot", "A comparison to other team members"], 1,
              "The conversation should be able to genuinely change the picture, which requires arriving with facts to test, not a conclusion to defend."),
            q("hrl-4", "Why does a performance conversation need to be written down immediately afterward?",
              ["For legal cover only", "A record that exists only in one manager's memory is worthless later and unfair to the employee meanwhile",
               "HR policy requires all conversations logged", "So HR can track manager performance"], 1,
              "Both sides need something to point back to — memory alone protects neither the employee nor the record of what was actually agreed."),
          ]),
        ],
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // IT
  // ══════════════════════════════════════════════════════════════════════════════════════════
  {
    key: "it-foundations", title: "IT foundations", discipline: "IT", level: "foundation",
    unit: UNIT_IT, minutes: 150,
    summary: "Devices, the office network, and the difference between proving who you are and proving what you may do.",
    modules: [
      {
        title: "Devices, network, and identity",
        activities: [
          read("An unreturned laptop is an access problem before it is an asset problem",
            "The instinct when a laptop does not come back is to chase it as a depreciation line — a " +
            "missing asset with a book value. That framing misses what actually matters first: that " +
            "laptop is very likely still signed into email, VPN, shared drives and whatever else its " +
            "last user had open, and every day it is unaccounted for is a day those sessions may still " +
            "be live.\n\nThe correct order of response is: revoke access first — kill the sessions, " +
            "rotate anything the device could have cached, force a re-authentication everywhere it " +
            "matters — and THEN chase the physical hardware. Treating it the other way round means the " +
            "thing that can actually hurt the company (live, unattended access) sits unaddressed while " +
            "someone fills in an asset-register form."),
          read("The office network: a fixed range, and a controller that manages it",
            "The office network runs on the 10.10.0.0/22 range, managed through a UniFi controller — " +
            "which means the access points, switches and the addressing scheme are centrally " +
            "configured rather than each device being set up by hand at the wall jack. A /22 gives a " +
            "meaningfully larger address pool than the /24 many smaller offices run on, which matters " +
            "once you account for staff devices, guest devices, and anything IoT-shaped (printers, " +
            "cameras, smart TVs in meeting rooms) all drawing from the same pool.\n\nKnowing the range " +
            "and that it is UniFi-managed matters operationally: a device that cannot get an address, a " +
            "segment that needs isolating, or a guest network that needs separating from the staff VLAN " +
            "are all controller-level questions, not per-device ones — the fix lives in one place, not " +
            "scattered across every access point."),
          read("Authentication answers 'who'; authorization answers 'what'",
            "These get used almost interchangeably in casual conversation and they are not the same " +
            "question. Authentication is proving identity — a password, an MFA prompt, a badge tap. " +
            "Authorization is a separate decision, made AFTER identity is established, about what that " +
            "now-verified identity is allowed to do or see.\n\nThe practical trap: a system that logs " +
            "someone in successfully has answered only the first question. 'They logged in fine' says " +
            "nothing about whether they should be able to open a given file, approve a given payment, " +
            "or see a given record — and an incident that starts with 'but their login worked' is almost " +
            "always actually an authorization failure wearing an authentication story."),
          quiz("IT foundations — check", [
            q("itf-1", "A laptop is not returned by a departed contractor. What is the correct FIRST action?",
              ["File an asset-register report", "Revoke access and force re-authentication everywhere that device touched",
               "Wait for the contractor to respond", "Mark it as a write-off"], 1,
              "Live, unattended access is the thing that can actually hurt the company. The asset paperwork can wait; the sessions cannot."),
            q("itf-2", "The office network runs on which range, and how is it managed?",
              ["10.0.0.0/8, unmanaged", "10.10.0.0/22, via a UniFi controller", "192.168.1.0/24, per access point",
               "It varies by floor with no central controller"], 1,
              "10.10.0.0/22, centrally managed through UniFi — configuration questions live at the controller, not at each device."),
            q("itf-3", "Why does a /22 matter compared to a /24 for an office network?",
              ["It is faster", "It gives a meaningfully larger address pool across staff, guest and IoT devices",
               "It is more secure by default", "It requires no controller"], 1,
              "More devices — staff, guest, printers, cameras, meeting-room hardware — all draw from the same pool; a /24 runs out faster."),
            q("itf-4", "Someone logs in successfully but should not be able to approve a given payment. What kind of failure is that, if they can?",
              ["An authentication failure", "An authorization failure", "A network failure", "Not a failure at all"], 1,
              "Logging in answers 'who'. Whether they should be able to approve that payment is a separate, authorization question."),
            q("itf-5", "What is the trap in the phrase 'but their login worked'?",
              ["Logins should never work", "It answers authentication and is silent on authorization — the actual incident is usually there",
               "It means MFA was skipped", "It is only relevant to VPN access"], 1,
              "An incident framed around 'the login worked' is almost always an authorization failure wearing an authentication story."),
          ], 20),
        ],
      },
    ],
  },
  {
    key: "it-practitioner", title: "IT in practice", discipline: "IT", level: "practitioner",
    unit: UNIT_IT, minutes: 210,
    summary: "Joiner/mover/leaver as an access story, and backups nobody has ever tried to restore.",
    modules: [
      {
        title: "Access changes with the person, not just the role",
        activities: [
          read("Joiner, mover, leaver — the same problem at three points",
            "A joiner needs access granted to match a new role. A mover needs access to change shape — " +
            "some of it added, but just as importantly some of it REMOVED, because a person who moves " +
            "from Finance to Web Dev should not quietly keep Finance's access on the way through. A " +
            "leaver needs access removed entirely. All three are the same underlying event — a change " +
            "in what a person should be able to reach — and treating them as three unrelated tickets is " +
            "how the middle one, the mover, gets forgotten: granting the new access is visible and gets " +
            "done; removing the old access is invisible until someone audits it and finds a person with " +
            "two departments' worth of standing access because nobody closed the loop.\n\nThe leaver " +
            "case is the one that actually bites, because unlike a mover's stale access — which is " +
            "merely too broad — a leaver's UNREMOVED access is access held by someone who is no longer " +
            "an employee at all. That is the access-review finding that is hardest to explain after the " +
            "fact: not 'we scoped it too generously' but 'this account should not have existed since the " +
            "date they left'."),
          scenario("The leaver case that bites",
            "An employee's last day was three weeks ago. During a routine access review you find their " +
            "account is still active — VPN, email, and one shared drive — because the offboarding " +
            "ticket was raised but never actually closed out, and nobody checked. Write, in 300–500 " +
            "words: what you do in the next hour, what you do in the next week to find out how this " +
            "happened, and what you would change so a raised-but-not-closed offboarding ticket cannot " +
            "sit open for three weeks unnoticed again.",
            ["Immediate containment (revoke) is separated clearly from the later investigation",
             "Asks how the ticket sat open for three weeks, not just that it did",
             "Proposes a structural fix (e.g. a review cadence, an alert on stale open tickets) rather than 'be more careful'",
             "Names who needs to know this happened, beyond the person who fixed it"],
            50),
          read("A backup that has never been restored is a hope, not a backup",
            "A nightly backup job reporting success proves exactly one thing: a file was written " +
            "somewhere. It proves nothing about whether that file can actually be turned back into a " +
            "working database or filesystem — the write could be truncated, the format could have " +
            "silently drifted from what the restore tooling expects, the encryption key needed to read " +
            "it back could be the one thing nobody kept a copy of.\n\nThe only way to know a backup " +
            "works is to have actually restored from it, on a schedule, before an incident forces the " +
            "question. A backup that has never once been restored is, functionally, an unverified claim " +
            "sitting where a safety net is supposed to be — and the gap between 'the job reported green' " +
            "and 'the data came back' is discovered at the single worst possible moment: the moment it " +
            "is actually needed."),
          quiz("IT practice — check", [
            q("itp-1", "A person moves from Finance to Web Dev. What is the most commonly missed step?",
              ["Granting Web Dev access", "Removing Finance access on the way through", "Updating their email signature",
               "Notifying their new manager"], 1,
              "Granting new access is visible and gets done. Removing the old access is invisible until an audit finds it — that is the mover trap."),
            q("itp-2", "Why is the leaver case worse than the mover case?",
              ["It happens more often", "The access is held by someone who is no longer an employee at all, not merely over-scoped",
               "It is harder to detect technically", "It only affects email"], 1,
              "A mover's stale access is too broad; a leaver's unremoved access is held by someone with no employment relationship at all."),
            q("itp-3", "A nightly backup job reports success every night for a year. What has been proven?",
              ["The data can be restored", "A file was written somewhere", "The database is healthy",
               "The encryption keys are safe"], 1,
              "Restorability is a separate, unproven claim until an actual restore has been performed."),
            q("itp-4", "What is the only way to know a backup actually works?",
              ["Check the job's success log", "Check the file size grew", "Actually restore from it, on a schedule",
               "Confirm the storage has free space"], 2,
              "Anything short of an actual restore is trusting the write, not verifying the read."),
          ]),
        ],
      },
    ],
  },
  {
    key: "it-lead-track", title: "Leading IT", discipline: "IT", level: "lead",
    unit: UNIT_IT, minutes: 180,
    summary: "Deciding what to standardise across the estate, and what to leave to individual choice.",
    modules: [
      {
        title: "The judgement call",
        activities: [
          read("Standardise the surfaces that carry risk; leave the rest to preference",
            "Every standardisation decision trades a person's convenience against something the whole " +
            "estate has to carry — a support burden, a security surface, an audit obligation. The useful " +
            "test is not 'would a standard be tidier' — a standard is almost always tidier — it is " +
            "whether the thing in question is a SHARED risk surface or a PERSONAL preference with no " +
            "external consequence.\n\nA device's OS patch baseline, its disk encryption, and which " +
            "identity provider it authenticates against are shared risk: one unpatched device is an " +
            "entry point for everyone else on the network, so standardising there is not control for " +
            "its own sake. Which text editor someone writes code in, how they arrange their desktop, or " +
            "which browser they prefer for reading documentation is personal preference with no blast " +
            "radius beyond that person's own productivity — mandating a standard there spends political " +
            "capital and goodwill to buy nothing the estate actually needed. The lead's job is telling " +
            "those two categories apart correctly, not defaulting to either 'standardise everything' or " +
            "'let people choose everything'."),
          scenario("Where do you draw the line",
            "A department lead wants their team to be exempt from the standard endpoint-management " +
            "agent because 'it slows down our machines and we're careful'. Separately, a different team " +
            "wants to keep using a personal cloud-storage account instead of the company's sanctioned " +
            "one because it is what they already know. Write, in 400–600 words: how you would decide " +
            "each request, using the shared-risk-versus-personal-preference test, and what you would say " +
            "to each team if the answer is no.",
            ["Applies the shared-risk-versus-preference test explicitly to BOTH requests, not just one",
             "Reaches different conclusions if the requests are actually different in kind, and says why",
             "States what is said to the team when the answer is no, not only the decision itself",
             "Does not simply defer to whichever team pushed harder"],
            60),
          quiz("Standardise or choose — check", [
            q("itl-1", "What is the correct test for whether to standardise something across the estate?",
              ["Whether a standard would look tidier", "Whether it is a shared risk surface or a personal preference with no external consequence",
               "Whether most people already prefer one option", "Whether it is easy to enforce"], 1,
              "Tidiness is almost always true of a standard. The real question is whether the variance carries a risk the whole estate has to absorb."),
            q("itl-2", "A device's patch baseline is inconsistent across the team. Is that a shared-risk question?",
              ["No, it is personal preference", "Yes — one unpatched device is an entry point for everyone else on the network",
               "Only if it is a server", "Only during an active incident"], 1,
              "An unpatched endpoint's risk is not contained to its owner; it is a shared attack surface."),
            q("itl-3", "Which of these is closer to a personal-preference call than a standardisation call?",
              ["Which identity provider a device authenticates against", "Disk encryption status",
               "Which code editor someone prefers", "OS patch baseline"], 2,
              "An editor choice has no blast radius beyond that person's own productivity — the other three are shared risk surfaces."),
            q("itl-4", "A team asks to be exempted from a security-relevant standard because they are 'careful'. What is the risk in granting it?",
              ["None, if they really are careful", "The exemption becomes a precedent, and the risk was never actually personal to them",
               "It slows down other teams", "It requires new hardware"], 1,
              "The endpoint-agent example is exactly this: the risk an unmanaged device carries lands on the network, not only on the team that asked."),
          ]),
        ],
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The paths. Order is enforced (`requires_previous`) within each functional department's track.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PATHS: PathSpec[] = [
  {
    key: "hr-practitioner-path", title: "HR — foundation to practitioner", discipline: "HR",
    level: "practitioner", unit: UNIT_HR,
    summary: "The statutory frame this platform models, then personal data, disputes and offboarding.",
    courses: ["hr-foundations", "hr-practitioner"],
    certification: "HR Practitioner", validMonths: 24,
  },
  {
    key: "hr-lead-path", title: "HR — leading the department", discipline: "HR",
    level: "lead", unit: UNIT_HR,
    summary: "The management tier: a performance conversation, and why a statutory parameter set stays unratified.",
    courses: ["hr-lead-track"],
  },
  {
    key: "it-practitioner-path", title: "IT — foundation to practitioner", discipline: "IT",
    level: "practitioner", unit: UNIT_IT,
    summary: "Devices, network and identity, then joiner/mover/leaver and backups nobody has restored.",
    courses: ["it-foundations", "it-practitioner"],
    certification: "IT Practitioner", validMonths: 24,
  },
  {
    key: "it-lead-path", title: "IT — leading the department", discipline: "IT",
    level: "lead", unit: UNIT_IT,
    summary: "The management tier: deciding what to standardise across the estate and what to let people choose.",
    courses: ["it-lead-track"],
  },
];

export interface HrItCurriculumResult {
  tenantId: string;
  courses: { created: string[]; existing: string[] };
  activities: number;
  paths: { created: string[]; existing: string[] };
}

export async function seedHrItCurriculum(companyName = AGENCY_NAME): Promise<HrItCurriculumResult> {
  const company = await withGlobal((c) =>
    c.query<{ id: string; enabled_modules: string[] }>(
      `SELECT id, enabled_modules FROM companies WHERE name = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [companyName],
    ),
  );
  const tenantId = company.rows[0]?.id;
  if (!tenantId) throw new Error(`company not found: ${companyName}`);
  // Refuse EARLY. Without `lms`, every insert passes the tenant check, fails app_module_allowed,
  // writes nothing, and reports success — which looks exactly like an already-seeded estate.
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
          `SELECT id FROM lms_courses WHERE course_key = $1 AND deleted_at IS NULL LIMIT 1`, [course.key],
        );
        if (found.rows[0]) return { created: false, activities: 0 };

        const courseId = newId();
        await c.query(
          `INSERT INTO lms_courses (id, tenant_id, course_key, version, title, summary, track,
                                    unit_node_id, discipline, level, status, estimated_minutes,
                                    published_at, origin_site)
           VALUES ($1,$2,$3,1,$4,$5,'department',$6,$7,$8,'published',$9,now(),'central')`,
          [courseId, tenantId, course.key, course.title, course.summary, course.unit, course.discipline,
           course.level, course.minutes],
        );
        let n = 0;
        for (const [mi, mod] of course.modules.entries()) {
          const moduleId = newId();
          await c.query(
            `INSERT INTO lms_modules (id, tenant_id, course_id, sort_order, title, summary)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [moduleId, tenantId, courseId, (mi + 1) * 10, mod.title, mod.summary ?? null],
          );
          for (const [ai, act] of mod.activities.entries()) {
            await c.query(
              `INSERT INTO lms_activities (id, tenant_id, module_id, sort_order, kind, title, spec,
                                           is_required, pass_threshold, grading, max_attempts,
                                           estimated_minutes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [newId(), tenantId, moduleId, (ai + 1) * 10, act.kind, act.title, JSON.stringify(act.spec),
               !act.optional, act.passThreshold ?? null, act.grading ?? "auto",
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

  const pathsCreated: string[] = [];
  const pathsExisting: string[] = [];
  for (const path of PATHS) {
    const done = await withTenants(
      [tenantId],
      async (c) => {
        const found = await c.query<{ id: string }>(
          `SELECT id FROM lms_paths WHERE path_key = $1 AND deleted_at IS NULL`, [path.key],
        );
        if (found.rows[0]) return false;
        const pathId = newId();
        await c.query(
          `INSERT INTO lms_paths (id, tenant_id, path_key, title, summary, track, unit_node_id,
                                  discipline, level, status, is_mandatory, applies_to, due_days,
                                  certification_valid_months, certification_label, published_at, origin_site)
           VALUES ($1,$2,$3,$4,$5,'department',$6,$7,$8,'published',false,'unit',NULL,$9,$10,now(),'central')`,
          [pathId, tenantId, path.key, path.title, path.summary, path.unit, path.discipline, path.level,
           path.validMonths ?? null, path.certification ?? null],
        );
        // `requires_previous` TRUE throughout — the order is enforced, not suggested.
        for (const [i, key] of path.courses.entries()) {
          await c.query(
            `INSERT INTO lms_path_courses (id, tenant_id, path_id, course_key, position, requires_previous, is_optional)
             VALUES ($1,$2,$3,$4,$5,true,false)`,
            [newId(), tenantId, pathId, key, i + 1],
          );
        }
        return true;
      },
      { modules: ["lms"] },
    );
    if (done) pathsCreated.push(path.key); else pathsExisting.push(path.key);
  }

  return {
    tenantId, courses: { created, existing }, activities: activityCount,
    paths: { created: pathsCreated, existing: pathsExisting },
  };
}

/** Counted through withTenants, never withGlobal — see the header. Covers BOTH unit node ids. */
export async function verifyHrItCurriculum(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const out: Record<string, number> = {};
      const courses = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_courses WHERE unit_node_id IN ($1,$2)`, [UNIT_HR, UNIT_IT],
      );
      const paths = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_paths WHERE unit_node_id IN ($1,$2)`, [UNIT_HR, UNIT_IT],
      );
      const disciplines = await c.query<{ n: string }>(
        `SELECT count(DISTINCT discipline)::text AS n FROM lms_courses WHERE unit_node_id IN ($1,$2)`, [UNIT_HR, UNIT_IT],
      );
      const quizzes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'quiz'`, [UNIT_HR, UNIT_IT],
      );
      // Expected to be zero until the lab runner exists — see header.
      const labs = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'lab'`, [UNIT_HR, UNIT_IT],
      );
      out.courses = Number(courses.rows[0].n);
      out.paths = Number(paths.rows[0].n);
      out.disciplines = Number(disciplines.rows[0].n);
      out.quizzes = Number(quizzes.rows[0].n);
      out.labs = Number(labs.rows[0].n);
      return out;
    },
    { modules: ["lms"] },
  );
}

if (require.main === module) {
  seedHrItCurriculum()
    .then(async (r) => {
      console.log("[seed:lms-hr-it-curriculum] tenant", r.tenantId);
      console.log(`  courses    created=${r.courses.created.length} existing=${r.courses.existing.length}`);
      console.log(`  activities ${r.activities} written`);
      console.log(`  paths      created=${r.paths.created.length} existing=${r.paths.existing.length}`);
      const counts = await verifyHrItCurriculum(r.tenantId);
      console.log("[seed:lms-hr-it-curriculum] verified through withTenants:", JSON.stringify(counts));
      if (counts.courses === 0 || counts.paths === 0) {
        throw new Error(
          "[seed:lms-hr-it-curriculum] verification read ZERO rows — the lms module scope was not " +
          "open. Nothing was written.",
        );
      }
      if (counts.labs > 0) {
        throw new Error(
          `[seed:lms-hr-it-curriculum] ${counts.labs} lab activity(ies) exist. The lab RUNNER does ` +
          `not exist yet, so a required lab makes its whole path permanently uncompletable.`,
        );
      }
      console.log(
        "\nNOBODY IS ENROLLED. These are department paths, not mandatory ones — each head assigns " +
        "them. Theory and quizzes only: hands-on labs attach to these same course keys once a lab " +
        "runner exists.",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:lms-hr-it-curriculum] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
