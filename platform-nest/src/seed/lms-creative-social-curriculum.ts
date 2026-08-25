// THE CREATIVES + SOCIAL MEDIA CURRICULUM — foundation through lead (L4), modelled on
// `lms-webdev-curriculum.ts`.
//
// ── WHAT THIS WAVE DELIVERS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────
// STRUCTURE and THEORY: paths, courses, readings and graded quizzes/scenarios, ordered so a path
// cannot be taken out of sequence. That is L4, same as Web Dev.
//
// **NO `lab` ACTIVITIES ARE AUTHORED HERE**, for the same reason as the Web Dev curriculum: a
// `lab` is graded by a runner that does not exist yet. An activity marked `is_required` that
// nothing can ever pass makes its whole path permanently uncompletable, so this file uses only
// `quiz` and `scenario` activities.
//
// ── THE ORDER IS THE POINT ────────────────────────────────────────────────────────────────────
// Every path sets `requires_previous`, enforcing sequence rather than suggesting it.
//
// ── GRADING IS MIXED BY DISCIPLINE ────────────────────────────────────────────────────────────
// Anything judging taste, craft, or a client conversation — creative critique, a metrics readout,
// a costing decision, a client-facing report — is `kind: "scenario"`, `grading: "review"` with a
// rubric. An auto-gradeable proxy for "is this good design" or "was that the right client call"
// mostly is not one, and grading it automatically teaches people to satisfy the grader. Material
// with an actual right answer (file hygiene, platform mechanics, what a metric measures) is a
// `quiz`, `grading: "auto"`.
//
// ⚠ THE LMS WALL IS A THIRD GUC. Without `{ modules: ["lms"] }` every insert below writes ZERO
//   rows and reports success. Every call passes it, and the verification reads back through
//   withTenants for the same reason.
//
// ⚠ ANSWER KEYS LIVE IN `spec`. `GET /courses/:id` redacts them for anyone who is not authoring
//   the course (spec-redaction.ts). This file is where they are written.
//
// Idempotent, and it will NOT rewrite an existing course — somebody may have edited it and
// somebody else may be mid-way through it.
import { withTenants, withGlobal, closePool, newId } from "../db";

const AGENCY_NAME = "Gaia Digital Agency";
/** The two departments' org-blob node ids (`seed/roster.ts` AGENCY_DEPTS). */
const UNIT_CREATIVES = "d-creatives";
const UNIT_SOCIAL = "d-social";

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
  minutes: number; unit: string; modules: Mod[];
}
interface PathSpec {
  key: string; title: string; summary: string; discipline: string; level: Level; unit: string;
  courses: string[]; certification?: string; validMonths?: number;
}

