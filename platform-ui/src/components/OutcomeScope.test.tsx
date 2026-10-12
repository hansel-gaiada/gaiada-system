import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { OutcomeScope } from "./OutcomeScope";
import { IamAction, type ActionResult } from "./iam/IamAction";
import { ReviewButtons } from "./systems/ReviewButtons";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// The write revalidates; since Next 16.3 the refreshed page (the row/card holding the control gone) is
// applied right after the action. `rerender` with `gone` stands in for that refresh.
function Host({ gone, action }: { gone: boolean; action: (fd: FormData) => Promise<ActionResult> }) {
  return (
    <OutcomeScope>
      {gone ? null : <IamAction label="Remove from seat" fields={[]} immediate action={action} />}
    </OutcomeScope>
  );
}

describe("OutcomeScope", () => {
  it("IamAction: the success message survives the control unmounting", async () => {
    const action = vi.fn(async (): Promise<ActionResult> => ({ ok: true, message: "Placement removed; 2 grants revoked." }));
    const { rerender } = render(<Host gone={false} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove from seat" }));
    await screen.findByText("Placement removed; 2 grants revoked.");
    rerender(<Host gone action={action} />);
    expect(screen.queryByRole("button", { name: "Remove from seat" })).toBeNull();
    expect(screen.getByText("Placement removed; 2 grants revoked.")).toHaveAttribute("role", "status");
  });

  it("IamAction: a refusal stays beside the control, not in the scope", async () => {
    const action = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: "Not allowed." }));
    render(<Host gone={false} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove from seat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed.");
  });

  it("ReviewButtons: Approved survives the source leaving the quarantine list", async () => {
    const ok = vi.fn(async () => ({ ok: true }));
    const Page = ({ listed }: { listed: boolean }) => (
      <OutcomeScope>{listed ? <ReviewButtons approveAction={ok} rejectAction={ok} /> : null}</OutcomeScope>
    );
    const { rerender } = render(<Page listed />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved.");
    rerender(<Page listed={false} />);
    expect(screen.getByText("Approved.")).toHaveAttribute("role", "status");
  });

  it("ReviewButtons outside a scope still toasts locally", async () => {
    const ok = vi.fn(async () => ({ ok: true }));
    render(<ReviewButtons approveAction={ok} rejectAction={ok} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected.")).toBeInTheDocument();
  });
});
