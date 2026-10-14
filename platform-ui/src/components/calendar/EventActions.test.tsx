import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { EventActions } from "./EventActions";

type Caps = Parameters<typeof EventActions>[0]["event"];
const caps = (o: Partial<Caps> = {}): Caps => ({ canEdit: false, canCancel: false, canRespond: false, status: "confirmed", myResponse: "needs_action", ...o });

const draw = (event: Caps, over: Partial<Parameters<typeof EventActions>[0]> = {}) => {
  const respond = vi.fn(async () => ({ ok: true as const }));
  const cancel = vi.fn(async () => ({ ok: true as const }));
  render(<EventActions event={event} editHref="/calendar/events/e1/edit?company=co-a" respond={respond} cancel={cancel} {...over} />);
  return { respond, cancel };
};

beforeEach(() => refresh.mockClear());
afterEach(cleanup);

describe("the event page's buttons follow canEdit / canCancel / canRespond", () => {
  it("draws nothing at all for a reader who may do none of it", () => {
    draw(caps());
    expect(screen.queryByRole("group", { name: "Event actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("an invited person (canRespond only) gets Accept, Maybe and Decline, and no Edit or Cancel", () => {
    draw(caps({ canRespond: true }));
    for (const n of ["Accept", "Maybe", "Decline"]) expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel event" })).not.toBeInTheDocument();
  });

  it("an admin who is not invited (canEdit and canCancel, no canRespond) gets Edit and Cancel and no answers", () => {
    draw(caps({ canEdit: true, canCancel: true }));
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/calendar/events/e1/edit?company=co-a");
    expect(screen.getByRole("button", { name: "Cancel event" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("the organizer gets all of it", () => {
    draw(caps({ canEdit: true, canCancel: true, canRespond: true }));
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Edit" })).toBeInTheDocument();
  });

  it("a cancelled event has none, whatever the flags say", () => {
    draw(caps({ status: "cancelled", canEdit: true, canCancel: true, canRespond: true }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });
});

describe("answering and cancelling", () => {
  it("sends the answer, marks the current one pressed, and refreshes the page", async () => {
    const { respond } = draw(caps({ canRespond: true, myResponse: "tentative" }));
    expect(screen.getByRole("button", { name: "Maybe" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Accept" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("declined"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("asks before cancelling, and does nothing until the person confirms", async () => {
    const { cancel } = draw(caps({ canEdit: true, canCancel: true }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel event" }));
    expect(screen.getByText("Cancel this event? Everyone invited is told.")).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel event" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel event" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("says why when the platform refuses, and does not refresh as if it had worked", async () => {
    const respond = vi.fn(async () => ({ ok: false as const, error: "This event was cancelled, so it can't be changed or answered." }));
    draw(caps({ canRespond: true }), { respond });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This event was cancelled");
    expect(refresh).not.toHaveBeenCalled();
  });
});
