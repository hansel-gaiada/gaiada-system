import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { refresh, cancelRequestAction, declineRequestAction, deliverRequestAction } = vi.hoisted(() => ({
  refresh: vi.fn(), cancelRequestAction: vi.fn(), declineRequestAction: vi.fn(), deliverRequestAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/requestActions", () => ({ cancelRequestAction, declineRequestAction, deliverRequestAction }));

import { RequestActions, type RequestActionsProps } from "./RequestActions";

beforeEach(() => {
  for (const f of [refresh, cancelRequestAction, declineRequestAction, deliverRequestAction]) f.mockReset();
});

const off = { cancel: false, deliver: false, deliverMore: false, decline: false };
const library = [{ id: "a1", name: "banner-1.png", contentType: "image/png" }, { id: "a2", name: "banner-2.png", contentType: "image/png" }];
const props = (over: Partial<RequestActionsProps> = {}): RequestActionsProps => ({ requestId: "r1", offered: off, library, ...over });

describe("RequestActions: what is offered", () => {
  it("draws nothing for someone who is offered nothing", () => {
    const { container } = render(<RequestActions {...props()} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers exactly the offered controls", () => {
    render(<RequestActions {...props({ offered: { ...off, cancel: true } })} />);
    expect(screen.getByRole("button", { name: "Cancel request" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deliver/ })).toBeNull();
  });

  it("calls the second delivery 'Deliver more assets'", () => {
    render(<RequestActions {...props({ offered: { ...off, deliverMore: true } })} />);
    expect(screen.getByRole("button", { name: "Deliver more assets" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deliver assets" })).toBeNull();
  });
});

describe("RequestActions: Deliver", () => {
  const open = () => {
    render(<RequestActions {...props({ offered: { ...off, deliver: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver assets" }));
  };

  it("delivers the chosen assets and refreshes the page", async () => {
    deliverRequestAction.mockResolvedValue({ ok: true });
    open();
    fireEvent.click(screen.getByLabelText(/banner-2.png/));
    fireEvent.click(screen.getByRole("button", { name: "Deliver 1 asset" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(deliverRequestAction).toHaveBeenCalledWith("r1", ["a2"]);
  });

  it("will not deliver nothing", () => {
    open();
    expect((screen.getByRole("button", { name: "Deliver" }) as HTMLButtonElement).disabled).toBe(true);
    expect(deliverRequestAction).not.toHaveBeenCalled();
  });

  it("shows a 403 or a 409 as a sentence below the control, and does not refresh", async () => {
    deliverRequestAction.mockResolvedValue({ ok: false, error: "You do not have permission to do that." });
    open();
    fireEvent.click(screen.getByLabelText(/banner-1.png/));
    fireEvent.click(screen.getByRole("button", { name: "Deliver 1 asset" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You do not have permission to do that."));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says the library could not be read, rather than showing an empty picker", () => {
    render(<RequestActions {...props({ offered: { ...off, deliver: true }, library: null, libraryReason: "platform 503" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver assets" }));
    expect(screen.getByText(/Asset Library could not be read \(platform 503\)/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says when the library has nothing left to deliver", () => {
    render(<RequestActions {...props({ offered: { ...off, deliver: true }, library: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Deliver assets" }));
    expect(screen.getByText(/nothing left in the Asset Library/)).toBeTruthy();
  });
});

describe("RequestActions: Decline", () => {
  const open = () => {
    render(<RequestActions {...props({ offered: { ...off, decline: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  };

  it("asks for a reason first, without calling the server", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Decline request" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Say why/);
    expect(declineRequestAction).not.toHaveBeenCalled();
  });

  it("declines with the reason and refreshes", async () => {
    declineRequestAction.mockResolvedValue({ ok: true });
    open();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "No capacity this month" } });
    fireEvent.click(screen.getByRole("button", { name: "Decline request" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(declineRequestAction).toHaveBeenCalledWith("r1", "No capacity this month");
  });
});

describe("RequestActions: Cancel", () => {
  it("asks first, then cancels", async () => {
    cancelRequestAction.mockResolvedValue({ ok: true });
    render(<RequestActions {...props({ offered: { ...off, cancel: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    expect(cancelRequestAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(cancelRequestAction).toHaveBeenCalledWith("r1");
  });

  it("can be walked back", () => {
    render(<RequestActions {...props({ offered: { ...off, cancel: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("button", { name: "Yes, cancel it" })).toBeNull();
    expect(cancelRequestAction).not.toHaveBeenCalled();
  });

  it("says Web Dev has accepted the work, when the server says so", async () => {
    cancelRequestAction.mockResolvedValue({ ok: false, error: "Web Dev has already accepted this work, so it can no longer be cancelled here." });
    render(<RequestActions {...props({ offered: { ...off, cancel: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already accepted/));
  });
});
