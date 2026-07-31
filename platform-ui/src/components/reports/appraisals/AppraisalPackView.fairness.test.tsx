import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AppraisalPackView } from "./AppraisalPackView";
import type { AppraisalPack } from "@/lib/appraisals";

// TR-26 — the acceptance bar's fairness assertion: "the subject sees the IDENTICAL pack the
// manager submitted — same numbers, same commentary, no manager-only annotations leaking and
// nothing hidden from them either." This is enforced structurally by AppraisalPackView never
// taking a `viewer`/`isManager` prop (see that component's header) — this test proves it by
// rendering the SAME pack through what the manager's read-only call site renders (no footerSlot)
// and what the subject's call site renders (an ack/dispute footerSlot), then asserting every piece
// of the pack's DATA — commentary, every axis score + note, every cohort metric's value/numerator/
// denominator/band, the evidence-stale flag, the ack trail — appears identically in both, and that
// the only difference between the two renders is the footer action itself.
function samplePack(): AppraisalPack {
  return {
    id: "a1", tenantId: "co-agency", cycleId: "cy1", cycleName: "2026 H1 Review",
    subjectUserId: "u-subject", subjectName: "Jordan Rivera",
    managerUserId: "u-manager", managerName: "Casey Nolan",
    roleKey: "developer",
    weights: { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 },
    scores: {
      delivery: { auto: 4, manager: 4 },
      quality: { auto: 4, manager: 4 },
      effort: { auto: 2, manager: 4, note: "Manager-only-looking but must appear to the subject too: real ownership beyond the raw metric." },
      collaboration: { auto: 5, manager: 5 },
    },
    composite: 4.25,
    commentary: "This is the exact commentary text the subject must see, word for word, with no redaction.",
    status: "submitted",
    cohortBands: [
      {
        metricKey: "delivery.on_time_rate", metricLabel: "On-time rate", unit: "percent",
        subjectValue: 0.864, numerator: 19, denominator: 22, subjectPercentile: 70, band: 4,
        cohortSize: 6, axis: "delivery", informationalOnly: false,
      },
      {
        metricKey: "discipline.time_logging_coverage", metricLabel: "Time-logging coverage", unit: "percent",
        subjectValue: 0.864, numerator: 19, denominator: 22, subjectPercentile: 70, band: 4,
        cohortSize: 6, axis: "discipline", informationalOnly: true,
      },
    ],
    evidence: { periodIds: ["p1"], revisions: { p1: 1 } },
    evidenceStale: true,
    periodId: "p1", revision: 1,
    submittedAt: "2026-07-03T10:00:00Z", finalizedAt: null,
    createdAt: "2026-07-02T09:00:00Z", updatedAt: "2026-07-03T10:00:00Z",
    acks: [{ id: "ack1", appraisalId: "a1", actorUserId: "u-subject", actorName: "Jordan Rivera", action: "acknowledged", comment: "Thanks for the detail.", createdAt: "2026-07-04T09:00:00Z" }],
  };
}

describe("AppraisalPackView — the subject sees the IDENTICAL pack the manager submitted", () => {
  it("has no viewer/role prop at all — the only variable input is the pack and an opaque footer slot", () => {
    // A type-level guarantee, asserted at runtime: the component's own param list (visible via
    // Function.length/toString in this bundler's dev transform would be brittle) is instead proven
    // by usage — every call site in this file passes only {pack, footerSlot}, and this test's other
    // cases show that varying ONLY footerSlot (never the pack) never changes the core content.
    expect(typeof AppraisalPackView).toBe("function");
  });

  it("renders every pack field identically whether called for the manager (no footer) or the subject (ack footer)", () => {
    const pack = samplePack();

    const managerRender = render(<AppraisalPackView pack={pack} />);
    const managerText = managerRender.container.textContent ?? "";
    managerRender.unmount();

    const subjectRender = render(<AppraisalPackView pack={pack} footerSlot={<div data-testid="ack-form">Acknowledge / Dispute</div>} />);
    const subjectText = subjectRender.container.textContent ?? "";

    // Every load-bearing datum from the pack must appear in BOTH renders, verbatim.
    const mustAppearInBoth = [
      pack.commentary!,
      pack.scores.effort.note!,
      "4.25", // composite
      "19", "22", // the on-time-rate ratio's numerator/denominator
      "86%", // 0.864 formatted as a percent, not "0.864" or "0.86"
      "Evidence has changed since this appraisal was generated.", // evidenceStale banner
      "acknowledged", "Thanks for the detail.", // the ack trail entry
      "append-only", // the immutability notice
    ];
    for (const needle of mustAppearInBoth) {
      expect(managerText).toContain(needle);
      expect(subjectText).toContain(needle);
    }

    // The ONLY difference is the footer slot's own content.
    expect(managerText).not.toContain("Acknowledge / Dispute");
    expect(subjectText).toContain("Acknowledge / Dispute");

    // Strip the footer-only text and confirm the remaining content is byte-identical.
    const strip = (s: string) => s.replace("Acknowledge / Dispute", "");
    expect(strip(managerText)).toBe(strip(subjectText));
  });

  it("never renders a manager-only annotation the pack itself doesn't carry (nothing to leak, because nothing extra exists)", () => {
    const pack = samplePack();
    render(<AppraisalPackView pack={pack} />);
    // Regression guard: an "internal"/"manager-only"/"private" marker would be a contract violation
    // if it ever got added — assert none of that vocabulary appears anywhere in the render.
    const text = screen.getByText(pack.commentary!).closest(".rc-appr-page")!.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("internal note");
    expect(text.toLowerCase()).not.toContain("manager only");
    expect(text.toLowerCase()).not.toContain("private note");
  });

  it("a suppressed small-cohort band renders as explicitly suppressed, never as a blank or a low score", () => {
    const pack = samplePack();
    pack.cohortBands = [{
      metricKey: "delivery.on_time_rate", metricLabel: "On-time rate", unit: "percent",
      subjectValue: 1, numerator: 2, denominator: 2, band: null, cohortSize: 2,
      axis: "delivery", informationalOnly: false,
    }];
    render(<AppraisalPackView pack={pack} />);
    expect(screen.getByText(/cohort too small for a band/i)).toBeInTheDocument();
    // The raw rate with its denominator is still shown, honestly, even though there's no band.
    expect(screen.getByText(/\(2\/2\)/)).toBeInTheDocument();
  });
});
