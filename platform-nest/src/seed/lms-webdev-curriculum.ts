// THE WEB DEV CURRICULUM — six disciplines, ordered, foundation through lead (L4).
//
// Design: docs/blueprints/lms-foundation.md §3 and §7. Owner ask, 2026-08-24: "for webdev we want
// to have FE, BE, UI/UX, DevOps, Cyber Security, QA... make it like a challenge and steps so
// difficulties are in order... all of these in webdev should have teory and real practice."
//
// ── WHAT THIS WAVE DELIVERS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────
// STRUCTURE and THEORY: 8 paths, 14 courses, readings and graded quizzes, ordered so a path cannot
// be taken out of sequence. That is L4.
//
// **NO `lab` ACTIVITIES ARE AUTHORED HERE, and that is a correctness requirement rather than a
// scoping preference.** A `lab` is graded by a runner that does not exist until L5. An activity
// marked `is_required` that nothing can ever pass makes its whole path permanently uncompletable —
// so seeding labs now would ship fourteen paths nobody could finish, and the symptom would read as
// "the training is too hard" rather than as a missing service. L5 adds labs to these same courses;
// the course keys here are the anchors it attaches to.
//
// ── THE ORDER IS THE POINT ────────────────────────────────────────────────────────────────────
// Every path sets `requires_previous`, so "steps so difficulties are in order" is enforced rather
// than suggested. Everyone in the department takes `webdev-foundations` first: the delivery rail,
// the ball, and how work is evidenced here are prerequisites for every discipline, and teaching
// them six times inside six paths is how they drift.
//
// ── GRADING IS MIXED BY DISCIPLINE, per the owner decision ────────────────────────────────────
// FE/BE/DevOps/Cyber/QA quizzes are `auto` — there is a right answer. UI/UX and the lead track are
// `review`: an auto-gradeable proxy for "is this good design" or "was that the right call with a
// client" mostly is not one, and grading them automatically teaches people to satisfy the grader.
//
// ⚠ THE LMS WALL IS A THIRD GUC. Without `{ modules: ["lms"] }` every insert below writes ZERO rows
//   and reports success. Every call passes it, and the verification reads back through withTenants
//   for the same reason.
//
// ⚠ ANSWER KEYS LIVE IN `spec`. `GET /courses/:id` redacts them for anyone who is not authoring the
//   course (spec-redaction.ts). This file is where they are written; if that redaction regresses,
//   these rows are what leaks.
//
// Idempotent, and it will NOT rewrite an existing course — somebody may have edited it and somebody
// else may be mid-way through it.
import { withTenants, withGlobal, closePool, newId } from "../db";

const AGENCY_NAME = "Gaia Digital Agency";
/** The Web Dev department's org-blob node id (`seed/roster.ts` AGENCY_DEPTS). */
const UNIT = "d-webdev";

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
  minutes: number; modules: Mod[];
}
interface PathSpec {
  key: string; title: string; summary: string; discipline: string; level: Level;
  courses: string[]; certification?: string; validMonths?: number;
}

/** Prose. `read` activities are participation — the quiz is what is graded. */
const read = (title: string, body: string, minutes = 20): Act =>
  ({ kind: "read", title, spec: { body }, grading: "none", minutes });

/**
 * A question. `answer` is the graded key and the grader compares it with
 * `JSON.stringify(submitted) === JSON.stringify(answer)`, so it is the option INDEX: an author
 * fixing a typo in an option must not silently invalidate every correct answer already recorded.
 */
const q = (id: string, prompt: string, options: string[], answer: number, explanation: string) =>
  ({ id, prompt, options, answer, explanation });

const quiz = (title: string, questions: ReturnType<typeof q>[], minutes = 15): Act =>
  ({ kind: "quiz", title, spec: { questions }, grading: "auto", passThreshold: 75, maxAttempts: 3, minutes });

/** A judged exercise. Reviewed by a person — see the header on mixed grading. */
const scenario = (title: string, brief: string, rubric: string[], minutes = 45): Act =>
  ({ kind: "scenario", title, spec: { brief, rubric }, grading: "review", minutes });