/** Prose. `read` activities are participation — the quiz/scenario is what is graded. */
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
// CREATIVES — brief to concept, brand consistency, handover, feedback, video; lead: costing + scope.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const CREATIVE_COURSES: CourseSpec[] = [
  {
    key: "creatives-foundations", title: "Creatives foundations", discipline: "Creatives",
    level: "foundation", minutes: 150, unit: UNIT_CREATIVES,
    summary: "From a client brief to a concept you can defend, and why a brief with gaps gets filled with guesses.",
    modules: [
      {
        title: "Brief to concept",
        summary: "Reading a brief for what it does not say, and turning it into a direction you can present.",
        activities: [
          read("A brief is a starting argument, not a spec",
            "A client brief tells you what they think the problem is, in their own words, which is not " +
            "the same thing as the problem. \"Make it look more premium\" is a reaction to something, " +
            "not a design instruction, and the job before any concept work starts is finding what that " +
            "something was.\n\nThe practical move is to restate the brief back in your own words before " +
            "you sketch anything: audience, the one thing this piece has to do, and the constraint that " +
            "matters most (budget, timeline, existing brand assets). If the client's reaction to your " +
            "restatement is \"yes, exactly\" you have earned the right to start concepting. If it is " +
            "\"sort of\" you have just found the gap that would otherwise have surfaced in round three " +
            "of revisions, at triple the cost."),
          read("Concept before craft",
            "A polished mockup of the wrong idea is more expensive to kill than a rough one, because " +
            "people defend things they have already invested time in — including you. Bring a concept " +
            "to a client as a rough idea (a mood board, three thumbnails, a one-line direction) before " +
            "you invest hours in a finished comp.\n\nThe reason this matters commercially, not just " +
            "creatively: a client who rejects a five-minute sketch costs you five minutes. A client who " +
            "rejects a finished, billed asset costs you the asset, the goodwill, and the argument about " +
            "who eats the hours."),
          quiz("Brief to concept — check", [
            q("cf-1", "A client says \"make it more premium\". What is the correct first move?",
              ["Add gold foil and serif fonts", "Restate what problem you think that reaction is pointing at, and confirm it",
               "Ask for a bigger budget", "Start three concepts immediately"], 1,
              "\"Premium\" is a reaction, not an instruction. Confirming the restatement finds the gap before round three."),
            q("cf-2", "Why bring a rough concept before a polished comp?",
              ["It is faster to produce", "A client rejecting a five-minute sketch costs five minutes; rejecting a finished asset costs the asset and the goodwill",
               "Clients prefer sketches", "It looks more artistic"], 1,
              "People defend things they have already invested time in — including the designer."),
            q("cf-3", "The client's reaction to your restatement of the brief is \"sort of\". What does that mean?",
              ["Proceed anyway, it is close enough", "You have found a gap that would otherwise surface in revisions, at higher cost",
               "The client is being difficult", "Restart the whole brief"], 1,
              "Finding the gap now is the entire value of the restatement step."),
            q("cf-4", "What is a brief, structurally?",
              ["A spec you execute literally", "The client's own words for what they think the problem is",
               "A legal document", "A creative constraint only"], 1,
              "Which is why it needs interpretation, not just execution."),
          ]),
        ],
      },
    ],
  },
  {
    key: "creatives-practice", title: "Creatives in practice", discipline: "Creatives",
    level: "practitioner", minutes: 220,
    unit: UNIT_CREATIVES,
    summary: "Brand consistency across deliverables, file and asset hygiene, and knowing when to stop revising.",
    modules: [
      {
        title: "Consistency and hygiene",
        activities: [
          read("Brand consistency is a system, not a memory",
            "Nobody holds an entire brand's rules in their head across fifty deliverables made over a " +
            "year by three different people. What holds it together is the brand guideline document " +
            "and the shared asset library — the actual logo files, the actual approved colour values, " +
            "the actual type files — not a screenshot of last month's Instagram post used as a colour " +
            "reference.\n\nWhen you cannot find the source asset, that is a signal to go find it, not a " +
            "licence to eyeball the colour from a JPEG that has already been compressed and colour-" +
            "shifted twice. A brand that drifts by 2% per deliverable is unrecognisable after twenty."),
          read("File and asset hygiene is the handover, not admin",
            "A project file with unlabelled layers, missing linked assets, and fonts that are not " +
            "packaged is a file that only you can open successfully — and the day you are on leave, or " +
            "the client asks for a resize eighteen months later, that file has to work for somebody " +
            "else.\n\nThe naming and folder structure this agency uses is not bureaucracy; it is the " +
            "difference between a five-minute handover and someone rebuilding your work from a flattened " +
            "export because the source file is unusable. Package fonts, embed or link assets correctly, " +
            "name layers for what they are, and version the file — before you consider it delivered."),
          read("Feedback rounds have a floor and a ceiling",
            "Two or three structured rounds surface the real objections; round seven is usually taste " +
            "dressed up as feedback, from a stakeholder who was not in round one. The fix is not " +
            "refusing revisions — it is agreeing the number of rounds and who gives feedback BEFORE " +
            "work starts, so \"one more small thing\" has a name (scope) instead of being invisible.\n\n" +
            "The harder skill is recognising when to stop matching feedback and start pushing back: if " +
            "round four contradicts round two, the client is not converging on an answer, they are " +
            "workshopping in public on your time, and that conversation belongs to the account lead, " +
            "not to another silent revision."),
          quiz("Creatives practice — check", [
            q("cp-1", "You need the brand's exact blue. The only reference at hand is a compressed Instagram screenshot. What do you do?",
              ["Eyeball the colour from the screenshot", "Find the source asset or the guideline's approved value",
               "Use a similar blue", "Ask the client to confirm by eye"], 1,
              "A brand that drifts a little per deliverable is unrecognisable after twenty."),
            q("cp-2", "A project file has unpackaged fonts and unlabelled layers. What is the actual cost?",
              ["Slightly messy but harmless", "Only you can open it successfully — a future resize or handover breaks",
               "Faster file size", "Nothing, if you remember the structure"], 1,
              "The file has to work for somebody else eighteen months from now, not just for you today."),
            q("cp-3", "Round four of feedback contradicts round two. What is actually happening?",
              ["Normal iteration", "The client is workshopping in public rather than converging — escalate to the account lead",
               "You did something wrong in round three", "More rounds always improve the work"], 1,
              "That conversation belongs to the account lead, not another silent revision."),
            q("cp-4", "When should the number of feedback rounds be agreed?",
              ["After the first round, once you see how it goes", "Before work starts",
               "Never — it should stay flexible", "Only for large projects"], 1,
              "So 'one more small thing' has a name — scope — instead of being invisible."),
          ]),
        ],
      },
    ],
  },
  {
    key: "creatives-video", title: "Video: pacing and captions", discipline: "Creatives",
    level: "practitioner", minutes: 160,
    unit: UNIT_CREATIVES,
    summary: "Cutting for attention, and captions as a requirement rather than an afterthought.",
    modules: [
      {
        title: "Pacing and access",
        activities: [
          read("Pacing is decided by the platform, not by taste",
            "A video edited for a cinema screen and a video edited for a feed scrolled at arm's length " +
            "are different objects even if every shot is the same. Feed video has to earn the next " +
            "second, repeatedly, from the first frame — which means the cut is faster, the hook is " +
            "first, and a slow establishing shot that would work in a brand film reads as dead air and " +
            "gets scrolled past.\n\nThe test is not \"does this look good paused\"; it is \"would this " +
            "survive being watched on mute, at 1.5x, by someone who has already scrolled past ten other " +
            "videos this minute.\""),
          read("Captions are a requirement, not a subtitle track",
            "Most social video is watched with sound off — on a commute, in a meeting, in bed next to " +
            "someone asleep. A video with no captions is, for that majority of viewers, a silent video: " +
            "the message simply does not arrive.\n\nCaptions are also an accessibility floor, not an " +
            "optional add-on for deaf and hard-of-hearing viewers, and burned-in captions travel with " +
            "the file in a way platform auto-captions (which are frequently wrong on names, brands and " +
            "accents) do not. Caption for what the client's brand and product names actually are, not " +
            "what a speech model guesses they are."),
          quiz("Video pacing and captions — check", [
            q("vp-1", "A slow establishing shot works in a brand film but not in a feed cut. Why?",
              ["Feed video is lower resolution", "Feed video must earn the next second repeatedly from frame one",
               "Feed video is always shorter", "It is a client preference only"], 1,
              "A slow open reads as dead air and gets scrolled past before the hook lands."),
            q("vp-2", "What is the real test for whether a cut works on social?",
              ["Does it look good paused", "Would it survive being watched on mute, at speed, mid-scroll",
               "Does it match the brief word for word", "Is it under 30 seconds"], 1,
              "That is the actual viewing condition for most feed video."),
            q("vp-3", "Why not rely on platform auto-captions?",
              ["They cost extra", "They are frequently wrong on names, brands and accents",
               "They are slower to generate", "They do not support all languages"], 1,
              "Caption for what the names actually are, not what a speech model guesses."),
            q("vp-4", "Why are captions not optional?",
              ["They improve SEO only", "Most social video is watched with sound off — no captions means no message for that majority",
               "Only deaf viewers need them", "They are a platform requirement only"], 1,
              "For a large share of viewers a caption-less video is functionally silent."),
          ]),
        ],
      },
    ],
  },
  {
    key: "creatives-lead", title: "Leading Creatives", discipline: "Creatives",
    level: "lead", minutes: 220, unit: UNIT_CREATIVES,
    summary: "Costing a creative job honestly, and protecting the team from scope creep — the management tier.",
    modules: [
      {
        title: "Costing and scope",
        activities: [
          read("A quote is a bet on revisions, not just on hours",
            "The making of a first draft is the predictable part of a creative job's cost; the " +
            "unpredictable part is how many rounds it takes to land, and that is exactly the part most " +
            "quotes leave out. A quote that only prices the making, not the converging, is a quote that " +
            "loses money the moment feedback gets political.\n\nPrice the number of structured rounds " +
            "explicitly, price extra rounds as a named add-on rather than an implied freebie, and build " +
            "in a contingency line for \"stakeholder joins in round three\" — because on a long enough " +
            "timeline, one always does."),
          scenario("Cost a real job",
            "A client wants a 15-piece social campaign (5 static, 5 carousel, 5 short-form video) with " +
            "two brand-new products they have not photographed yet. Write 350-500 words: how you would " +
            "cost it (what varies the estimate most), how many feedback rounds you would quote and why, " +
            "and one clause you would put in writing before starting.",
            ["Identifies what actually drives the estimate (asset readiness, round count) rather than just piece count",
             "States a specific number of rounds and the reasoning, not 'as needed'",
             "Names a concrete written clause, not a vague 'clear scope'",
             "Treats missing product photography as a cost driver, not an assumption"], 60),
          read("Scope creep arrives disguised as a small ask",
            "\"Can you also just...\" is how almost every scope overrun starts, because each individual " +
            "ask really is small. The damage is cumulative and invisible to the person asking, who only " +
            "ever sees their one small thing — never the six other small things three other " +
            "stakeholders also asked for this week.\n\nThe lead's job is to make the accumulation " +
            "visible: log every \"just one more thing\" against the scope document in writing, even " +
            "when you say yes to it, so that the fifth one has a paper trail instead of feeling like the " +
            "first."),
          scenario("Protect the team from a creeping brief",
            "A designer on your team tells you the client has asked for 'one more small tweak' four " +
            "times this week on a fixed-price job, each time over chat, none of it in the scope " +
            "document. Write 300-500 words: what you say to the client, what you tell the designer to do " +
            "differently starting now, and how you decide whether this batch of asks gets billed.",
            ["Distinguishes what is said to the client from what is said internally to the team",
             "Proposes a concrete change to how requests are logged going forward",
             "Makes an actual billing call rather than deferring it indefinitely",
             "Protects the designer's time without being adversarial toward the client"], 60),
        ],
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════════════════════
// SOCIAL MEDIA — platform-native formats, a calendar that survives contact, community management,
// metrics, crisis handling; lead: reporting without vanity metrics.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const SOCIAL_COURSES: CourseSpec[] = [
  {
    key: "social-foundations", title: "Social Media foundations", discipline: "Social Media",
    level: "foundation", minutes: 150, unit: UNIT_SOCIAL,
    summary: "Platform-native formats, and a content calendar that survives contact with a real client.",
    modules: [
      {
        title: "Native, not repurposed",
        activities: [
          read("A reposted format is a worse format",
            "Content shot vertically for TikTok, cropped to fit a square Instagram grid, then re-" +
            "exported for a landscape Facebook feed is technically present on all three platforms and " +
            "performing on none of them — because each platform's audience has learned what native " +
            "content on that platform looks like, and a cropped-down version reads as an afterthought " +
            "even when the content is good.\n\nNative-first means deciding the primary platform for a " +
            "piece before shooting it, then deliberately re-cutting (not just re-cropping) for the " +
            "others: different pacing, different caption length, different hook for the first frame, " +
            "because the scroll behaviour differs by platform even for the same audience."),
          read("A content calendar is a commitment device, not a wish list",
            "A calendar built once a month and never revisited is a plan for a world that stopped " +
            "changing on the day it was written — and a client's actual news (a launch delay, a PR " +
            "issue, a competitor's move) does not wait for the next planning cycle.\n\nA calendar that " +
            "survives contact with a client has two properties: it names WHO approves each post and by " +
            "WHEN (so \"waiting on approval\" cannot silently eat the posting window), and it has a " +
            "standing slot for reactive content, because the plan that has no room for reality gets " +
            "abandoned the first time reality shows up."),
          quiz("Native formats and calendars — check", [
            q("sf-1", "Why does a cropped-down TikTok video underperform on Instagram and Facebook?",
              ["Lower resolution", "Each platform's audience expects native pacing, hook and format, and a crop reads as an afterthought",
               "Algorithms penalise reposts explicitly", "It is a myth — content performs the same everywhere"], 1,
              "Native-first means re-cutting for each platform's scroll behaviour, not just resizing the frame."),
            q("sf-2", "A calendar is built once a month and never revisited. What is the risk?",
              ["Extra admin work", "It is a plan for a world that stopped changing, with no room for real client news",
               "Posts go out too early", "Nothing, if the content is good"], 1,
              "A launch delay or a PR issue does not wait for the next planning cycle."),
            q("sf-3", "What must a calendar name to avoid silently losing the posting window?",
              ["The hashtag strategy only", "Who approves each post and by when",
               "The exact caption text a month ahead", "The client's logo usage rules"], 1,
              "Waiting on approval cannot silently eat the window if the deadline is named."),
            q("sf-4", "Why does a calendar need a standing reactive slot?",
              ["To fill space", "Because a plan with no room for reality gets abandoned the first time reality shows up",
               "To reduce the total post count", "It is a platform requirement"], 1,
              "Client news does not wait for the next planning cycle."),
          ]),
        ],
      },
    ],
  },
  {
    key: "social-practice", title: "Social Media in practice", discipline: "Social Media",
    level: "practitioner", minutes: 220,
    unit: UNIT_SOCIAL,
    summary: "Community management and escalation, and what a metric actually tells you.",
    modules: [
      {
        title: "The community, and the numbers",
        activities: [
          read("Every comment is a small decision about escalation",
            "Most comments are answerable on the spot, in the brand's voice, within the response-time " +
            "target. A smaller set are not: a legal threat, a safety complaint, a public accusation " +
            "against the client, or a request that touches money — and answering those on the spot, " +
            "even politely, can commit the client to something nobody senior has agreed to.\n\nThe " +
            "practical rule: if replying could be read later as the brand making a promise, an " +
            "admission, or a policy statement, it goes to the account lead first, and the public holding " +
            "reply in the meantime is calm and generic on purpose — \"we've seen this and are looking " +
            "into it\" buys the hours a considered reply needs."),
          read("Reach, engagement and conversion are not the same claim",
            "Reach says how many people the content was shown to. Engagement says how many of them did " +
            "something — like, comment, share, save. Conversion says how many did the thing the " +
            "business actually wanted — visited the site, messaged to book, bought. A campaign can win " +
            "on any one of these and lose on the others, and reporting only the biggest number, " +
            "regardless of which one it is, is how a client ends up believing a campaign worked when the " +
            "business outcome did not move.\n\nThe question to ask before quoting any number is \"what " +
            "decision would this number change\" — a reach number that cannot inform a single decision " +
            "is decoration, however large it is."),
          scenario("Read a real result",
            "A post got 40,000 reach, 200 likes, 3 comments, and 1 tracked click to the client's site. " +
            "Write 300-450 words: what does this combination actually tell you about the content and " +
            "the audience, what does it NOT tell you, and what would you tell the client this result " +
            "means for their goal (assume the goal was bookings).",
            ["Distinguishes reach, engagement and conversion as separate claims, not one story",
             "States plainly what the numbers do not prove, not only what they do",
             "Connects the result to the stated business goal (bookings), not to vanity metrics",
             "Avoids overclaiming a small click count as a success or failure without context"], 45),
          quiz("Community and metrics — check", [
            q("sp-1", "A commenter makes a legal threat in public. What is the right immediate move?",
              ["Answer it fully and in detail on the spot", "Post a calm holding reply and escalate to the account lead before committing to anything",
               "Delete the comment", "Ignore it — it will pass"], 1,
              "Answering on the spot can commit the client to something nobody senior has agreed to."),
            q("sp-2", "A post has huge reach but almost no clicks toward the stated goal. What does high reach prove?",
              ["The campaign worked", "That the content was shown widely — nothing about whether it moved the business outcome",
               "That engagement was also high", "That the audience is wrong"], 1,
              "Reach, engagement and conversion are separate claims; a campaign can win on one and lose on the others."),
            q("sp-3", "What question should precede quoting any metric to a client?",
              ["Is this the biggest number available?", "What decision would this number change?",
               "Does this look impressive?", "Is this the platform's own number?"], 1,
              "A number that cannot inform a decision is decoration regardless of its size."),
            q("sp-4", "Why not answer every comment fully and immediately, in the brand voice?",
              ["It takes too long", "Some comments (legal, safety, financial) can commit the brand to something before anyone senior has weighed in",
               "It looks robotic", "Only some comments deserve a reply"], 1,
              "The holding reply buys the hours a considered reply needs, without a premature commitment."),
          ]),
        ],
      },
    ],
  },
  {
    key: "social-crisis", title: "Crisis and complaint handling", discipline: "Social Media",
    level: "practitioner", minutes: 150,
    unit: UNIT_SOCIAL,
    summary: "The difference between a complaint and a crisis, and why the first public reply matters most.",
    modules: [
      {
        title: "When it goes public",
        activities: [
          read("A complaint and a crisis are not the same event",
            "A complaint is one person, one experience, one channel — it is handled, apologised for if " +
            "warranted, and resolved, usually within the day. A crisis is when the SAME complaint starts " +
            "arriving from multiple people, multiple channels, or gets picked up by an account with " +
            "reach the client does not control — at which point the response is no longer about one " +
            "customer, it is about what the brand's silence or reply signals to everyone watching.\n\n" +
            "Mistaking a crisis for a complaint means replying once, privately, and considering it closed " +
            "— while the public thread keeps growing because nobody addressed it where people could see " +
            "it not being addressed."),
          read("The first public reply sets the tone for everyone who reads the thread after",
            "The first reply to a public complaint is read by far more people than the resolution — " +
            "most readers never scroll to see how it ended, they judge the brand by how it opened. A " +
            "defensive first reply, even a factually correct one, reads as the brand fighting a " +
            "customer.\n\nThe safer first move: acknowledge without admitting fault you have not yet " +
            "established, name that you are looking into it, and move the specifics to a private " +
            "channel. This is not stalling — it is separating \"the brand is listening\" (which has to " +
            "happen fast, in public) from \"the brand has a considered answer\" (which should not be " +
            "improvised in a comment thread)."),
          quiz("Crisis and complaint handling — check", [
            q("cc-1", "What turns a complaint into a crisis?",
              ["The customer being upset", "The same complaint spreading across multiple people, channels, or a high-reach account",
               "The client being unhappy about it", "It happening on a weekend"], 1,
              "At that point the response is about what the brand signals to everyone watching, not just to one customer."),
            q("cc-2", "You reply once privately to a complaint that is also growing publicly. What is the risk?",
              ["None — it is resolved", "The public thread keeps growing because nobody addressed it where it could be seen",
               "The customer will complain again", "It looks unprofessional"], 1,
              "A private-only resolution to a public complaint leaves the visible silence unaddressed."),
            q("cc-3", "Why does the FIRST public reply matter more than the eventual resolution?",
              ["It is legally required to be fast", "Most readers never scroll to see how it ended — they judge the brand by how it opened",
               "It affects SEO", "The algorithm rewards speed only"], 1,
              "The opening reply is read by far more people than the resolution."),
            q("cc-4", "What should a good first public reply do?",
              ["Fully resolve the issue on the spot", "Acknowledge, avoid admitting unestablished fault, and move specifics private",
               "Defend the brand's position in detail", "Ask the commenter to delete their post"], 1,
              "Separates 'we are listening' (fast, public) from 'we have a considered answer' (not improvised in a thread)."),
          ]),
        ],
      },
    ],
  },
  {
    key: "social-lead", title: "Leading Social Media", discipline: "Social Media",
    level: "lead", minutes: 200, unit: UNIT_SOCIAL,
    summary: "Reporting to a client without vanity metrics — the management tier.",
    modules: [
      {
        title: "Reporting that survives scrutiny",
        activities: [
          read("A vanity metric is any number chosen because it is big, not because it is relevant",
            "Total impressions across a quarter is almost always the largest number available, which " +
            "is exactly why it is tempting to lead a report with it — and exactly why it is usually the " +
            "wrong number to lead with. If the client's actual goal was leads, bookings or sales, a " +
            "report that opens with impressions is answering a question nobody asked.\n\nThe fix is not " +
            "hiding the big number; it is ordering the report by the client's stated goal first, with " +
            "impressions and reach as supporting context for HOW the result was achieved, never as the " +
            "headline for whether it worked."),
          read("A flat month needs the same report as a good one",
            "The temptation in a slow month is to reach for whatever number went up, however irrelevant, " +
            "and lead with that instead. This trains the client to distrust every report, because they " +
            "eventually notice the metric being reported changes depending on which one looks good that " +
            "month.\n\nThe credible move is to report the same metrics every month, on the same goal, " +
            "and say plainly when a number is down and what you think caused it. A lead who can say " +
            "\"this was a flat month, here's why, here's what we're changing\" keeps the client's trust " +
            "longer than one who can always find something to celebrate."),
          scenario("Write the honest version of a bad month",
            "Engagement and click-throughs both dropped 30% this month against a flat ad spend, while " +
            "follower count and total impressions both rose. The account lead below you wants to lead " +
            "the client report with follower growth. Write 350-500 words: what you tell them to report " +
            "and why, what you say to the client about the drop, and what (if anything) changes for next " +
            "month.",
            ["Rejects leading with an irrelevant metric even though a genuine number did go up",
             "States the drop plainly to the client rather than burying it under a better-looking number",
             "Proposes a specific next step, not just an explanation",
             "Coaches the account lead's judgement rather than just overriding the decision"], 60),
        ],
      },
    ],
  },
];

const COURSES: CourseSpec[] = [...CREATIVE_COURSES, ...SOCIAL_COURSES];

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The paths. Order is enforced (`requires_previous`), department paths (`is_mandatory: false` —
// assigned by the department head, not company-mandatory).
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PATHS: PathSpec[] = [
  {
    key: "creatives-track", title: "Creatives — the craft", discipline: "Creatives", level: "practitioner",
    unit: UNIT_CREATIVES,
    summary: "Brief to concept, then brand consistency, hygiene, feedback rounds and video pacing.",
    courses: ["creatives-foundations", "creatives-practice", "creatives-video"],
    certification: "Creatives Practitioner", validMonths: 24,
  },
  {
    key: "creatives-lead-path", title: "Creatives — leading the department", discipline: "Creatives", level: "lead",
    unit: UNIT_CREATIVES,
    summary: "The management tier: costing a job honestly and protecting the team from scope creep.",
    courses: ["creatives-foundations", "creatives-practice", "creatives-lead"],
  },
  {
    key: "social-track", title: "Social Media — the craft", discipline: "Social Media", level: "practitioner",
    unit: UNIT_SOCIAL,
    summary: "Native formats and a calendar that survives contact, then community management, metrics and crisis handling.",
    courses: ["social-foundations", "social-practice", "social-crisis"],
    certification: "Social Media Practitioner", validMonths: 24,
  },
  {
    key: "social-lead-path", title: "Social Media — leading the department", discipline: "Social Media", level: "lead",
    unit: UNIT_SOCIAL,
    summary: "The management tier: reporting to a client without vanity metrics.",
    courses: ["social-foundations", "social-practice", "social-lead"],
  },
];

export interface CreativeSocialCurriculumResult {
  tenantId: string;
  courses: { created: string[]; existing: string[] };
  activities: number;
  paths: { created: string[]; existing: string[] };
}

export async function seedCreativeSocialCurriculum(companyName = AGENCY_NAME): Promise<CreativeSocialCurriculumResult> {
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

/** Counted through withTenants, never withGlobal — see the header. Sums both department units. */
export async function verifyCreativeSocialCurriculum(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const out: Record<string, number> = {};
      const courses = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_courses WHERE unit_node_id IN ($1,$2)`,
        [UNIT_CREATIVES, UNIT_SOCIAL],
      );
      const paths = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_paths WHERE unit_node_id IN ($1,$2)`,
        [UNIT_CREATIVES, UNIT_SOCIAL],
      );
      const disciplines = await c.query<{ n: string }>(
        `SELECT count(DISTINCT discipline)::text AS n FROM lms_courses WHERE unit_node_id IN ($1,$2)`,
        [UNIT_CREATIVES, UNIT_SOCIAL],
      );
      const quizzes = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'quiz'`,
        [UNIT_CREATIVES, UNIT_SOCIAL],
      );
      // The number that would betray a broken seed: a LAB authored before the runner exists makes
      // its whole path permanently uncompletable. Expected to be zero until L5.
      const labs = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'lab'`,
        [UNIT_CREATIVES, UNIT_SOCIAL],
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
  seedCreativeSocialCurriculum()
    .then(async (r) => {
      console.log("[seed:lms-creative-social-curriculum] tenant", r.tenantId);
      console.log(`  courses    created=${r.courses.created.length} existing=${r.courses.existing.length}`);
      console.log(`  activities ${r.activities} written`);
      console.log(`  paths      created=${r.paths.created.length} existing=${r.paths.existing.length}`);
      const counts = await verifyCreativeSocialCurriculum(r.tenantId);
      console.log("[seed:lms-creative-social-curriculum] verified through withTenants:", JSON.stringify(counts));
      if (counts.courses === 0 || counts.paths === 0) {
        throw new Error(
          "[seed:lms-creative-social-curriculum] verification read ZERO rows — the lms module scope " +
          "was not open. Nothing was written.",
        );
      }
      if (counts.labs > 0) {
        throw new Error(
          `[seed:lms-creative-social-curriculum] ${counts.labs} lab activity(ies) exist. The lab ` +
          `RUNNER does not exist yet, so a required lab makes its whole path permanently uncompletable.`,
        );
      }
      console.log(
        "\nNOBODY IS ENROLLED. These paths are department paths, not mandatory ones — the head " +
        "assigns them. Theory, quizzes and reviewed scenarios only.",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:lms-creative-social-curriculum] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
