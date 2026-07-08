import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReviewButtons } from "./ReviewButtons";
import type { ReviewActionState } from "@/app/(app)/knowledge/actions";

async function noopAction(_prev: ReviewActionState | null, _formData: FormData): Promise<ReviewActionState> {
  return { ok: true };
}

describe("ReviewButtons", () => {
  it("renders both Approve and Reject buttons", () => {
    render(<ReviewButtons approveAction={noopAction} rejectAction={noopAction} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });
});
