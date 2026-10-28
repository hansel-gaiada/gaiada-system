// AIP-09 — the eval cases. SYNTHETIC MOCK TEXT ONLY: every company, person, figure and date below is invented for this file (cases.test.ts
// denies the real group and client names that appear in the repo's seed). Nothing here may be copied from a real thread, client or meeting.
//
// Totals: 6 compaction + 3 meeting (summarise = 9 cases), 7 social triage + 3 audit triage (classify = 10 cases). The default run
// sends each case once per tier: 19 x 2 = 38 gateway calls.
import type { ClassifyCase, SummaryCase } from "./score";

/** A compaction case: the excerpt is rendered exactly as `renderTranscript` does ("User: ..." / "Assistant: ..." lines). */
export interface CompactionCase extends SummaryCase {
  kind: "compaction";
  /** When set, the prompt takes the "fold into this EXISTING summary" branch of the production prompt. */
  existingSummary?: string;
}
export interface MeetingCase extends SummaryCase { kind: "hub" }

const lines = (...l: string[]): string => l.join("\n");

export const COMPACTION_CASES: readonly CompactionCase[] = [
  {
    id: "compaction-rebrand", task: "summarise", kind: "compaction",
    source: lines(
      "User: Arunika Studio wants to refresh its brand before the spring season. Where did we land on the logo?",
      "Assistant: Dewi shortlisted two options, A (a rising sun in outline) and B (a filled sun with a wordmark). Option B tested better with the focus group.",
      "User: Fine, go with option B. What is the agency fee again?",
      "Assistant: The quote is IDR 85 million for identity, guidelines and the first signage set.",
      "User: That is inside the budget. Dewi should sign it off on 14 March, and the new logo goes live on the website the week after.",
      "Assistant: Understood. One open question remains: whether the old logo stays on the van until the lease ends.",
    ),
    mustKeep: ["Arunika", ["option B", "second option", "second logo"], ["85 million", "85m", "85,000,000"], "Dewi", ["14 March", "March 14"]],
    mustNotAppear: [["95 million", "95m"], "option C"],
  },
  {
    id: "compaction-hiring", task: "summarise", kind: "compaction",
    source: lines(
      "User: Senja Furniture needs more hands in the warehouse before the festive rush.",
      "Assistant: Based on last year, three extra warehouse staff would cover the peak. Do you want me to draft the posting?",
      "User: Yes, three people, starting 1 June, at IDR 6.5 million a month each.",
      "Assistant: Noted. Komang will run the interviews. Should the posting mention forklift experience?",
      "User: Mention it as a plus, not a requirement. Applications close on 15 May.",
      "Assistant: Posting drafted with forklift experience listed as a plus, closing date 15 May.",
    ),
    mustKeep: ["Senja", ["three", "3"], ["1 June", "June 1"], ["6.5 million", "6,500,000"], "Komang", ["15 May", "May 15"]],
    mustNotAppear: [["7.5 million", "7,500,000"], ["four warehouse", "4 warehouse", "four extra", "4 extra"]],
  },
  {
    id: "compaction-ads", task: "summarise", kind: "compaction",
    source: lines(
      "User: How did the Biru Laut Cafe paid campaign do last month?",
      "Assistant: Spend was IDR 12 million. The Instagram ads had a click-through rate of 2.4 percent, the TikTok ads only 0.7 percent.",
      "User: That TikTok number is poor. Pause TikTok ads and move that money to Instagram.",
      "Assistant: Agreed, I will pause TikTok today. Putri suggested revisiting it on 20 May with new creative.",
      "User: Good. Keep the Instagram budget unchanged apart from the moved amount, and ask Putri to send the new creative brief.",
    ),
    mustKeep: ["Biru Laut", ["12 million", "12m", "12,000,000"], ["2.4"], ["0.7"], ["pause", "pausing", "halt", "stop"], "Putri", ["20 May", "May 20"]],
    mustNotAppear: [["3.4 percent", "3.4%"], ["15 million", "15m"]],
  },
  {
    id: "compaction-migration", task: "summarise", kind: "compaction",
    source: lines(
      "User: When is the Lumbung Tech database move to the new host?",
      "Assistant: Rahmat scheduled it for 9 November, starting at night. The expected downtime is 25 minutes.",
      "User: Customers will notice 25 minutes. Can we keep a rollback option?",
      "Assistant: Yes. The old host stays up for a 48 hour rollback window, and Rahmat owns the go or no-go call.",
      "User: Fine. Announce it to customers three days before, and do not touch the billing job that night.",
      "Assistant: I will draft the announcement. Open question: whether to freeze deployments for the whole week.",
    ),
    mustKeep: ["Lumbung", "Rahmat", ["9 November", "November 9"], ["25 minutes", "25 min"], ["48 hour", "48-hour", "48 h"]],
    mustNotAppear: [["90 minutes", "ninety minutes"], ["72 hour", "72-hour"]],
  },
  {
    id: "compaction-tradefair", task: "summarise", kind: "compaction",
    source: lines(
      "User: Kintamani Outfitters will exhibit at the outdoor trade fair. What do we have so far?",
      "Assistant: The fair is on 22 August in Denpasar. The booth is 3 by 6 metres and the organiser allows five staff passes.",
      "User: We should bring the new four-person tent as the centrepiece. Hana coordinates logistics.",
      "Assistant: Recorded: new four-person tent as the centrepiece, Hana on logistics. The shuttle vendor for the stock is still undecided.",
      "User: Right, the shuttle vendor is open. Decide by the end of next week.",
    ),
    mustKeep: ["Kintamani", ["22 August", "August 22"], "Denpasar", ["3 by 6", "3x6", "3 x 6", "3 metres by 6", "3m by 6m"], "Hana", "shuttle"],
    mustNotAppear: ["Surabaya", ["ten staff", "10 staff"]],
  },
  {
    id: "compaction-refund-merge", task: "summarise", kind: "compaction",
    existingSummary: "The user manages support for Tirta Water Filters and asked for help with order 7741, which arrived six days late.",
    source: lines(
      "User: The customer on order 7741 wants a refund. The filter cost USD 120.",
      "Assistant: The courier delay of six days qualifies for a full refund under your policy. Shall I draft the reply?",
      "User: Yes, approve the full refund, and offer a 10 percent voucher for the next order.",
      "Assistant: Drafted. Agnes will issue the refund by Friday.",
    ),
    mustKeep: ["Tirta", "7741", ["USD 120", "120 usd", "$120"], ["full refund", "refund"], ["10 percent", "10%", "10 per cent"], "Agnes"],
    mustNotAppear: [["USD 210", "$210"], ["20 percent", "20%"]],
  },
];