// ══════════════════════════════════════════════════════════════════════════════════════════════
// SHARED — everyone in Web Dev, before any discipline.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const COURSES: CourseSpec[] = [
  {
    key: "webdev-how-we-work", title: "How Web Dev works here", discipline: "Shared",
    level: "foundation", minutes: 90,
    summary: "The delivery rail, the ball, and what counts as evidence that something is done.",
    modules: [
      {
        title: "The delivery rail",
        summary: "Meeting → MOM → PRD → scope → build → review → ship. Where each artefact comes from.",
        activities: [
          read("From a client meeting to a scope",
            "Work here starts as a recorded conversation and becomes a written artefact before anybody " +
            "builds. The chain is meeting → minutes → PRD → scope, and each step exists because the " +
            "one before it is ambiguous.\n\nThe rule worth internalising: **if it is not in the scope, " +
            "it is not in the sprint.** Not because we are inflexible, but because an unscoped change " +
            "has no estimate, no acceptance criteria and nobody who agreed to it — so when it goes " +
            "wrong there is no version of events everybody shares."),
          read("The ball, and why it is never on two people",
            "Every piece of work has exactly ONE holder — the ball. Not an assignee list, not a team: " +
            "one person who owes the next move.\n\nThis is the mechanism that stops work stalling " +
            "invisibly. A task with three assignees is a task nobody is answerable for, and it will " +
            "sit for a week while each of them assumes another has it. When you finish your move, you " +
            "pass the ball explicitly. When you are blocked, the ball goes to whoever can unblock you " +
            "— being blocked is not a reason to keep holding it."),
          quiz("How we work — check", [
            q("hw-1", "A client asks for one small extra thing during a build. What is the correct move?",
              ["Add it — it is small", "Add it and mention it at the next standup",
               "Take it back to the scope; if it is not scoped it is not in the sprint",
               "Refuse it"], 2,
              "Not inflexibility: an unscoped change has no estimate, no acceptance criteria and nobody who agreed to it."),
            q("hw-2", "A task has three assignees. What is wrong with that?",
              ["Nothing", "It costs three seats", "Nobody is answerable, so it stalls invisibly",
               "The board renders badly"], 2,
              "One holder — the ball. Three assignees is a task each of them assumes another has."),
            q("hw-3", "You are blocked. What happens to the ball?",
              ["You keep it until you are unblocked", "It goes to whoever can unblock you",
               "It goes back to the PM automatically", "The task is closed"], 1,
              "Being blocked is not a reason to keep holding it — the ball goes where the next move actually is."),
            q("hw-4", "What is the PRD for?",
              ["A record for the client to sign", "Turning an ambiguous conversation into something buildable",
               "A legal document", "Estimating cost"], 1,
              "Each step in the chain exists because the one before it is ambiguous."),
          ]),
        ],
      },
      {
        title: "Evidence",
        summary: "Why a claim of 'done' has to point at something.",
        activities: [
          read("Done means demonstrable",
            "\"Done\" is not a status somebody sets; it is a claim that points at evidence — a merged " +
            "PR, a passing pipeline, a deployed URL, a screenshot of the thing working.\n\nThe reason " +
            "is not distrust. It is that the person who wrote the code is the worst-placed person to " +
            "judge whether it works, and \"it works on my machine\" is a statement about one machine. " +
            "Evidence converts a private belief into something a reviewer can check in thirty seconds."),
        ],
      },
    ],
  },
  {
    key: "webdev-toolchain", title: "The toolchain", discipline: "Shared",
    level: "foundation", minutes: 80,
    summary: "Git discipline, environments, and the difference between local, test and live.",
    modules: [
      {
        title: "Git, as a communication tool",
        activities: [
          read("Commits are messages to the next person",
            "A commit message explains WHY, because the diff already says what. \"fix bug\" costs the " +
            "next reader — often you, in four months — a bisect session to recover what you knew at " +
            "the time and did not write down.\n\nBranch off, keep it small, and rebase rather than " +
            "accumulate merge commits nobody can read. A pull request that changes forty files is not " +
            "reviewed; it is approved."),
          read("Local, test, live — and which one you are looking at",
            "Three environments, and the failure mode is always the same: somebody debugs against one " +
            "and concludes something about another.\n\nLocal is yours and proves nothing to anybody " +
            "else. Test is shared and is where an integration actually gets exercised. Live has real " +
            "clients on it, and the only safe assumption about live is that it differs from test in a " +
            "way you have not noticed yet. Before you say a bug is fixed, name which environment you " +
            "saw the fix in."),
          quiz("Toolchain — check", [
            q("tc-1", "What belongs in a commit message?",
              ["What changed", "Why it changed", "The ticket number only", "Nothing — the diff says it"], 1,
              "The diff already says what. Why is the part that cannot be recovered later."),
            q("tc-2", "Why is a forty-file pull request a problem?",
              ["It is slow to clone", "It is not reviewed, it is approved", "Git struggles with it",
               "It breaks the pipeline"], 1,
              "Past a certain size a reviewer cannot hold it in their head, and approval stops meaning review."),
            q("tc-3", "You fixed a bug locally. What may you claim?",
              ["It is fixed", "It is fixed in live", "It is fixed locally — name the environment",
               "Nothing until the client confirms"], 2,
              "The recurring failure is debugging against one environment and concluding something about another."),
            q("tc-4", "What is the only safe assumption about live?",
              ["It matches test", "It differs from test in a way you have not noticed yet",
               "It is slower", "It has more data"], 1,
              "Everything else about live is a guess until you have looked."),
          ]),
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════════════ FE ════
  {
    key: "webdev-fe-foundations", title: "Frontend foundations", discipline: "FE",
    level: "foundation", minutes: 150,
    summary: "The browser's model, the render boundary, and where state actually belongs.",
    modules: [
      {
        title: "What the browser is doing",
        activities: [
          read("The DOM, layout, and why your page is slow",
            "The browser parses HTML into a tree, computes styles, lays out boxes, paints, and " +
            "composites. Almost every performance problem you will meet is one of these being redone " +
            "more often than necessary.\n\nThe practical rule: reading a layout property (offsetWidth, " +
            "getBoundingClientRect) right after writing a style forces a synchronous layout. Do it in " +
            "a loop over fifty elements and you have written a jank machine — and the code looks " +
            "entirely reasonable."),
          read("Server and client are different places",
            "A component rendered on the server has no window, no localStorage and no event handlers. " +
            "A component rendered in the browser has all three and no access to your database.\n\n" +
            "The boundary is not a technicality; it is a security surface. Anything that reaches the " +
            "client is public, including the props you passed \"just for convenience\" and the API " +
            "key you meant to use only server-side. If you would not print it on the page, do not " +
            "send it to the client."),
          quiz("FE foundations — check", [
            q("fe-1", "You read offsetWidth immediately after setting a style, in a loop. What happens?",
              ["Nothing special", "A synchronous layout per iteration — jank", "A memory leak",
               "The style is ignored"], 1,
              "Read-after-write forces layout. In a loop over fifty elements it is a jank machine, and the code looks reasonable."),
            q("fe-2", "You pass an API key as a prop to a client component. What have you done?",
              ["Nothing — props are private", "Published the key", "Slowed the render", "Broken hydration"], 1,
              "Anything that reaches the client is public. The boundary is a security surface, not a technicality."),
            q("fe-3", "Which is NOT available during a server render?",
              ["Async data fetching", "window", "Composing child components", "Reading environment variables"], 1,
              "No window, no localStorage, no event handlers."),
            q("fe-4", "Where should state live, by default?",
              ["In a global store", "As high as it needs to be and no higher", "In the URL always",
               "In localStorage"], 1,
              "Lifting state further than necessary makes every consumer re-render and every change a wider blast radius."),
          ]),
        ],
      },
    ],
  },
  {
    key: "webdev-fe-practice", title: "Frontend in practice", discipline: "FE",
    level: "practitioner", minutes: 220,
    summary: "Accessibility, forms that actually work, and performance you can measure.",
    modules: [
      {
        title: "Accessible by construction",
        activities: [
          read("Semantics first, ARIA second",
            "A <button> is focusable, activates on Enter and Space, announces itself as a button and " +
            "works with a screen reader — for free. A <div onClick> does none of that, and the ARIA " +
            "you bolt on afterwards reimplements, badly, what the platform already gave you.\n\nThe " +
            "first rule of ARIA is not to use ARIA. Reach for it when there is genuinely no native " +
            "element for what you are building, which is rarer than it feels."),
          read("Colour is not a state",
            "A red border communicates nothing to somebody who cannot distinguish it, and nothing at " +
            "all to a screen reader. Every state you signal with colour needs a second channel: text, " +
            "an icon, aria-invalid, a role.\n\nThis is also why focus rings matter. Removing the focus " +
            "outline because it is ugly makes the page unusable by keyboard — and keyboard users " +
            "include everybody whose mouse just died, not only permanent screen-reader users."),
          quiz("FE practice — check", [
            q("fep-1", "Why prefer <button> over <div onClick>?",
              ["It is shorter", "Focus, keyboard activation and announcement come for free",
               "It styles better", "It is faster"], 1,
              "ARIA bolted on afterwards reimplements, badly, what the platform already provided."),
            q("fep-2", "You signal an invalid field with a red border. What is missing?",
              ["Nothing", "A second channel — text, icon or aria-invalid", "A tooltip", "A bolder red"], 1,
              "Colour alone reaches neither a colour-blind user nor a screen reader."),
            q("fep-3", "A designer asks you to remove focus outlines. What is the consequence?",
              ["Cleaner UI, no cost", "The page becomes unusable by keyboard",
               "Slower rendering", "Only screen-reader users are affected"], 1,
              "Keyboard users include everybody whose mouse just died, not only permanent AT users."),
            q("fep-4", "When is ARIA the right tool?",
              ["Always — it is best practice", "When there is genuinely no native element for it",
               "On every interactive element", "Never"], 1,
              "The first rule of ARIA is not to use ARIA."),
          ]),
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════════════ BE ════
  {
    key: "webdev-be-foundations", title: "Backend foundations", discipline: "BE",
    level: "foundation", minutes: 160,
    summary: "Requests, data models, and the failures that do not throw.",
    modules: [
      {
        title: "Data, and the lies it tells",
        activities: [
          read("A missing field reads exactly like a null",
            "An omitted column in a SELECT is indistinguishable from a NULL value in the row. This has " +
            "produced two wrong conclusions in this codebase alone — somebody read an empty field, " +
            "concluded the data was empty, and built on it.\n\nCheck the select list before " +
            "concluding \"the data is missing\". The same shape appears in APIs: a field absent from a " +
            "response and a field explicitly null mean different things, and a consumer that treats " +
            "them alike will eventually be confidently wrong."),
          read("An empty list is a claim",
            "Returning [] says \"there is nothing here\". That is an assertion about the world, and it " +
            "is often false — the query ran without the right scope, the filter was malformed, the " +
            "permission check quietly excluded everything.\n\nSo: when a read cannot be satisfied, " +
            "say so. Degrading a failure into an empty list produces a page that confidently tells " +
            "somebody they have no tasks, no training, no invoices — and nothing throws."),
          quiz("BE foundations — check", [
            q("be-1", "A column is absent from your SELECT. What does the consuming code see?",
              ["An error", "Exactly what a NULL value looks like", "An empty string", "undefined, distinctly"], 1,
              "Indistinguishable — and it has produced real wrong conclusions here."),
            q("be-2", "A read fails because the caller lacks permission. What should the endpoint return?",
              ["An empty list", "An empty list with a warning header", "A refusal that says so", "null"], 2,
              "Degrading a failure into [] produces a confident wrong answer with nothing thrown."),
            q("be-3", "Why is `[]` a claim rather than a neutral default?",
              ["It is not", "It asserts that nothing exists", "It is slower", "It breaks pagination"], 1,
              "And that assertion is frequently false — wrong scope, malformed filter, silent exclusion."),
            q("be-4", "A field is absent from an API response versus explicitly null. Same thing?",
              ["Yes", "No — they mean different things", "Only in JSON", "Only for numbers"], 1,
              "A consumer that treats them alike will eventually be confidently wrong."),
          ]),
        ],
      },
    ],
  },
  {
    key: "webdev-be-practice", title: "Backend in practice", discipline: "BE",
    level: "practitioner", minutes: 240,
    summary: "Transactions, idempotency, and writing an endpoint somebody else can call twice.",
    modules: [
      {
        title: "Writes that survive being retried",
        activities: [
          read("Every write will happen twice",
            "A client retried. A queue redelivered. Somebody double-clicked. Assume it, because the " +
            "network guarantees you nothing better: a response that never arrived is indistinguishable " +
            "from a request that never ran.\n\nSo make the second call harmless. A unique constraint " +
            "on the natural key, an idempotency key, ON CONFLICT DO NOTHING — the mechanism matters " +
            "less than the property. An endpoint that charges twice when called twice is a bug " +
            "regardless of whose retry caused it."),
          read("A transaction is a boundary, not a decoration",
            "Wrapping four statements in a transaction makes them one fact. Leaving one outside makes " +
            "a state that cannot be reasoned about: the row exists, its ledger entry does not, and " +
            "nothing failed.\n\nThe corollary that catches people: work done OUTSIDE the database is " +
            "not in the transaction. Sending an email, calling a vendor, writing a file — those " +
            "happen whether or not the transaction commits. Do them after, from the committed state."),
          quiz("BE practice — check", [
            q("bep-1", "Why assume every write happens twice?",
              ["Clients are buggy", "A response that never arrived is indistinguishable from a request that never ran",
               "Queues are unreliable", "It is a style preference"], 1,
              "The network guarantees nothing better, so the property has to live in your endpoint."),
            q("bep-2", "You send a confirmation email inside a transaction that later rolls back. What happened?",
              ["The email is rolled back too", "The email was sent; the data was not written",
               "Nothing was sent", "The transaction cannot roll back"], 1,
              "Work outside the database is not in the transaction. Do it after, from the committed state."),
            q("bep-3", "Which makes a second identical call harmless?",
              ["Rate limiting", "A unique constraint on the natural key", "A longer timeout", "Logging"], 1,
              "The mechanism matters less than the property, but rate limiting is not it."),
            q("bep-4", "Four related statements, one left outside the transaction. What is the risk?",
              ["Slower writes", "A state where the row exists and its ledger entry does not, with nothing failing",
               "A deadlock", "No risk"], 1,
              "That is the state nobody can reason about afterwards."),
          ]),
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════════════ UI/UX ════
  {
    key: "webdev-uiux-foundations", title: "UI/UX foundations", discipline: "UI/UX",
    level: "foundation", minutes: 150,
    summary: "Hierarchy, affordance, and designing the state where things go wrong.",
    modules: [
      {
        title: "The parts people skip",
        activities: [
          read("Design the empty, loading and error states first",
            "The happy path is the easy 20%. A screen is only finished when it says something useful " +
            "when there is no data, when data is arriving, and when the request failed.\n\nThe empty " +
            "state is the sharpest test. \"No results\" is not a design; it is an absence of one. Say " +
            "WHY it is empty, and what the person can do about it — because an empty screen and a " +
            "broken screen look identical to the person in front of it."),
          read("Hierarchy is subtraction",
            "Making something important usually means making other things less so. A page where four " +
            "elements are all bold, all coloured and all boxed has no hierarchy at all — it has four " +
            "elements shouting.\n\nThe practical move is to decide the ONE thing this screen is for, " +
            "give that the weight, and let everything else recede. If you cannot name the one thing, " +
            "the screen is doing too much and no amount of styling will rescue it."),
          // REVIEWED, not auto-graded — see the header. An auto-gradeable proxy for "is this good
          // design" mostly is not one, and grading it automatically teaches people to satisfy it.
          scenario("Critique a screen",
            "Take any screen in the ERP. Write 300–500 words: what is it FOR, does its hierarchy say " +
            "so, and what happens in its empty, loading and error states? Propose one change and say " +
            "what it costs.",
            ["Names the screen's single purpose",
             "Judges hierarchy against that purpose rather than against taste",
             "Covers all three non-happy states",
             "The proposed change names a trade-off, not only a benefit"], 60),
        ],
      },
    ],
  },
  {
    key: "webdev-uiux-practice", title: "UI/UX in practice", discipline: "UI/UX",
    level: "practitioner", minutes: 200,
    summary: "Systems over screens, and writing interface copy that tells the truth.",
    modules: [
      {
        title: "Words are the interface",
        activities: [
          read("Most UI problems are copy problems",
            "\"Are you sure?\" tells somebody nothing. \"Delete 43 invoices? This cannot be undone\" " +
            "tells them what and how bad.\n\nInterface copy has one job: make the consequence " +
            "visible before the click, not after. A confirmation that does not name what will happen " +
            "is a speed bump, and people learn to click through speed bumps without reading — which " +
            "is worse than not having one."),
          scenario("Rewrite three messages",
            "Find three real messages in the ERP — a confirmation, an error, an empty state. Rewrite " +
            "each so it names the consequence, the cause, or the next action. Show before and after " +
            "and say what each original left the reader guessing.",
            ["Each rewrite names a consequence, cause or next action",
             "The diagnosis of the original is specific, not 'it was vague'",
             "Length is justified — longer only where it earns it"], 60),
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════════ DevOps ════
  {
    key: "webdev-devops-foundations", title: "DevOps foundations", discipline: "DevOps",
    level: "foundation", minutes: 170,
    summary: "Containers, pipelines, and the deploy failures this estate has actually had.",
    modules: [
      {
        title: "What a deploy really is",
        activities: [
          read("Build once, promote the artefact",
            "The image that goes to live is the image that was tested — not a rebuild from the same " +
            "commit. A rebuild picks up a new base image, a floating dependency, a different build " +
            "host, and now \"the same commit\" is a different artefact.\n\nThis is why the pipeline " +
            "tags and signs an image and later stages reference it by digest. The property being " +
            "bought is simple: what you tested is what you shipped."),
          read("The deploy traps this estate has hit",
            "Every one of these has cost a real ticket here.\n\n**A variable in `.env` does nothing " +
            "unless the service's compose `environment:` block lists it.** It sits there looking " +
            "configured.\n\n**`up -d` with a stale tag silently rolls the release BACK.** No error — " +
            "the previous version simply returns.\n\n**`--remove-orphans` deletes any container in " +
            "the project whose profile is not in the command.** Run it with a partial profile list " +
            "and you have removed services you never mentioned.\n\n**A green deploy can hide a crash " +
            "loop** if the health gate lists running containers without also asking about the ones " +
            "that are restarting."),
          quiz("DevOps foundations — check", [
            q("do-1", "Why promote the tested artefact instead of rebuilding from the same commit?",
              ["It is faster", "A rebuild can differ — base image, floating dependency, build host",
               "It uses less disk", "It is required by the registry"], 1,
              "The property is: what you tested is what you shipped."),
            q("do-2", "You added a variable to `.env` and the service does not see it. Why?",
              ["It needs a restart", "The compose `environment:` block does not list it",
               "The name is wrong", "It must be exported"], 1,
              "It sits there looking configured. A real ticket here."),
            q("do-3", "`docker compose up -d` with a stale tag in `.env` does what?",
              ["Errors out", "Silently rolls the release back", "Pulls the newest image", "Nothing"], 1,
              "No error — the previous version simply returns, which reads as 'the deploy did not take'."),
            q("do-4", "Why is `--remove-orphans` dangerous with a partial profile list?",
              ["It is slow", "It deletes containers whose profile is not in the command",
               "It removes volumes", "It rebuilds images"], 1,
              "Services you never mentioned are removed."),
            q("do-5", "A deploy reports green. What has NOT been proven?",
              ["That images were pulled", "That nothing is crash-looping", "That the tag exists",
               "That the network is up"], 1,
              "A health gate that lists running containers without asking about restarting ones hides a crash loop."),
          ], 20),
        ],
      },
    ],
  },
  {
    key: "webdev-devops-practice", title: "DevOps in practice", discipline: "DevOps",
    level: "advanced", minutes: 260,
    summary: "Rollback, observability, and being answerable for what you shipped.",
    modules: [
      {
        title: "When it goes wrong",
        activities: [
          read("Roll back first, diagnose second",
            "During an incident the goal is to stop the bleeding, not to understand it. A rollback " +
            "takes two minutes; a diagnosis takes forty, and the clients are on the site for all " +
            "forty.\n\nWhich means the rollback path has to be rehearsed. A rollback nobody has run " +
            "is a hypothesis, and the middle of an incident is the worst possible time to discover " +
            "the previous image was pruned, the migration was not reversible, or the tag in `.env` " +
            "was never updated."),
          read("Backups you have not restored are not backups",
            "A backup job that reports success proves that a file was written. It proves nothing " +
            "about whether that file can be restored into a working database — and the difference is " +
            "only discovered at the moment it matters most.\n\nSame class of error as everything else " +
            "in this course: a green signal about a thing nobody checked."),
          quiz("DevOps practice — check", [
            q("dop-1", "Production is broken and you have a plausible theory. What first?",
              ["Test the theory", "Roll back, then diagnose", "Post in the channel", "Scale up"], 1,
              "A rollback is two minutes; a diagnosis is forty, with clients on the site for all forty."),
            q("dop-2", "Why must the rollback path be rehearsed?",
              ["Compliance", "An unrehearsed rollback is a hypothesis, and an incident is the worst time to test it",
               "It is faster when warm", "The registry caches it"], 1,
              "Pruned images, irreversible migrations and stale tags are all found this way."),
            q("dop-3", "A nightly backup reports success. What is proven?",
              ["The data can be restored", "A file was written", "The database is healthy",
               "The schema is valid"], 1,
              "Restorability is a separate claim, and it is discovered at the worst moment."),
            q("dop-4", "What makes 'it works on my machine' unhelpful in an incident?",
              ["It is rude", "It is a statement about one machine", "It is usually false",
               "It wastes time"], 1,
              "The same reason evidence beats belief everywhere else in this curriculum."),
          ]),
        ],
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════ Cyber Security ══
  {
    key: "webdev-cyber-foundations", title: "Security foundations", discipline: "Cyber Security",
    level: "foundation", minutes: 180,
    summary: "The vulnerability classes that actually reach production, and why they survive review.",
    modules: [
      {
        title: "The classes that matter",
        activities: [
          read("Injection, and why parameterisation is not optional",
            "String-building a query is the oldest bug in the profession and it is still shipping. " +
            "The fix is not escaping — escaping is a filter you have to get right every time — it is " +
            "parameterisation, which moves the value outside the parser entirely.\n\nThe same shape " +
            "recurs beyond SQL: shell commands, LDAP filters, template engines, and now prompts. Any " +
            "time untrusted text becomes part of an instruction, ask what the parser will do with it."),
          read("Authorization is not authentication",
            "Knowing WHO somebody is tells you nothing about WHAT they may do. The bug is almost never " +
            "\"a stranger got in\"; it is \"a legitimate user reached a record that was not theirs\" — " +
            "an id in a URL, a filter that was a suggestion rather than a boundary, an endpoint that " +
            "checked the session and not the row.\n\nWhich is why authorization here is enforced by " +
            "the policy engine and by row-level security in the database, and every other layer is a " +
            "mirror. A UI check hides a button; it does not stop a request."),
          quiz("Security foundations — check", [
            q("cy-1", "Why is parameterisation better than escaping?",
              ["It is faster", "It moves the value outside the parser instead of filtering it",
               "It is more readable", "It works in more databases"], 1,
              "Escaping is a filter you must get right every time; parameterisation removes the question."),
            q("cy-2", "Which is the more common real-world failure?",
              ["A stranger authenticating", "A legitimate user reaching a record that is not theirs",
               "A brute-forced password", "A stolen server"], 1,
              "An id in a URL, a filter used as a boundary, a session check with no row check."),
            q("cy-3", "A UI hides the delete button for non-admins. Is delete protected?",
              ["Yes", "No — a hidden button does not stop a request", "Only in production",
               "Yes, if the API is private"], 1,
              "Every layer above the policy engine and RLS is a mirror, never the boundary."),
            q("cy-4", "Where does the injection shape recur besides SQL?",
              ["Nowhere", "Shell, LDAP, templates and prompts", "Only in templates", "Only in shells"], 1,
              "Any time untrusted text becomes part of an instruction."),
          ]),
        ],
      },
    ],
  },
  {
    key: "webdev-cyber-practice", title: "Security in practice", discipline: "Cyber Security",
    level: "practitioner", minutes: 240,
    summary: "Secrets, dependencies, and reviewing code for the bug that is not there yet.",
    modules: [
      {
        title: "Living with other people's code",
        activities: [
          read("A secret in git is a secret forever",
            "Committing a key and then deleting it in the next commit removes it from the working " +
            "tree and from nowhere else. It is in the history, in every clone, in every fork and in " +
            "any mirror that ever pulled.\n\nThe only correct response to a committed secret is to " +
            "ROTATE it. Rewriting history is optional cleanup; rotation is the fix, and every minute " +
            "before rotation is a minute the key is live."),
          read("Dependencies are code you did not read",
            "Every package you add is code running with your privileges, written by somebody you have " +
            "not met, updated on a schedule you do not control.\n\nThat is not an argument against " +
            "dependencies — it is an argument for knowing how many you have and why. This UI runs on " +
            "four runtime dependencies across several large programmes, and that is a decision that " +
            "gets re-made every time somebody proposes a fifth."),
          quiz("Security practice — check", [
            q("cyp-1", "You committed an API key and deleted it in the next commit. What now?",
              ["Nothing — it is gone", "Rotate the key", "Rewrite history and stop there",
               "Add it to .gitignore"], 1,
              "It is in the history, every clone and every fork. Rotation is the fix; history rewriting is cleanup."),
            q("cyp-2", "What is the real cost of a new dependency?",
              ["Bundle size", "Code running with your privileges, updated on a schedule you do not control",
               "Install time", "Licence review"], 1,
              "Not an argument against dependencies — an argument for knowing how many and why."),
            q("cyp-3", "During review, which question finds the most bugs?",
              ["Is it formatted correctly?", "What happens when this input is hostile or absent?",
               "Is it fast?", "Are there tests?"], 1,
              "The bug that is not there yet is usually an unconsidered input."),
            q("cyp-4", "A dependency you use is deprecated but working. Is that a security issue?",
              ["No, it works", "Yes — nobody is shipping fixes for it", "Only if it is public",
               "Only at the next audit"], 1,
              "Unmaintained means unpatched, and the clock runs whether or not anybody is watching."),
          ]),
        ],
      },
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════════════ QA ════
  {
    key: "webdev-qa-foundations", title: "QA foundations", discipline: "QA",
    level: "foundation", minutes: 150,
    summary: "What a test is for, and why a green suite can mean nothing ran.",
    modules: [
      {
        title: "Tests that can fail",
        activities: [
          read("A test that cannot fail is documentation with a runtime cost",
            "The value of a test is entirely in the failure it would produce. A test asserting that " +
            "a constant equals itself, or that a mock returns what you told it to, has never had the " +
            "opportunity to be wrong.\n\nThe check worth applying: what would have to break for this " +
            "to go red? If you cannot answer, delete it — a suite full of tests that cannot fail is " +
            "worse than a smaller one, because it buys confidence it has not earned."),
          read("Check the skip count",
            "This estate's suites SKIP silently without a database URL. \"All green\" can mean " +
            "\"nothing ran\", and it looks identical in the terminal.\n\nA related trap, from a real " +
            "session here: reading a summary for `Tests ` and missing `Test Files ` — every test " +
            "passed while a whole FILE was red. Read both lines. The number that matters is not the " +
            "one that reads best."),
          quiz("QA foundations — check", [
            q("qa-1", "How do you judge whether a test is worth having?",
              ["Coverage percentage", "What would have to break for it to go red",
               "Execution time", "Whether it is readable"], 1,
              "The value of a test is entirely in the failure it would produce."),
            q("qa-2", "A suite reports all green. What might that also mean?",
              ["Nothing else", "Nothing ran — it skipped without its database URL",
               "Tests were cached", "The reporter is broken"], 1,
              "Silent skips look identical to success in the terminal."),
            q("qa-3", "Why read `Test Files` as well as `Tests`?",
              ["Habit", "A whole file can be red while every test passed", "It is faster",
               "The counts always match"], 1,
              "That exact omission hid a failing file in a real session here."),
            q("qa-4", "You assert that a mock returns the value you configured. What have you tested?",
              ["The integration", "The mock", "The contract", "Error handling"], 1,
              "It never had the opportunity to be wrong."),
          ]),
        ],
      },
    ],
  },
  {
    key: "webdev-qa-practice", title: "QA in practice", discipline: "QA",
    level: "practitioner", minutes: 220,
    summary: "Driving the real surface, finding the flake, and reporting a bug somebody can fix.",
    modules: [
      {
        title: "Verification that means something",
        activities: [
          read("Scripted verification is not real-input verification",
            "Calling an endpoint from a script proves the endpoint answers. It does not prove the " +
            "feature works, because the surface a person uses has a form, a session, a company " +
            "selector and a render that the script never touched.\n\nA real example from this " +
            "codebase: a data layer passed its arguments in the wrong order. Both were strings, so " +
            "the compiler was blind and three thousand tests stayed green — while the pages asked a " +
            "backend nothing and rendered a confident \"nothing here\". Only driving the rendered " +
            "page found it."),
          read("A bug report is a reproduction",
            "\"It does not work\" starts a conversation that could have been a fix. What is needed is " +
            "the smallest path that produces it: who you were signed in as, which company was " +
            "selected, what you clicked, what you expected, what happened.\n\nThe environment matters " +
            "more than people expect — local, test and live differ, and half of all \"cannot " +
            "reproduce\" is two people looking at two different systems."),
          quiz("QA practice — check", [
            q("qap-1", "A script calls the endpoint and gets a 200. What is proven?",
              ["The feature works", "The endpoint answers", "The UI works", "The data is correct"], 1,
              "The form, session, company selector and render were never touched."),
            q("qap-2", "Two string arguments were passed in the wrong order. Why did nothing catch it?",
              ["Poor test coverage", "Both are strings, so the compiler is blind and the fallback returned []",
               "The tests were skipped", "It was a runtime-only path"], 1,
              "It rendered a confident 'nothing here'. Only driving the page found it."),
            q("qap-3", "What is the most-forgotten field in a bug report?",
              ["The date", "Which environment and which company was selected", "The browser",
               "The severity"], 1,
              "Half of all 'cannot reproduce' is two people looking at two different systems."),
            q("qap-4", "A test fails once in twenty runs. What is the correct response?",
              ["Retry it in CI", "Treat the flake as a bug and find the race",
               "Increase the timeout", "Skip it"], 1,
              "A retry hides a real non-determinism, usually in the code rather than the test."),
          ]),
        ],
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════════ LEAD ════
  {
    key: "webdev-lead-track", title: "Leading Web Dev", discipline: "Management",
    level: "lead", minutes: 240,
    summary: "Estimation, review, and being answerable for a team's output — the management tier.",
    modules: [
      {
        title: "The judgement calls",
        activities: [
          read("Estimates are a distribution, not a number",
            "\"Three days\" is a mode reported as a certainty. What the person means is somewhere " +
            "between two and eight depending on what they find, and the gap between those two numbers " +
            "is the actual information.\n\nSo ask for the range and what would push it to the top of " +
            "it. That question surfaces the unknowns while there is still time to reduce them, which " +
            "is the only part of estimation that changes an outcome."),
          read("Review is teaching, and it compounds",
            "A review comment that says \"change this\" fixes one line. One that says why fixes a " +
            "class of line, forever.\n\nThe cost is real — it is slower — and it is the highest-return " +
            "thing a lead does, because the alternative is finding the same defect in a different " +
            "file in three weeks. Reserve \"just change it\" for the times the reason genuinely is " +
            "'house style'."),
          scenario("A call you have to make",
            "A build is due Friday. On Wednesday you find a design decision that will cost two days " +
            "to fix properly and can be worked around in two hours. The client has not seen it. " +
            "Write what you would do and why, in 400–600 words: what you tell the client, what you " +
            "tell the developer, and what you write down.",
            ["States a decision rather than surveying options",
             "Names what the client is told and when — silence is a choice too",
             "Distinguishes the technical cost from the relationship cost",
             "Records the workaround as debt with an owner, not as a resolved item"], 60),
        ],
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The paths. Order is enforced (`requires_previous`), and every discipline path starts after the
// shared foundation — the delivery rail and the ball are prerequisites for all six.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PATHS: PathSpec[] = [
  {
    key: "webdev-foundations", title: "Web Dev — foundations", discipline: "Shared", level: "foundation",
    summary: "Everyone in the department, before any discipline. How work flows, and what evidence means.",
    courses: ["webdev-how-we-work", "webdev-toolchain"],
    certification: "Web Dev Foundations", validMonths: 36,
  },
  {
    key: "webdev-fe-track", title: "Web Dev — Frontend", discipline: "FE", level: "practitioner",
    summary: "The browser's model, then accessibility and performance you can measure.",
    courses: ["webdev-fe-foundations", "webdev-fe-practice"],
    certification: "FE Practitioner", validMonths: 24,
  },
  {
    key: "webdev-be-track", title: "Web Dev — Backend", discipline: "BE", level: "practitioner",
    summary: "Data that lies, then writes that survive being retried.",
    courses: ["webdev-be-foundations", "webdev-be-practice"],
    certification: "BE Practitioner", validMonths: 24,
  },
  {
    key: "webdev-uiux-track", title: "Web Dev — UI/UX", discipline: "UI/UX", level: "practitioner",
    summary: "Hierarchy and the non-happy states, then copy that tells the truth. Reviewed by a person throughout.",
    courses: ["webdev-uiux-foundations", "webdev-uiux-practice"],
    certification: "UI/UX Practitioner", validMonths: 24,
  },
  {
    key: "webdev-devops-track", title: "Web Dev — DevOps", discipline: "DevOps", level: "advanced",
    summary: "What a deploy really is, then rollback and being answerable for what you shipped.",
    courses: ["webdev-devops-foundations", "webdev-devops-practice"],
    certification: "DevOps Practitioner", validMonths: 12,
  },
  {
    key: "webdev-cyber-track", title: "Web Dev — Cyber Security", discipline: "Cyber Security", level: "practitioner",
    summary: "The classes that reach production, then secrets and dependencies. Expires annually.",
    courses: ["webdev-cyber-foundations", "webdev-cyber-practice"],
    certification: "Security Practitioner", validMonths: 12,
  },
  {
    key: "webdev-qa-track", title: "Web Dev — QA", discipline: "QA", level: "practitioner",
    summary: "What a test is for, then driving the real surface and reporting a reproduction.",
    courses: ["webdev-qa-foundations", "webdev-qa-practice"],
    certification: "QA Practitioner", validMonths: 24,
  },
  {
    key: "webdev-lead-path", title: "Web Dev — leading the department", discipline: "Management", level: "lead",
    summary: "The management tier of the same craft: estimation, review, and the calls nobody else can make.",
    courses: ["webdev-lead-track"],
  },
];

export interface WebdevCurriculumResult {
  tenantId: string;
  courses: { created: string[]; existing: string[] };
  activities: number;
  paths: { created: string[]; existing: string[] };
}

export async function seedWebdevCurriculum(companyName = AGENCY_NAME): Promise<WebdevCurriculumResult> {
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
          [courseId, tenantId, course.key, course.title, course.summary, UNIT, course.discipline,
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
          [pathId, tenantId, path.key, path.title, path.summary, UNIT, path.discipline, path.level,
           path.validMonths ?? null, path.certification ?? null],
        );
        // `requires_previous` TRUE throughout — "steps so difficulties are in order", enforced
        // rather than suggested.
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

/** Counted through withTenants, never withGlobal — see the header. */
export async function verifyWebdevCurriculum(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const out: Record<string, number> = {};
      const courses = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_courses WHERE unit_node_id = $1`, [UNIT],
      );
      const paths = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_paths WHERE unit_node_id = $1`, [UNIT],
      );
      const disciplines = await c.query<{ n: string }>(
        `SELECT count(DISTINCT discipline)::text AS n FROM lms_courses WHERE unit_node_id = $1`, [UNIT],
      );
      const quizzes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id = $1 AND a.kind = 'quiz'`, [UNIT],
      );
      // The number that would betray a broken seed: a LAB authored before the runner exists makes
      // its whole path permanently uncompletable. Expected to be zero until L5.
      const labs = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id = $1 AND a.kind = 'lab'`, [UNIT],
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
  seedWebdevCurriculum()
    .then(async (r) => {
      console.log("[seed:lms-webdev-curriculum] tenant", r.tenantId);
      console.log(`  courses    created=${r.courses.created.length} existing=${r.courses.existing.length}`);
      console.log(`  activities ${r.activities} written`);
      console.log(`  paths      created=${r.paths.created.length} existing=${r.paths.existing.length}`);
      const counts = await verifyWebdevCurriculum(r.tenantId);
      console.log("[seed:lms-webdev-curriculum] verified through withTenants:", JSON.stringify(counts));
      if (counts.courses === 0 || counts.paths === 0) {
        throw new Error(
          "[seed:lms-webdev-curriculum] verification read ZERO rows — the lms module scope was not " +
          "open. Nothing was written.",
        );
      }
      if (counts.labs > 0) {
        throw new Error(
          `[seed:lms-webdev-curriculum] ${counts.labs} lab activity(ies) exist. The lab RUNNER does ` +
          `not exist until L5, so a required lab makes its whole path permanently uncompletable.`,
        );
      }
      console.log(
        "\nNOBODY IS ENROLLED. These paths are department paths, not mandatory ones — the head " +
        "assigns them. Theory and quizzes only: the hands-on labs attach to these same course keys " +
        "at L5, once the runner exists.",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:lms-webdev-curriculum] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
