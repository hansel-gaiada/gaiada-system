import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SubmissionsPanel } from "./SubmissionsPanel";
import type { DegradeMeta, SubmissionFact } from "@/lib/webdesk";

const META: DegradeMeta = { stale: true, source: "facts", asOf: "2026-08-25T10:00:00Z", reason: "slim_pii_free_projection_from_zoneb_event_log_only" };

describe("SubmissionsPanel — PII-aware by construction", () => {
  it("never renders any field beyond the slim receipt shape (no body/content field exists to leak)", () => {
    const submissions: SubmissionFact[] = [{ submissionId: "s1", formId: "contact", hasAttachments: true, receivedAt: "2026-08-20T00:00:00Z" }];
    render(<SubmissionsPanel submissions={submissions} meta={META} />);
    expect(screen.getByText("contact")).toBeInTheDocument();
    expect(screen.getByText(/never reaches this console/i)).toBeInTheDocument();
  });

  it("shows the staleness banner for submissions too — this read is always stale, same as releases/sites", () => {
    const submissions: SubmissionFact[] = [];
    render(<SubmissionsPanel submissions={submissions} meta={META} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-stale", "true");
    expect(screen.getByText(/No submissions on file/i)).toBeInTheDocument();
  });
});