// ── long meeting transcripts: deterministic generators (so the file stays reviewable) ──────────────────────────────────────
// Filler is generic discussion with NO figures, dates, product names or decisions in it, so a fact in a summary can only come from a
// decision line. Decision lines are placed at fixed turns. Word count lands in 2,000-4,000 (cases.test.ts asserts it).
const FILLER: readonly string[] = [
  "I think we should look at this from the customer's point of view first, because the team has been talking about internal convenience for a while now and that is not what pays the bills.",
  "Let me add some context for the people who joined late. The earlier conversation went back and forth on the trade-offs, and nobody was fully happy with any single option on the table.",
  "That is a fair point, but I would like to see how much effort it really needs before we commit, since our experience is that estimates tend to grow once the work actually starts.",
  "From the support side we keep hearing the same few questions repeated, so whatever we choose needs to make those answers easier to find and easier to explain over the phone.",
  "I do not want to rush this. We have been burned before by moving quickly on something that looked simple, and then spending weeks cleaning up the edge cases afterwards.",
  "Can someone remind me what we agreed last time? I remember the discussion but not the outcome, and I would rather not reopen something that was already settled.",
  "The risk I see is mostly about coordination rather than technology. Too many people touch the same thing, and unless one person is clearly responsible, it drifts without anyone noticing.",
  "I hear the concern, and I would suggest we write it down and revisit it once we have more information, instead of trying to resolve every question in this one meeting.",
  "Honestly the feedback so far has been mixed. Some customers love the direction, others barely noticed, and a few were confused, which tells me our messaging needs more attention.",
  "We should not forget the quieter parts of the work either. Documentation, handover notes and small clean-ups do not look impressive but they save us a great deal of time later.",
  "I will take that on board. My only worry is that we promise more than the team can comfortably deliver, and then everyone ends up working long hours to make up the gap.",
  "Looking at the overall picture, things are in reasonable shape. There are a few loose ends, but nothing that threatens the plan if we keep an eye on it and communicate early.",
  "Just to push back gently, I am not sure that approach scales. It works while the group is small, but as soon as we add more people the manual steps become a real bottleneck.",
  "I appreciate everyone's patience. I know these sessions can run long, but getting alignment now saves us from a lot of private conversations and conflicting instructions later.",
  "One thing I would like to understand better is how the other teams see it. We make a lot of assumptions about their priorities without actually asking them directly very often.",
  "That reminds me of a similar situation a while ago. We moved ahead without a clear owner and the result was a long stretch of confusion that took real effort to untangle.",
  "I would argue we are underestimating the communication side. A good plan that nobody understands is worse than a decent plan that everyone can explain in their own words.",
  "Let us make sure we keep the scope tight. Every extra request sounds small by itself, but together they quietly double the workload and push everything else back.",
  "From a quality standpoint I would rather ship a smaller thing that works properly than a bigger thing with rough edges that we then have to apologise for in public.",
  "I think the group is mostly aligned in spirit, and the disagreement is really about sequencing. Once we settle the order of the work, the rest should fall into place naturally.",
  "A quick note on the process: whenever we change course, please tell the people affected directly instead of assuming they will read the notes after the meeting is over.",
  "I can see both sides here. The cautious route costs us some speed, and the fast route costs us some certainty, so it really comes down to which of the two we can afford.",
  "We have good momentum right now and I would hate to lose it by getting stuck on details. Let us agree on the principle and let the owner work out the specifics.",
  "My suggestion is to review this again in the next session with fresh eyes. Sometimes a night's sleep and a look at the actual numbers changes the tone of the conversation.",
  "The team has been stretched for a while, and I want to be honest that morale matters here. Clear priorities and fewer surprises would do more for us than any new tool.",
  "I would like to hear from someone who has not spoken yet. We tend to hear from the same few voices, and the quieter people often notice the practical problems first.",
  "On reflection I think the original instinct was right. We overcomplicated it in the middle of the discussion, and the simple version would have covered most of the real needs.",
  "Let me take the opposite view for a moment, only to test the idea. If this fails, what is the most likely reason, and would we see it coming early enough to react?",
  "Everything depends on the handover being smooth. The work itself is not unusual, but small gaps between teams have caused most of our delays in the past, not the hard problems.",
  "I do not have strong feelings either way, but I would like the reasoning recorded so that whoever picks this up later understands why we chose the way we did.",
  "Thanks for the clarification. That changes my view slightly, because I had assumed the constraint was fixed, and it sounds like there is actually some room to negotiate.",
  "We should also think about what happens afterwards. Launching is one thing, but keeping it running, answering questions and fixing small problems is the part that never ends.",
  "I will be direct: I think we are talking in circles. Can we agree what information we are missing, assign someone to get it, and move on to the next item?",
  "There is a lesson from the previous round that I want to carry over. Short check-ins with the people doing the work were far more useful than long reports sent upwards.",
  "I am comfortable with that as long as there is a clear point where we stop and review. An open-ended commitment is how projects quietly become permanent obligations.",
  "Let me summarise what I heard so far, and please correct me if I got it wrong. There is general support, a few concerns about timing, and a request for clearer ownership.",
  "The other thing worth saying is that the people closest to the customer should have a say. They see the reactions first and can tell us very quickly when something is off.",
  "I would rather we be transparent about the limits. Telling people what we cannot do builds more trust than promising everything and quietly missing half of it.",
  "That is a helpful example. It shows that the process mostly works and the failures are concentrated in a couple of predictable places that we can fix without a big redesign.",
  "We might be overthinking this. A small trial with a few friendly users would teach us more than another hour of speculation around this table, and it is cheap to run.",
];

