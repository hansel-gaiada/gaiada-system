import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PortalComposerFields } from "./PortalComposerFields";
import { CONVERSATION_BODY_MAX, CONVERSATION_MAX_BYTES } from "@/lib/portal";

vi.mock("@/lib/portalActions", () => ({ portalPostMessage: vi.fn(), portalStartConversation: vi.fn() }));

// PV4-08 — the composer's limits, checked client-side in plain words before anything is sent (§29): 10,000
// characters (counter near the limit, Send held over it), at most 5 files, at most 10 MB in total.
function renderBox() {
  return render(
    <form>
      <PortalComposerFields idPrefix="t" bodyLabel="Your reply" submitLabel="Send reply" pendingLabel="Sending…" pending={false} />
    </form>,
  );
}
const type = (text: string) => fireEvent.change(screen.getByLabelText("Your reply"), { target: { value: text } });
const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: "application/pdf" });
const attach = (files: File[]) => fireEvent.change(screen.getByLabelText(/attach files/i), { target: { files } });
const send = () => screen.getByRole("button", { name: "Send reply" });

describe("PortalComposerFields: characters", () => {
  it("holds Send while the box is empty or blank, and frees it once there is text", () => {
    renderBox();
    expect(send()).toBeDisabled();
    type("   ");
    expect(send()).toBeDisabled();
    type("Hello");
    expect(send()).toBeEnabled();
  });

  it("shows no counter for a short message, and a counter near the limit", () => {
    renderBox();
    type("short");
    expect(screen.queryByText(/of 10,000 characters/)).not.toBeInTheDocument();
    type("x".repeat(9_500));
    expect(screen.getByText("9,500 of 10,000 characters")).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("exactly 10,000 is allowed; 10,001 is refused with how much to cut", () => {
    renderBox();
    type("x".repeat(CONVERSATION_BODY_MAX));
    expect(send()).toBeEnabled();
    type("x".repeat(CONVERSATION_BODY_MAX + 1));
    expect(send()).toBeDisabled();
    expect(screen.getByText(/Shorten it by 1\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Your reply")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("PortalComposerFields: attachments", () => {
  it("accepts up to 5 files within 10 MB", () => {
    renderBox();
    type("see attached");
    attach(Array.from({ length: 5 }, (_, i) => file(`f${i}.pdf`, 1024)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("refuses a sixth file with a plain message and holds Send", () => {
    renderBox();
    type("see attached");
    attach(Array.from({ length: 6 }, (_, i) => file(`f${i}.pdf`, 1024)));
    expect(screen.getByRole("alert")).toHaveTextContent(/up to 5 files/i);
    expect(send()).toBeDisabled();
  });

  it("refuses files that add up to more than 10 MB, however few", () => {
    renderBox();
    type("see attached");
    attach([file("a.pdf", CONVERSATION_MAX_BYTES / 2 + 1), file("b.pdf", CONVERSATION_MAX_BYTES / 2)]);
    expect(screen.getByRole("alert")).toHaveTextContent(/10 MB in total/i);
    expect(send()).toBeDisabled();
  });

  it("lists the chosen files and every control is labelled", () => {
    renderBox();
    attach([file("brief.pdf", 2048)]);
    expect(screen.getByText(/brief\.pdf \(2 KB\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove brief.pdf" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your reply")).toBeInTheDocument();
    expect(screen.getByLabelText(/attach files/i)).toBeInTheDocument();
  });

  it("states the price-and-terms hint verbatim and ties it to the box", () => {
    renderBox();
    const hint = screen.getByText("Prices and terms change only through a signed contract or amendment.");
    expect(screen.getByLabelText("Your reply").getAttribute("aria-describedby")).toContain(hint.id);
  });
});
