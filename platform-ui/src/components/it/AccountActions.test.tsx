import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountActions } from "./AccountActions";

// DW-7h (BFF §52.7, §52.8). After Reset password the temporary password is shown once, with the line that says the person chooses
// their own at the first sign-in (accounts on an email alias get no reset email). After Disable the panel says whether the
// person's sessions were ended, and stays until dismissed (the row changes state on refresh and can leave the list).
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const noop = vi.fn(async () => ({ ok: true as const, message: "ok" }));
const view = (over: Partial<Parameters<typeof AccountActions>[0]> = {}) =>
  render(<AccountActions userId="u-2" email="dewi@x.test" state="enabled" provision={noop} disable={noop} enable={noop} resetPassword={noop} {...over} />);

beforeEach(() => { refresh.mockReset(); noop.mockClear(); });

describe("Reset password", () => {
  const reset = async (resetPassword: Parameters<typeof AccountActions>[0]["resetPassword"]) => {
    view({ resetPassword });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    fireEvent.change(screen.getByLabelText("Reason for resetting the password"), { target: { value: "locked out" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  };

  it("shows the temporary password once, with the first-sign-in line, and does not refresh under it", async () => {
    await reset(vi.fn(async () => ({ ok: true as const, message: "Password reset", password: "Temp-1234", email: "dewi@x.test" })));
    expect(await screen.findByText("Temp-1234")).toBeInTheDocument();
    expect(screen.getByText(/Temporary/)).toBeInTheDocument();
    expect(screen.getByText("They choose their own password at their first sign-in (accounts on an email alias get no reset email).")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I have shared it" }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByText("Temp-1234")).toBeNull();
  });

  it("a new account's initial password does not carry the reset line", async () => {
    const provision = vi.fn(async () => ({ ok: true as const, message: "created", password: "Init-1", email: "dewi@x.test" }));
    view({ state: "missing", provision });
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));
    expect(await screen.findByText("Init-1")).toBeInTheDocument();
    expect(screen.getByText(/Initial/)).toBeInTheDocument();
    expect(screen.queryByText(/They choose their own password/)).toBeNull();
  });
});

describe("Disable", () => {
  it("★ says the sessions were ended, holds the answer until dismissed, then refreshes", async () => {
    const disable = vi.fn(async () => ({ ok: true as const, message: "dewi@x.test disabled, and every session they had open was ended. They are signed out now.", sessionsEnded: true }));
    view({ disable });
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(await screen.findByText("Signed out everywhere")).toBeInTheDocument();
    expect(screen.getByText(/every session they had open was ended/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("★ says when the sessions were not confirmed ended", async () => {
    const disable = vi.fn(async () => ({ ok: true as const, message: "disabled, but the sign-in service did not confirm ending their open sessions.", sessionsEnded: false }));
    view({ disable });
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(await screen.findByText("Check their sessions")).toBeInTheDocument();
    expect(screen.getByText(/did not confirm ending their open sessions/)).toBeInTheDocument();
  });

  it("with no word about sessions it behaves as before: a note and a refresh", async () => {
    const disable = vi.fn(async () => ({ ok: true as const, message: "dewi@x.test disabled." }));
    view({ disable });
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText("dewi@x.test disabled.")).toBeInTheDocument();
  });
});