function buildMeeting(opts: { title: string; speakers: string[]; topics: string[]; turns: number; decisions: Array<[number, string]> }): string {
  const decisionAt = new Map(opts.decisions.map(([i, t]) => [i, t]));
  const out: string[] = [`Meeting transcript: ${opts.title}`, ""];
  for (let i = 0; i < opts.turns; i++) {
    const speaker = opts.speakers[i % opts.speakers.length];
    const decision = decisionAt.get(i);
    const filler = FILLER[(i * 7 + opts.title.length) % FILLER.length];
    const topic = opts.topics[i % opts.topics.length];
    out.push(`${speaker}: ${decision ?? `On the question of ${topic}: ${filler}`}`);
  }
  return out.join("\n");
}

export const MEETING_CASES: readonly MeetingCase[] = [
  {
    id: "meeting-app-launch", task: "summarise", kind: "hub",
    source: buildMeeting({
      title: "Lumbung Tech, Orchid app launch planning",
      speakers: ["Rahmat", "Sinta", "Mira", "Bayu", "Citra"],
      topics: ["the launch timeline", "the beta programme", "marketing", "the feature scope", "support readiness"],
      turns: 80,
      decisions: [
        [18, "Decision on the launch date: we move the public launch to 18 November, and Rahmat owns the date from now on."],
        [37, "Decision on the beta: the beta is capped at 500 users, and Sinta owns invitations and the waiting list."],
        [56, "Decision on the budget: the marketing budget of IDR 240 million is approved, and Mira owns how it is spent."],
        [72, "Decision on scope: offline mode is dropped from version one, and Bayu owns telling the customers who asked for it."],
      ],
    }),
    mustKeep: [["18 November", "November 18"], "Rahmat", "500", "Sinta", ["240 million", "240m", "240,000,000"], "Mira", "offline", "Bayu"],
    mustNotAppear: [["25 November", "November 25"], ["420 million", "420m"], ["1000 users", "1,000 users"]],
  },
  {
    id: "meeting-ops-review", task: "summarise", kind: "hub",
    source: buildMeeting({
      title: "Senja Furniture, third quarter operations review",
      speakers: ["Wulan", "Komang", "Agus", "Hendra", "Laksmi", "Dian"],
      topics: ["the supply chain", "warehouse staffing", "product quality", "the showroom plan", "delivery times"],
      turns: 84,
      decisions: [
        [20, "Decision on suppliers: we switch our teak supply to Karya Kayu from 1 September, and Wulan owns the transition."],
        [40, "Decision on staffing: warehouse overtime is capped at 10 hours per person per week, and Komang owns the roster."],
        [58, "Decision on quality: the defect rate target is 2 percent for the next quarter, and Agus owns the weekly measurement."],
        [76, "Decision on expansion: the new showroom is postponed to the second quarter of next year, and Hendra owns the revised plan."],
      ],
    }),
    mustKeep: ["Karya Kayu", ["1 September", "September 1"], "Wulan", ["10 hours", "10 hour"], "Komang", ["2 percent", "2%", "2 per cent"], "Agus", "showroom", "Hendra"],
    mustNotAppear: ["Mitra Jati", ["15 hours", "15 hour"], ["5 percent", "5%", "5 per cent"]],
  },
  {
    id: "meeting-campaign-retro", task: "summarise", kind: "hub",
    source: buildMeeting({
      title: "Biru Laut Cafe, campaign retrospective",
      speakers: ["Putri", "Dimas", "Laras", "Eko", "Fitri"],
      topics: ["social content", "paid advertising", "the loyalty programme", "reporting", "the festive season"],
      turns: 82,
      decisions: [
        [17, "Decision on channels: we keep Instagram reels and we cut paid TikTok completely, and Putri owns the channel plan."],
        [36, "Decision on loyalty: the loyalty card launches on 3 December, and Dimas owns the launch."],
        [55, "Decision on money: the December advertising budget is IDR 60 million, and Laras owns the spending."],
        [73, "Decision on reporting: a short report goes out every Monday, and Eko owns producing it."],
      ],
    }),
    mustKeep: ["Instagram", "TikTok", "Putri", ["3 December", "December 3"], "Dimas", ["60 million", "60m", "60,000,000"], "Laras", "Monday", "Eko"],
    mustNotAppear: [["10 December", "December 10"], ["90 million", "90m"], "Facebook"],
  },
];

