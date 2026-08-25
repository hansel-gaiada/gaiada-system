// THE SEO CURRICULUM + THE GM (GENERAL MANAGEMENT) CURRICULUM — foundation through lead, per dept.
//
// Modelled directly on `lms-webdev-curriculum.ts` (read that file's header first — the invariants
// below are the same ones, restated for a two-department seed instead of a one-department seed).
//
// ── WHAT THIS WAVE DELIVERS ───────────────────────────────────────────────────────────────────
// Two departments, three courses each (foundation → practitioner → lead), assembled into FOUR
// ordered paths. Theory and graded quizzes only — no `lab` activities (see below). SEO covers the
// department's four divisions (SEO, SEM, Copywriter, Backlink) as one department-level curriculum
// rather than one course per division, per the ticket. GM sits at `d-gm`, the department spine's
// root — every other department parents to it — so this is the general-management track everyone
// eventually grows into, not a discipline course.
//
// ── TWO DEPARTMENTS, TWO UNIT IDS — the one structural difference from the Web Dev seed ────────
// The Web Dev seed has exactly one `unit_node_id` and hardcodes it as a module constant. This seed
// spans `d-seo` and `d-gm`, so `CourseSpec`/`PathSpec` each carry their OWN `unit` field and the
// insert/verify queries read it per-row instead of from a shared constant.
//
// ── NO `lab` ACTIVITIES ARE AUTHORED HERE ───────────────────────────────────────────────────────
// A `lab` is graded by a runner that does not exist yet. An activity marked `is_required` that
// nothing can ever pass makes its whole path permanently uncompletable — so seeding labs now would
// ship four paths nobody could finish, and the symptom would read as "the training is too hard"
// rather than as a missing service.
//
// ── GRADING IS MIXED, same rule as Web Dev ──────────────────────────────────────────────────────
// Objective material (what a search engine ranks, keyword mechanics, reading a P&L) is `auto` —
// there is a right answer. Anything that judges a commercial or client-facing call — a ranking
// promise, a client conversation about a mistake, a delegation decision — is `scenario` /
// `grading: "review"`. The GM track is mostly reviewed, per the brief: "there is rarely one right
// answer" in management judgement calls.
//
// ⚠ THE LMS WALL IS A THIRD GUC. Without `{ modules: ["lms"] }` every insert below writes ZERO rows
//   and reports success. Every call passes it, and verification reads back through withTenants for
//   the same reason.
//
// ⚠ ANSWER KEYS LIVE IN `spec`. `GET /courses/:id` redacts them for anyone who is not authoring the
//   course (spec-redaction.ts). This file is where they are written.
//
// Idempotent, and it will NOT rewrite an existing course.
import { withTenants, withGlobal, closePool, newId } from "../db";

const AGENCY_NAME = "Gaia Digital Agency";
/** The two department org-blob node ids (`seed/roster.ts` AGENCY_DEPTS). */
const UNIT_SEO = "d-seo";
const UNIT_GM = "d-gm";

type Kind = "read" | "quiz" | "scenario";
type Grading = "auto" | "review" | "none";
type Level = "foundation" | "practitioner" | "advanced" | "lead";

