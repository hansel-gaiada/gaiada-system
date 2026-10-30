// SCP-5 W5-A2 — the monthly draft's prompt, template and parse, pinned byte for byte as SCP-5a built them, so that making the
// notes' areas and the action plan's limit come from the report's own rules (W5-A2) cannot change the monthly report.
import { describe, it, expect } from "vitest";
import { buildMonthlyReportDraftPrompt, parseMonthlyReportDraft, templateActionPlan, templateNotes } from "./report-notes";

const facts = {
  engagementName: "Eng", clientName: "Client", periodLabel: "2026-09-01 – 2026-09-30",
  kpis: [{ label: "Followers", value: 100, unit: "count" }, { label: "Engagement rate", value: 4.5, unit: "percent" }],
  topPosts: [], knowledgeHits: [],
};

describe("the monthly draft, as SCP-5a built it", () => {
  it("the prompt", () => {
    expect(buildMonthlyReportDraftPrompt(facts)).toMatchInlineSnapshot(`
      "You are writing the narrative summary section of a social-media performance report for "Client" (engagement "Eng"), covering 2026-09-01 – 2026-09-30.

      Here are the ONLY numbers you may reference, exactly as given. Do not invent, estimate, round differently, or restate any number not in this list:
      - Followers: 100 count
      - Engagement rate: 4.5 percent

      Write three things in this brand's voice:
      1. narrative: 2-4 short paragraphs summarizing performance for the period.
      2. notes: for each of the areas followers, engagement and audience, one insight (what the numbers show, at most 500 characters) and one suggestion (what to do about it, at most 500 characters).
      3. actionPlan: 2 to 5 concrete next steps (each at most 300 characters), each owned by "agency" or "client".

      NEVER state a number you were not given above, and never imply a metric was zero just because it was not mentioned: say it has not been fetched yet instead. Never suggest generating or attaching an image: this system has no image-generation capability.

      Reply with STRICT JSON only, no prose, no markdown fences: {"narrative": "...", "notes": {"followers": {"insight": "...", "suggestion": "..."}, "engagement": {"insight": "...", "suggestion": "..."}, "audience": {"insight": "...", "suggestion": "..."}}, "actionPlan": [{"action": "...", "owner": "agency"}]}"
    `);
  });
  it("the template", () => {
    expect({ notes: templateNotes(facts), plan: templateActionPlan(), parsed: parseMonthlyReportDraft(null, facts) }).toMatchInlineSnapshot(`
      {
        "notes": {
          "audience": {
            "insight": "Reach has not been fetched for 2026-09-01 – 2026-09-30 yet.",
            "suggestion": "Review the posting times against when the audience is most active.",
          },
          "engagement": {
            "insight": "The engagement rate was 4.5% for 2026-09-01 – 2026-09-30.",
            "suggestion": "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
          },
          "followers": {
            "insight": "Followers stood at 100 at the end of 2026-09-01 – 2026-09-30.",
            "suggestion": "Keep to the agreed posting schedule and note which formats bring in new followers.",
          },
        },
        "parsed": {
          "actionPlan": [
            {
              "action": "Review the month's best-performing posts and plan more in the same formats.",
              "owner": "agency",
            },
            {
              "action": "Confirm next month's priorities, promotions and key dates.",
              "owner": "client",
            },
          ],
          "draftedVia": "template",
          "narrativeMd": "Performance summary for Client — 2026-09-01 – 2026-09-30. Followers: 100 count. Engagement rate: 4.5 percent.",
          "notes": {
            "audience": {
              "insight": "Reach has not been fetched for 2026-09-01 – 2026-09-30 yet.",
              "suggestion": "Review the posting times against when the audience is most active.",
            },
            "engagement": {
              "insight": "The engagement rate was 4.5% for 2026-09-01 – 2026-09-30.",
              "suggestion": "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
            },
            "followers": {
              "insight": "Followers stood at 100 at the end of 2026-09-01 – 2026-09-30.",
              "suggestion": "Keep to the agreed posting schedule and note which formats bring in new followers.",
            },
          },
        },
        "plan": [
          {
            "action": "Review the month's best-performing posts and plan more in the same formats.",
            "owner": "agency",
          },
          {
            "action": "Confirm next month's priorities, promotions and key dates.",
            "owner": "client",
          },
        ],
      }
    `);
  });
  it("a good answer, an invented number and a missing area", () => {
    const good = {
      narrative: "A steady month for the brand.",
      notes: {
        followers: { insight: "Followers stood at 100.", suggestion: "Keep going." },
        engagement: { insight: "Rate was 4.5%.", suggestion: "Reply fast." },
        audience: { insight: "Local.", suggestion: "Lunchtime." },
      },
      actionPlan: [{ action: "Plan reels.", owner: "agency" }],
    };
    expect(parseMonthlyReportDraft(JSON.stringify(good), facts)).toMatchInlineSnapshot(`
      {
        "actionPlan": [
          {
            "action": "Plan reels.",
            "owner": "agency",
          },
        ],
        "draftedVia": "ai",
        "narrativeMd": "A steady month for the brand.",
        "notes": {
          "audience": {
            "insight": "Local.",
            "suggestion": "Lunchtime.",
          },
          "engagement": {
            "insight": "Rate was 4.5%.",
            "suggestion": "Reply fast.",
          },
          "followers": {
            "insight": "Followers stood at 100.",
            "suggestion": "Keep going.",
          },
        },
      }
    `);
    expect(parseMonthlyReportDraft(JSON.stringify({ ...good, narrative: "Grew by 4321." }), facts)).toMatchInlineSnapshot(`
      {
        "actionPlan": [
          {
            "action": "Review the month's best-performing posts and plan more in the same formats.",
            "owner": "agency",
          },
          {
            "action": "Confirm next month's priorities, promotions and key dates.",
            "owner": "client",
          },
        ],
        "draftedVia": "template",
        "narrativeMd": "Performance summary for Client — 2026-09-01 – 2026-09-30. Followers: 100 count. Engagement rate: 4.5 percent.",
        "notes": {
          "audience": {
            "insight": "Reach has not been fetched for 2026-09-01 – 2026-09-30 yet.",
            "suggestion": "Review the posting times against when the audience is most active.",
          },
          "engagement": {
            "insight": "The engagement rate was 4.5% for 2026-09-01 – 2026-09-30.",
            "suggestion": "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
          },
          "followers": {
            "insight": "Followers stood at 100 at the end of 2026-09-01 – 2026-09-30.",
            "suggestion": "Keep to the agreed posting schedule and note which formats bring in new followers.",
          },
        },
        "rejected": {
          "numbers": [
            "4321",
          ],
          "part": "narrative",
        },
      }
    `);
    expect(parseMonthlyReportDraft(JSON.stringify({ ...good, notes: { followers: good.notes.followers } }), facts)).toMatchInlineSnapshot(`
      {
        "actionPlan": [
          {
            "action": "Review the month's best-performing posts and plan more in the same formats.",
            "owner": "agency",
          },
          {
            "action": "Confirm next month's priorities, promotions and key dates.",
            "owner": "client",
          },
        ],
        "draftedVia": "template",
        "narrativeMd": "Performance summary for Client — 2026-09-01 – 2026-09-30. Followers: 100 count. Engagement rate: 4.5 percent.",
        "notes": {
          "audience": {
            "insight": "Reach has not been fetched for 2026-09-01 – 2026-09-30 yet.",
            "suggestion": "Review the posting times against when the audience is most active.",
          },
          "engagement": {
            "insight": "The engagement rate was 4.5% for 2026-09-01 – 2026-09-30.",
            "suggestion": "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
          },
          "followers": {
            "insight": "Followers stood at 100 at the end of 2026-09-01 – 2026-09-30.",
            "suggestion": "Keep to the agreed posting schedule and note which formats bring in new followers.",
          },
        },
        "rejected": {
          "part": "notes",
        },
      }
    `);
    expect(parseMonthlyReportDraft(JSON.stringify({ ...good, notes: { ...good.notes, audience: { insight: "Seen 77 times.", suggestion: "x" } } }), facts)).toMatchInlineSnapshot(`
      {
        "actionPlan": [
          {
            "action": "Review the month's best-performing posts and plan more in the same formats.",
            "owner": "agency",
          },
          {
            "action": "Confirm next month's priorities, promotions and key dates.",
            "owner": "client",
          },
        ],
        "draftedVia": "template",
        "narrativeMd": "Performance summary for Client — 2026-09-01 – 2026-09-30. Followers: 100 count. Engagement rate: 4.5 percent.",
        "notes": {
          "audience": {
            "insight": "Reach has not been fetched for 2026-09-01 – 2026-09-30 yet.",
            "suggestion": "Review the posting times against when the audience is most active.",
          },
          "engagement": {
            "insight": "The engagement rate was 4.5% for 2026-09-01 – 2026-09-30.",
            "suggestion": "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
          },
          "followers": {
            "insight": "Followers stood at 100 at the end of 2026-09-01 – 2026-09-30.",
            "suggestion": "Keep to the agreed posting schedule and note which formats bring in new followers.",
          },
        },
        "rejected": {
          "numbers": [
            "77",
          ],
          "part": "notes",
        },
      }
    `);
    expect(parseMonthlyReportDraft(JSON.stringify({ ...good, actionPlan: [] }), facts)).toMatchInlineSnapshot(`
      {
        "actionPlan": [
          {
            "action": "Review the month's best-performing posts and plan more in the same formats.",
            "owner": "agency",
          },
          {
            "action": "Confirm next month's priorities, promotions and key dates.",
            "owner": "client",
          },
        ],
        "draftedVia": "template",
        "narrativeMd": "Performance summary for Client — 2026-09-01 – 2026-09-30. Followers: 100 count. Engagement rate: 4.5 percent.",
        "notes": {
          "audience": {
            "insight": "Reach has not been fetched for 2026-09-01 – 2026-09-30 yet.",
            "suggestion": "Review the posting times against when the audience is most active.",
          },
          "engagement": {
            "insight": "The engagement rate was 4.5% for 2026-09-01 – 2026-09-30.",
            "suggestion": "Repeat the formats and topics of the best-performing posts, and answer comments promptly.",
          },
          "followers": {
            "insight": "Followers stood at 100 at the end of 2026-09-01 – 2026-09-30.",
            "suggestion": "Keep to the agreed posting schedule and note which formats bring in new followers.",
          },
        },
        "rejected": {
          "part": "actionPlan",
        },
      }
    `);
  });
});