// ── classification ──────────────────────────────────────────────────────────────────────────────────────────────────────
const at = (n: number): string => `2026-05-${String(n).padStart(2, "0")}T09:00:00Z`;

export const SOCIAL_TRIAGE_CASES: readonly ClassifyCase[] = [
  {
    id: "triage-praise", task: "classify", kind: "social", network: "instagram", engagementName: "Biru Laut Cafe",
    messages: [{ authorHandle: "@sari_menulis", body: "Loved the new coconut latte, and the staff were so kind to my mum. We will be back every weekend!", postedAt: at(3) }],
    expected: { sentiment: "positive", category: "praise", urgency: "low" },
  },
  {
    id: "triage-broken-order", task: "classify", kind: "social", network: "facebook", engagementName: "Senja Furniture",
    messages: [
      { authorHandle: "Budi Santoso", body: "My coffee table arrived with the leg snapped in two. Order 5521.", postedAt: at(4) },
      { authorHandle: "Budi Santoso", body: "Nobody has answered my messages for three days. I want a refund today or I am disputing the payment.", postedAt: at(7) },
    ],
    expected: { sentiment: "negative", category: "complaint", urgency: "high" },
  },
  {
    id: "triage-shipping-question", task: "classify", kind: "social", network: "instagram", engagementName: "Kintamani Outfitters",
    messages: [{ authorHandle: "@rina.hikes", body: "Hi! Do you ship the trail backpack to Lombok? And roughly how many days does it take?", postedAt: at(5) }],
    expected: { sentiment: "neutral", category: "question", urgency: "normal" },
  },
  {
    id: "triage-spam-link", task: "classify", kind: "social", network: "tiktok", engagementName: "Biru Laut Cafe",
    messages: [{ authorHandle: "@promo_king_889", body: "WIN A FREE PHONE!!! Click bit.ly/x7Qq now and follow 5 pages to claim. Limited slots, hurry!!!", postedAt: at(6) }],
    expected: { sentiment: "neutral", category: "spam", urgency: "low" },
  },
  {
    id: "triage-size-complaint", task: "classify", kind: "social", network: "facebook", engagementName: "Kintamani Outfitters",
    messages: [{ authorHandle: "Made Wirawan", body: "The jacket runs a full size smaller than your chart says. A bit disappointing, I expected better from you.", postedAt: at(8) }],
    expected: { sentiment: "negative", category: "complaint", urgency: "normal" },
  },
  {
    id: "triage-positive-question", task: "classify", kind: "social", network: "instagram", engagementName: "Senja Furniture",
    messages: [{ authorHandle: "@ayu_home", body: "Absolutely love the new oak shelf collection! Is the narrow one also available in walnut?", postedAt: at(9) }],
    expected: { sentiment: "positive", category: "question", urgency: "normal" },
  },
  {
    id: "triage-safety", task: "classify", kind: "social", network: "facebook", engagementName: "Lumbung Tech",
    messages: [{ authorHandle: "Yohanes Pratama", body: "The charger from my order got very hot and started smoking and smelling of burning plastic last night. Please call me immediately, my children were in the room.", postedAt: at(10) }],
    expected: { sentiment: "negative", category: "complaint", urgency: "high" },
  },
];