interface Act {
  kind: Kind; title: string; spec: Record<string, unknown>;
  grading?: Grading; passThreshold?: number; maxAttempts?: number; minutes?: number; optional?: boolean;
}
interface Mod { title: string; summary?: string; activities: Act[] }
interface CourseSpec {
  key: string; title: string; summary: string; discipline: string; level: Level; unit: string;
  minutes: number; modules: Mod[];
}
interface PathSpec {
  key: string; title: string; summary: string; discipline: string; level: Level; unit: string;
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
// SEO — covers all four divisions (SEO, SEM, Copywriter, Backlink) as one department curriculum.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const COURSES: CourseSpec[] = [
  {
    key: "seo-foundations", title: "SEO foundations", discipline: "SEO",
    level: "foundation", unit: UNIT_SEO, minutes: 160,
    summary: "What a search engine is actually ranking, keyword intent versus volume, and the technical hygiene that makes a page eligible to be seen at all.",
    modules: [
      {
        title: "What ranking actually rewards",
        summary: "Not tricks — a proxy for whether a page answers the query better than the alternatives.",
        activities: [
          read("What a search engine is actually ranking",
            "A search engine is not rewarding keywords on a page; it is trying to guess which result " +
            "will satisfy the person who typed the query, and it uses hundreds of imperfect signals " +
            "as a proxy for that guess — relevance, authority, freshness, how the page behaves once " +
            "somebody lands on it, and whether they bounce straight back to the results.\n\nThis " +
            "matters because it reframes the whole discipline: you are not gaming an algorithm, you " +
            "are trying to make the true answer ('this page genuinely serves this query best') match " +
            "the algorithm's guess. Every legitimate SEO tactic is an attempt to close that gap " +
            "honestly. Every black-hat tactic is an attempt to fake the signal without closing the " +
            "gap — and the engines spend enormous effort detecting exactly that mismatch, because a " +
            "search engine's entire business depends on its guesses being trustworthy.\n\nFor a " +
            "client, this means the honest pitch is never \"we will trick Google\"; it is \"we will " +
            "make your page the one that most deserves to rank, and make the signals say so " +
            "truthfully.\" That framing also tells you when a request is a red flag: if a client asks " +
            "for a tactic that improves the signal without improving the page, the signal is being " +
            "faked, and faked signals get caught."),
          read("Keyword intent versus keyword volume",
            "A high-volume keyword and a keyword that actually converts are frequently different " +
            "keywords, and confusing them is the single most common way an SEO campaign burns a " +
            "client's budget on traffic that never buys anything.\n\nSearch intent comes in roughly " +
            "four flavours: informational (\"what is technical SEO\"), navigational (\"gaiada login\"), " +
            "commercial investigation (\"best villa management software Bali\"), and transactional " +
            "(\"book villa management Canggu\"). A page ranking #1 for a huge informational term can " +
            "show impressive traffic numbers on a report while sending the client zero leads, because " +
            "nobody searching \"what is a villa management company\" is ready to sign a contract.\n\n" +
            "The practical discipline: before proposing a keyword, ask what the searcher wants to DO " +
            "next, not just how many people search it. A smaller, transactional-intent keyword a " +
            "client can actually rank for and that converts is worth more to them than a vanity " +
            "number on a monthly report — and a report that only shows volume is optimising for how " +
            "the report looks, not for what the client hired you to achieve."),
          quiz("SEO foundations — check", [
            q("seof-1", "What is a search engine's ranking signal actually a proxy for?",
              ["Keyword density on the page", "Which result will satisfy the person who searched",
               "How much the site owner has spent", "How long the domain has existed"], 1,
              "Relevance, authority and behaviour signals all exist to approximate that one judgement."),
            q("seof-2", "A page ranks #1 for a huge informational keyword but the client gets no leads. What happened?",
              ["The page is broken", "High volume was chased instead of transactional intent",
               "The competitor is cheating", "The report is wrong"], 1,
              "Volume and intent are different axes; a vanity ranking with no buying intent behind it converts nothing."),
            q("seof-3", "Why does faking a ranking signal tend to get caught?",
              ["It is illegal", "Search engines' business depends on their guesses being trustworthy, so they invest in detecting mismatches",
               "It is slower than honest SEO", "Competitors report it"], 1,
              "A faked signal without a genuinely better page IS the mismatch the engine is built to detect."),
            q("seof-4", "Which is a transactional-intent query?",
              ["\"what is technical seo\"", "\"gaiada login\"", "\"book villa management canggu\"",
               "\"best villa software bali\" (research phase)"], 2,
              "It names an action the searcher is ready to take now, not research or navigation."),
          ]),
        ],
      },
      {
        title: "Technical hygiene — being eligible to be seen",
        summary: "Crawlability, canonicals and Core Web Vitals: the plumbing that has to work before ranking is even possible.",
        activities: [
          read("Crawlability, canonicals, and Core Web Vitals",
            "None of the persuasive parts of SEO matter if the page cannot be crawled, or if the " +
            "engine is confused about which of several near-duplicate URLs is the \"real\" one.\n\n" +
            "**Crawlability**: a `robots.txt` disallow, an accidental `noindex`, or a page that only " +
            "renders after client-side JavaScript the crawler does not execute reliably, all produce " +
            "the same symptom — a page that looks fine in the browser and simply does not exist to " +
            "the engine. Check what a crawler actually sees, not what you see.\n\n**Canonicals**: the " +
            "same product reachable at `/villa-1`, `/villa-1/`, and `/villa-1?ref=ig` looks like three " +
            "competing pages splitting the same authority three ways, unless a canonical tag says " +
            "which one is authoritative. Get this wrong and a strong page ranks weakly because it is " +
            "competing with itself.\n\n**Core Web Vitals** (loading, interactivity, visual stability) " +
            "are a genuine ranking input now, and they are also just good practice: a page a real " +
            "person abandons before it finishes loading was never going to convert regardless of " +
            "where it ranked."),
          quiz("Technical hygiene — check", [
            q("seot-1", "A page renders fine in the browser but the crawler sees nothing. What is the likely cause?",
              ["The page is too long", "A disallow, an accidental noindex, or JS-only rendering the crawler does not execute",
               "Too many images", "The title tag is missing"], 1,
              "All three produce the identical symptom: fine to a person, invisible to the engine."),
            q("seot-2", "The same product is reachable at three URLs with no canonical tag. What happens?",
              ["Nothing — the engine picks the best one automatically", "Authority splits across the duplicates and each ranks weaker",
               "Only the shortest URL is indexed", "It is flagged as spam"], 1,
              "Three near-duplicates without a signal of which is authoritative compete with each other for the same relevance."),
            q("seot-3", "Why are Core Web Vitals worth optimising even ignoring the ranking effect?",
              ["They are not worth it otherwise", "A page abandoned before it loads was never going to convert",
               "They are required by law in some regions", "They only affect mobile"], 1,
              "The ranking credit and the business reason point the same direction here."),
          ]),
        ],
      },
      {
        title: "What NOT to do",
        summary: "Paid link schemes, doorway pages, and a ranking promise you cannot keep.",
        activities: [
          read("Paid links, doorway pages, and the promise you cannot make",
            "Three patterns show up here often enough to name explicitly, because each one trades a " +
            "short-term client-pleasing number for a risk the client did not agree to take.\n\n" +
            "**Paid link schemes** — buying links purely to manipulate authority, rather than earning " +
            "them because the content is worth linking to — are against every major engine's " +
            "guidelines and are actively hunted for. A manual action against a client's domain can " +
            "erase years of legitimate ranking in a single algorithm update, and it lands on the " +
            "CLIENT'S domain, not ours.\n\n**Doorway pages** — near-duplicate pages built to rank for " +
            "every city/keyword permutation and funnel everyone to the same offer — read as spam to " +
            "both engines and to the humans who land on one, and they are treated as a violation " +
            "class, not a grey area.\n\n**The promise nobody should make**: \"we will get you to #1\" " +
            "is a promise about a system we do not control and that changes without notice. Nobody " +
            "here controls Google's algorithm, a competitor's budget, or next month's update. What we " +
            "CAN promise is the work — the technical hygiene, the honest content, the legitimate " +
            "authority-building — and an honest account of what that work is likely to achieve and by " +
            "when. A ranking guarantee is a liability we hand the agency, not a service we hand the " +
            "client."),
          quiz("What NOT to do — check", [
            q("seon-1", "Why is buying links to manipulate authority a real risk, not just against the rules?",
              ["It is expensive", "A manual action can erase years of ranking, and it lands on the client's domain",
               "It is slow to set up", "It only affects one page"], 1,
              "The exposure is the client's domain, and the loss can be sudden and total."),
            q("seon-2", "A client asks you to promise a #1 ranking by a date. What is the correct answer?",
              ["Promise it to win the deal", "Explain that ranking is a system nobody here controls, and offer to commit to the work instead",
               "Promise it but pad the timeline", "Refuse the client"], 1,
              "The only thing legitimately promisable is the work and an honest account of its likely effect."),
            q("seon-3", "What is a doorway page?",
              ["A page requiring login", "A near-duplicate page built per city/keyword to funnel everyone to one offer",
               "A 404 page", "A page with a paywall"], 1,
              "It reads as spam to engines and to the humans who land on one — a violation class, not a grey area."),
          ]),
        ],
      },
    ],
  },
  {
    key: "seo-sem-copy-practice", title: "SEM and copywriting in practice", discipline: "SEM",
    level: "practitioner", unit: UNIT_SEO, minutes: 220,
    summary: "SEM spends the client's money, so a mistake here has a bill attached. Then: writing for a person who is scanning, not reading.",
    modules: [
      {
        title: "SEM spends real money",
        summary: "Match types, negative keywords, and the discipline a spending account demands.",
        activities: [
          read("Match types, and why a broad match bill arrives at 2am",
            "Search ad match types are not a technical footnote — they are the control on how much of " +
            "the client's money a single campaign can spend on queries nobody wanted.\n\n**Broad " +
            "match** lets the platform match a huge and growing set of related queries to your ad. It " +
            "is the fastest way to get volume and the fastest way to spend a month's budget on \"free " +
            "villa management bali\" when the client sells paid management services. **Phrase match** " +
            "and **exact match** narrow that, trading reach for control.\n\nThe practical rule: a new " +
            "or unfamiliar account starts NARROW and widens deliberately once the search terms report " +
            "shows what is actually converting — not the reverse. Widening later is a choice you can " +
            "revisit tomorrow morning; a broad-match account left unattended overnight is not, because " +
            "the spend already happened."),
          read("Negative keywords are not an afterthought",
            "A negative keyword list is what stops the account from paying for traffic that was never " +
            "going to convert — \"free\", \"jobs\", \"course\", \"diy\" in front of a commercial service " +
            "term, a competitor's brand name you do not want to bid indirectly against, a location " +
            "outside where the client can even take clients.\n\nThe habit that matters: read the " +
            "search terms report on a cadence, not once at launch. New irrelevant queries appear as " +
            "the platform's matching evolves, and a negative list built once at setup and never " +
            "revisited quietly decays into a leaking account. This is the single highest-leverage half " +
            "hour in SEM work, and it is the one most often skipped because nothing visibly breaks " +
            "when it is skipped — the money just goes."),
          quiz("SEM — check", [
            q("sem-1", "Why start a new account on narrow match types rather than broad?",
              ["Narrow is cheaper per click", "Broad can spend the budget on unrelated queries before the search terms report shows what converts",
               "Broad match is being deprecated", "Narrow match ranks organically too"], 1,
              "Widening later is a reversible choice; overnight broad-match spend already happened."),
            q("sem-2", "What is a negative keyword list actually for?",
              ["SEO", "Stopping spend on queries that were never going to convert",
               "Blocking competitors from seeing your ads", "Improving Quality Score only"], 1,
              "It is the mechanism that keeps the account's money pointed at real intent."),
            q("sem-3", "A negative list was built at launch and never revisited. What happens?",
              ["Nothing — it stays valid", "It quietly decays as new irrelevant queries match, and the account leaks money",
               "The account is auto-paused", "Google rebuilds it automatically"], 1,
              "Nothing visibly breaks when this is skipped — which is exactly why it is the one most often skipped."),
            q("sem-4", "Why does an SEM mistake carry a bill that an organic SEO mistake does not?",
              ["SEM is more complex", "SEM spends the client's money directly and in real time",
               "SEM has more reporting", "SEM requires more approvals"], 1,
              "This is the discipline-defining difference the brief calls out."),
          ]),
        ],
      },
      {
        title: "Writing for a person who is scanning",
        summary: "Copy for search and for the page — most readers scan, they do not read top to bottom.",
        activities: [
          read("Nobody reads the page — they scan it for the part that answers them",
            "Eye-tracking on real pages shows an F-shaped or Z-shaped scan, not a careful top-to-bottom " +
            "read. A visitor arrives with a specific question from the search result they clicked, and " +
            "they are scanning for the paragraph, heading or bullet that answers it — everything else " +
            "is skimmed past.\n\nWhich means the practical rules invert a lot of instinctive writing " +
            "habits: the most important sentence goes FIRST in a paragraph, not as a reveal at the " +
            "end. Headings should be specific enough to answer a question on their own, because that " +
            "is often the only text that gets read. A meta title and description are not marketing " +
            "copy for the reader who already clicked — they are the pitch that earns the click in the " +
            "first place, and they have to match what the page actually delivers, or the visitor " +
            "bounces straight back to the results and that bounce is itself a signal."),
          quiz("Copywriting — check", [
            q("copy-1", "How do most visitors actually read a page?",
              ["Carefully, top to bottom", "Scanning for the part that answers their specific question",
               "Only the images", "Only the URL"], 1,
              "Real scan patterns are F- or Z-shaped, not linear."),
            q("copy-2", "Where should the most important sentence in a paragraph go?",
              ["Last, as a payoff", "First", "In the middle for emphasis", "In a footnote"], 1,
              "A scanning reader needs the answer before they decide to keep reading."),
            q("copy-3", "Why must a meta title match what the page actually delivers?",
              ["It is a ranking factor only", "A mismatch produces a bounce, which is itself a negative signal",
               "Search engines penalise mismatches directly", "It affects load time"], 1,
              "The title earns the click; the page has to honour it or the visitor leaves immediately."),
          ]),
        ],
      },
    ],
  },
  {
    key: "seo-lead-track", title: "Leading SEO", discipline: "Management",
    level: "lead", unit: UNIT_SEO, minutes: 220,
    summary: "Accountable reporting, backlink judgement, and holding the line on promises the department cannot keep.",
    modules: [
      {
        title: "The judgement calls at the head of the department",
        activities: [
          read("A backlink is a vote — and some votes are poison",
            "A link from a relevant, real, editorially-earned source is worth having. A link bought in " +
            "bulk from a low-quality network is worth actively avoiding, because a link profile that " +
            "looks manipulated can suppress a domain's rankings across the board, not just for the " +
            "page that got the link.\n\nLeading the discipline means the backlink strategy a junior " +
            "proposes gets judged on ONE question before any other: would this link exist if ranking " +
            "did not? A guest post on a real, relevant site that a genuine reader would click through " +
            "to is fine. A link inserted purely because it points somewhere is the thing that gets a " +
            "domain manually actioned, and undoing that damage costs far more than the campaign that " +
            "chased the number in the first place."),
          read("A report that only shows the number the client wants to see is a report that lies later",
            "It is tempting to lead a monthly report with impressions and ranking positions, because " +
            "they move fast and look good. But if none of that traffic converts, a report built that " +
            "way is training the client to expect a vanity metric, and the conversation where the " +
            "truth finally surfaces — that rankings improved and revenue did not — lands worse the " +
            "longer it was deferred.\n\nThe accountable version leads with the outcome the client " +
            "actually hired the department for, shows the leading indicators honestly labelled as " +
            "leading indicators, and says plainly when a number moved for a reason that will not " +
            "repeat. That is a harder report to write and a much easier one to stand behind six " +
            "months later."),
          scenario("A promise a junior already made",
            "A junior on your team told a client \"you'll be #1 for your main keyword within a month\" " +
            "in a kickoff call before checking with you. The client has referenced it twice since, in " +
            "writing. Write 400–600 words: what you say to the client, what you say to the junior, and " +
            "what you change about how the department makes commitments going forward.",
            ["Corrects the client-facing record without making the junior the villain in front of the client",
             "Coaches the junior on why the promise was unsafe, not just that it was wrong",
             "Proposes a concrete process change (e.g. who may commit to a number, and how)",
             "Names what CAN honestly be promised in place of what was withdrawn"], 60),
        ],
      },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════════════════════ GM
  {
    key: "gm-foundations", title: "GM foundations", discipline: "GM",
    level: "foundation", unit: UNIT_GM, minutes: 160,
    summary: "Reading a P&L, and understanding utilisation and capacity — the two numbers every management decision here rests on.",
    modules: [
      {
        title: "The numbers behind every decision",
        activities: [
          read("Reading a P&L without being an accountant",
            "A profit and loss statement answers one question at a time, and confusing which question " +
            "you are answering is the most common way a non-finance manager misreads one.\n\n" +
            "**Revenue** is what was billed, not what was collected — a healthy revenue line can sit " +
            "next to a cash-flow problem if invoices are not being paid. **Cost of delivery** is what " +
            "it actually took to do the work — people's time, subcontractors, tools — and this is the " +
            "line a department head has the most direct control over. **Gross margin** (revenue minus " +
            "cost of delivery) is the number that tells you whether the WORK itself is priced " +
            "sustainably, before a single overhead cost is even considered.\n\nThe practical habit: " +
            "before reacting to a P&L number, ask which of these three questions it is actually " +
            "answering. A department can be busy, well-reviewed by clients, and still be losing money " +
            "on every project if the gross margin line is not being watched."),
          read("Utilisation and capacity — the constraint underneath every commitment",
            "Utilisation is the fraction of a person's paid time that is billable to client work. " +
            "Capacity is how much total billable work the team could take on at a sustainable " +
            "utilisation rate — not 100%, because a team run at 100% utilisation has no room for " +
            "review, mentoring, sick days or the inevitable rework, and it will start missing " +
            "deadlines the first week anything goes even slightly wrong.\n\nThe number that actually " +
            "matters for a commitment is capacity, not headcount. Two teams of five people can have " +
            "wildly different capacity depending on seniority mix, tooling, and how much of their time " +
            "goes to non-billable overhead. Committing to new work by counting heads rather than " +
            "checking capacity is how a department ends up promising delivery dates it structurally " +
            "cannot hit — and the first sign of it is not a missed deadline, it is a team that stops " +
            "having time to do anything except the most urgent thing."),
          quiz("GM foundations — check", [
            q("gmf-1", "Revenue is healthy but the client hasn't paid the invoice yet. What does the P&L revenue line reflect?",
              ["Cash collected", "What was billed, regardless of whether it has been paid",
               "Profit", "Nothing until payment clears"], 1,
              "Revenue and cash collection are different questions; conflating them hides a receivables problem."),
            q("gmf-2", "Which line does a department head have the MOST direct control over?",
              ["Overhead allocation", "Cost of delivery", "Tax", "Company-wide revenue"], 1,
              "People's time, subcontractors and tools are the levers a department head actually pulls."),
            q("gmf-3", "Why is 100% utilisation a warning sign rather than a goal?",
              ["It is illegal", "There is no room for review, mentoring or rework, so small problems become missed deadlines",
               "It costs more in tax", "Clients dislike it"], 1,
              "A team run flat out has no slack to absorb the inevitable friction of real work."),
            q("gmf-4", "Two teams of five have different capacity. Why?",
              ["Headcount always determines capacity", "Seniority mix, tooling and non-billable overhead differ between teams",
               "It is random", "Capacity only depends on office size"], 1,
              "Counting heads instead of checking capacity is how commitments outrun what a team can structurally deliver."),
          ]),
        ],
      },
    ],
  },
  {
    key: "gm-practice", title: "GM in practice", discipline: "GM",
    level: "practitioner", unit: UNIT_GM, minutes: 220,
    summary: "Pricing work so it is actually profitable, and having the client conversation nobody wants to have.",
    modules: [
      {
        title: "Pricing and the conversation everyone avoids",
        activities: [
          read("Pricing work so the margin survives contact with reality",
            "A quote built purely from \"what will the client accept\" and a quote built purely from " +
            "\"our hourly rate times our best-case estimate\" both fail the same way: neither accounts " +
            "for what actually happens on a project, which is scope creep, revision rounds, and the " +
            "client's own delays that still cost you calendar time even when they do not cost billable " +
            "hours.\n\nThe practical discipline is to price from the REALISTIC estimate, not the " +
            "optimistic one — ask what this class of project has actually taken before, not what it " +
            "should take in a world with no surprises — and to build revision rounds and a change-" +
            "request path into the SCOPE, not into hope. A price that only works if nothing goes wrong " +
            "is a price that is already wrong, because on a long enough timeline something always " +
            "does."),
          read("The client conversation nobody wants to have",
            "A slip, a mistake, an invoice that is going to be higher than the client expects — these " +
            "conversations get avoided because they are uncomfortable, and the avoidance always makes " +
            "them worse. A mistake disclosed early, with a plan attached, reads as competence. The same " +
            "mistake discovered by the client later, or disclosed late with no plan, reads as " +
            "concealment — even when the underlying error was identical.\n\nThe shape that works: say " +
            "what happened factually, say what it costs (time, money, or both) without minimising it, " +
            "and say what you are doing about it before the client has to ask. Silence is not neutral " +
            "here — deciding not to raise something is itself a decision, and it is usually the wrong " +
            "one, because the client eventually finds out either way and now also has to wonder what " +
            "else was not raised."),
          quiz("GM practice — check", [
            q("gmp-1", "Why does pricing from the optimistic estimate tend to fail?",
              ["Clients always negotiate down", "It does not account for the scope creep and rework every real project has",
               "It is illegal", "Optimistic estimates are always wrong by the same amount"], 1,
              "The realistic estimate — what this class of project has actually taken before — is the one worth pricing from."),
            q("gmp-2", "A mistake is disclosed to the client immediately with a remediation plan. How does it read?",
              ["As incompetence", "As competence, even though the underlying error is unchanged",
               "As an admission of liability", "The same as if it were hidden"], 1,
              "Timing and the presence of a plan change how identical facts are perceived."),
            q("gmp-3", "Why is staying silent about a slip not a neutral choice?",
              ["Clients never notice", "Not raising it is itself a decision, and it is usually the wrong one",
               "Silence is legally required", "It saves time either way"], 1,
              "The client eventually learns anyway, and then has to wonder what else went unmentioned."),
            q("gmp-4", "What should a change-request path be built into?",
              ["Hope that it is not needed", "The scope, from the start", "A separate contract only",
               "The invoice, after the fact"], 1,
              "Building it into the scope means the mechanism exists before it is needed, not after."),
          ]),
        ],
      },
    ],
  },
  {
    key: "gm-lead-track", title: "Leading a department", discipline: "Management",
    level: "lead", unit: UNIT_GM, minutes: 240,
    summary: "Delegation and the ball, and holding a department accountable without micromanaging it.",
    modules: [
      {
        title: "Accountability without micromanagement",
        activities: [
          read("Delegation is handing over the ball, not the checklist",
            "Real delegation transfers the OUTCOME somebody owns, not a list of steps to execute. A " +
            "task handed over with every step pre-decided is not delegation — it is dictation with " +
            "extra latency, because the person doing the work has no room to notice a better way and " +
            "no reason to think about the goal, only about the steps.\n\nThe ball model applies here " +
            "too: at any moment exactly one person owes the next move, and a lead's job is to make " +
            "sure that person has enough context to make good decisions alone, not to make the " +
            "decisions for them and outsource only the typing. A lead who is still making every call " +
            "has not delegated the work — they have delegated the labour and kept the judgement, which " +
            "is the part that was actually expensive to hand over."),
          read("Holding a department accountable without watching every move",
            "Accountability that requires constant supervision is not accountability — it is " +
            "supervision, and it does not scale past the number of people one person can watch " +
            "directly. The alternative is accountability through visible commitments and honest " +
            "reporting: clear ownership of each piece of work, a cadence where status is reported " +
            "rather than extracted, and a culture where a slipping deadline is raised BEFORE it slips " +
            "rather than explained after.\n\nThe hard part for a new lead is resisting the urge to " +
            "check in on everything, because checking in on everything trains a team to wait to be " +
            "asked rather than to report proactively — the exact opposite of the muscle you actually " +
            "need them to build. Trust granted deliberately, with a real consequence when it is " +
            "broken, scales; surveillance does not."),
          scenario("A department that has started missing deadlines",
            "You lead a department of eight. Deadlines have started slipping quietly — nobody raised a " +
            "flag until the day something was due. Write 400–600 words: what you change about how work " +
            "is reported (not just told), how you address it with the team without making everyone " +
            "feel distrusted, and what you would do differently for the NEXT commitment the department " +
            "makes.",
            ["Diagnoses the reporting gap rather than blaming individuals first",
             "Proposes a concrete mechanism (cadence, visible ownership) rather than 'communicate more'",
             "Addresses the team without defaulting to surveillance",
             "States what changes for the next commitment specifically, not just a general resolution"], 60),
        ],
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The paths. Order is enforced (`requires_previous`) — foundation before practitioner, and the
// lead track is its own path per department, mirroring the Web Dev seed's separate lead path.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PATHS: PathSpec[] = [
  {
    key: "seo-track", title: "SEO — foundations to practitioner", discipline: "SEO", level: "practitioner",
    unit: UNIT_SEO,
    summary: "What ranking rewards and what not to do, then SEM spend discipline and writing for a scanning reader.",
    courses: ["seo-foundations", "seo-sem-copy-practice"],
    certification: "SEO Practitioner", validMonths: 24,
  },
  {
    key: "seo-lead-path", title: "SEO — leading the department", discipline: "Management", level: "lead",
    unit: UNIT_SEO,
    summary: "Backlink judgement, honest reporting, and the promise a department cannot afford to make.",
    courses: ["seo-lead-track"],
  },
  {
    key: "gm-track", title: "GM — foundations to practitioner", discipline: "GM", level: "practitioner",
    unit: UNIT_GM,
    summary: "Reading a P&L and capacity, then pricing work profitably and the client conversation nobody wants to have.",
    courses: ["gm-foundations", "gm-practice"],
    certification: "GM Practitioner", validMonths: 24,
  },
  {
    key: "gm-lead-path", title: "GM — leading a department", discipline: "Management", level: "lead",
    unit: UNIT_GM,
    summary: "Delegation, the ball, and accountability without micromanagement — the general-management track everyone eventually grows into.",
    courses: ["gm-lead-track"],
  },
];

export interface SeoGmCurriculumResult {
  tenantId: string;
  courses: { created: string[]; existing: string[] };
  activities: number;
  paths: { created: string[]; existing: string[] };
}

export async function seedSeoGmCurriculum(companyName = AGENCY_NAME): Promise<SeoGmCurriculumResult> {
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
        // `requires_previous` TRUE throughout — steps stay in order, enforced rather than suggested.
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

/** Counted through withTenants, never withGlobal — see the header. Both unit ids, summed. */
export async function verifySeoGmCurriculum(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const out: Record<string, number> = {};
      const courses = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_courses WHERE unit_node_id = ANY($1)`, [[UNIT_SEO, UNIT_GM]],
      );
      const paths = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_paths WHERE unit_node_id = ANY($1)`, [[UNIT_SEO, UNIT_GM]],
      );
      const disciplines = await c.query<{ n: string }>(
        `SELECT count(DISTINCT discipline)::text AS n FROM lms_courses WHERE unit_node_id = ANY($1)`, [[UNIT_SEO, UNIT_GM]],
      );
      const quizzes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id = ANY($1) AND a.kind = 'quiz'`, [[UNIT_SEO, UNIT_GM]],
      );
      // The number that would betray a broken seed: a LAB authored before the runner exists makes
      // its whole path permanently uncompletable. Expected to be zero.
      const labs = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id = ANY($1) AND a.kind = 'lab'`, [[UNIT_SEO, UNIT_GM]],
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
  seedSeoGmCurriculum()
    .then(async (r) => {
      console.log("[seed:lms-seo-gm-curriculum] tenant", r.tenantId);
      console.log(`  courses    created=${r.courses.created.length} existing=${r.courses.existing.length}`);
      console.log(`  activities ${r.activities} written`);
      console.log(`  paths      created=${r.paths.created.length} existing=${r.paths.existing.length}`);
      const counts = await verifySeoGmCurriculum(r.tenantId);
      console.log("[seed:lms-seo-gm-curriculum] verified through withTenants:", JSON.stringify(counts));
      if (counts.courses === 0 || counts.paths === 0) {
        throw new Error(
          "[seed:lms-seo-gm-curriculum] verification read ZERO rows — the lms module scope was not " +
          "open. Nothing was written.",
        );
      }
      if (counts.labs > 0) {
        throw new Error(
          `[seed:lms-seo-gm-curriculum] ${counts.labs} lab activity(ies) exist. The lab RUNNER does ` +
          `not exist yet, so a required lab makes its whole path permanently uncompletable.`,
        );
      }
      console.log(
        "\nNOBODY IS ENROLLED. These paths are department paths, not mandatory ones — the relevant " +
        "head assigns them. Theory and quizzes only.",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:lms-seo-gm-curriculum] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
