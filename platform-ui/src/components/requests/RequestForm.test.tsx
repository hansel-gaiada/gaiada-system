import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { push, createRequestAction } = vi.hoisted(() => ({ push: vi.fn(), createRequestAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/lib/requestActions", () => ({ createRequestAction }));

import { RequestForm } from "./RequestForm";

beforeEach(() => {
  push.mockReset();
  createRequestAction.mockReset();
});

// A field's label also holds its hint and its error, so match on how it starts.
const field = (label: string) => screen.getByLabelText(new RegExp(`^${label}`));
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send request" }));

describe("RequestForm: asset request (Creatives)", () => {
  const draw = (over: Partial<Parameters<typeof RequestForm>[0]> = {}) =>
    render(<RequestForm kind="assets" toUnitId="d-cre" toUnitName="Creatives" campaigns={[{ partId: "p1", label: "Launch" }]} {...over} />);

  it("explains a mistake next to its field and does not ask the server", () => {
    draw();
    send();
    expect(screen.getByText("Give the request a title.")).toBeTruthy();
    expect(screen.getByText("Choose a format.")).toBeTruthy();
    expect(createRequestAction).not.toHaveBeenCalled();
  });

  it("marks a quantity out of bounds on its own deliverable", () => {
    draw();
    type("Title", "Banners");
    type("Format", "image");
    type("Quantity", "51");
    send();
    expect(screen.getByText("A quantity is a whole number from 1 to 50.")).toBeTruthy();
    expect(createRequestAction).not.toHaveBeenCalled();
  });

  it("sends the body the contract takes, then opens the new request", async () => {
    createRequestAction.mockResolvedValue({ ok: true, id: "r-9" });
    draw();
    type("Title", "  Banners ");
    type("Brief", "For the launch");
    type("Format", "image");
    type("Size", "1080x1350");
    type("Quantity", "3");
    type("Campaign", "p1");
    type("Reference links", "https://a.example/x\nhttps://b.example/y");
    send();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/requests/r-9"));
    expect(createRequestAction).toHaveBeenCalledWith({
      kind: "assets", toUnitId: "d-cre", title: "Banners", brief: "For the launch", campaignPartId: "p1",
      form: { deliverables: [{ format: "image", size: "1080x1350", quantity: 3 }], references: ["https://a.example/x", "https://b.example/y"] },
    });
  });

  it("adds and removes deliverables, between 1 and 10", () => {
    draw();
    expect(screen.queryAllByLabelText("Format")).toHaveLength(1);
    expect((screen.getAllByRole("button", { name: "Remove" })[0] as HTMLButtonElement).disabled).toBe(true);
    const add = screen.getByRole("button", { name: "Add a deliverable" }) as HTMLButtonElement;
    for (let i = 0; i < 9; i++) fireEvent.click(add);
    expect(screen.getAllByLabelText("Format")).toHaveLength(10);
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[3]);
    expect(screen.getAllByLabelText("Format")).toHaveLength(9);
  });

  it("shows a server refusal as a sentence and keeps the form", async () => {
    createRequestAction.mockResolvedValue({ ok: false, error: "That campaign part is no longer available. Choose another campaign, or leave it blank.", reason: "campaign_part_invalid", field: "campaignPartId" });
    draw();
    type("Title", "Banners");
    type("Format", "image");
    send();
    await waitFor(() => expect(screen.getAllByText(/campaign part is no longer available/).length).toBeGreaterThan(0));
    expect(push).not.toHaveBeenCalled();
    expect((field("Title") as HTMLInputElement).value).toBe("Banners");
  });

  it("says the campaigns could not be read, and still lets the request be sent", () => {
    draw({ campaigns: null });
    expect(screen.getByText(/campaigns could not be read/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Campaign/)).toBeNull();
    expect((screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers no campaign choice when the receiving department has no part in any", () => {
    draw({ campaigns: [] });
    expect(screen.queryByLabelText(/^Campaign/)).toBeNull();
    expect(screen.queryByText(/campaigns could not be read/)).toBeNull();
  });
});

describe("RequestForm: engineering request (Web Dev)", () => {
  const draw = () => render(<RequestForm kind="engineering" toUnitId="d-web" toUnitName="Web Dev" campaigns={[]} />);

  it("has the change kind and the affected page, and no deliverables", () => {
    draw();
    expect(field("What kind of change")).toBeTruthy();
    expect(field("Affected page")).toBeTruthy();
    expect(screen.queryByLabelText("Format")).toBeNull();
  });

  it("needs a kind and an http(s) page, then sends the engineering body", async () => {
    createRequestAction.mockResolvedValue({ ok: true, id: "r-2" });
    draw();
    type("Title", "Fix the footer");
    type("Affected page", "javascript:alert(1)");
    send();
    expect(screen.getByText("Choose what kind of change this is.")).toBeTruthy();
    expect(screen.getByText(/must be an http or https link/)).toBeTruthy();
    type("What kind of change", "bug");
    type("Affected page", "https://x.example/about");
    send();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/requests/r-2"));
    expect(createRequestAction).toHaveBeenCalledWith({
      kind: "engineering", toUnitId: "d-web", title: "Fix the footer", form: { kind: "bug", affectedUrl: "https://x.example/about" },
    });
  });
});