export const AUDIT_TRIAGE_CASES: readonly ClassifyCase[] = [
  {
    id: "audit-broken-links", task: "classify", kind: "audit",
    findings: [
      { code: "BROKEN_LINKS", severity: "critical", category: "links", message: "48 internal links return HTTP 404", urlCount: 48 },
      { code: "MISSING_TITLE", severity: "high", category: "on-page", message: "Pages have no title element", urlCount: 12 },
      { code: "LONG_ALT", severity: "low", category: "images", message: "Image alt text longer than 125 characters", urlCount: 5 },
    ],
    expectedFixCodes: ["BROKEN_LINKS", "MISSING_TITLE", "LONG_ALT"], priorityCode: "BROKEN_LINKS",
  },
  {
    id: "audit-https", task: "classify", kind: "audit",
    findings: [
      { code: "LOW_WORD_COUNT", severity: "medium", category: "content", message: "Pages with fewer than 150 words", urlCount: 30 },
      { code: "MIXED_CONTENT", severity: "critical", category: "security", message: "HTTPS pages load scripts over HTTP, blocked by browsers", urlCount: 9 },
      { code: "DUP_META_DESC", severity: "medium", category: "on-page", message: "Duplicate meta descriptions across pages", urlCount: 18 },
    ],
    expectedFixCodes: ["LOW_WORD_COUNT", "MIXED_CONTENT", "DUP_META_DESC"], priorityCode: "MIXED_CONTENT",
  },
  {
    id: "audit-noindex", task: "classify", kind: "audit",
    findings: [
      { code: "NOINDEX_HOME", severity: "critical", category: "indexing", message: "The home page carries a noindex directive", urlCount: 1 },
      { code: "SLOW_LCP", severity: "high", category: "performance", message: "Largest contentful paint above 4 seconds", urlCount: 22 },
      { code: "H1_MISSING", severity: "low", category: "on-page", message: "Pages without an H1 heading", urlCount: 7 },
    ],
    expectedFixCodes: ["NOINDEX_HOME", "SLOW_LCP", "H1_MISSING"], priorityCode: "NOINDEX_HOME",
  },
];

export const CLASSIFY_CASES: readonly ClassifyCase[] = [...SOCIAL_TRIAGE_CASES, ...AUDIT_TRIAGE_CASES];
export const SUMMARISE_CASES: readonly (CompactionCase | MeetingCase)[] = [...COMPACTION_CASES, ...MEETING_CASES];
