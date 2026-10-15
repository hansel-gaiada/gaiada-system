import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// PV7-04b — Publish and Withdraw on the client hub's Reports tab. Pins: buttons by status only, the confirm wording, a
// declined confirm sends nothing, Withdraw needs a reason (disabled until typed), and the action's refusals show in words.

vi.mock("@/lib/clientReportsActions", () => ({
  publishClientReportAction: vi.fn(),
  withdrawClientReportAction: vi.fn(),
}));

import { publishClientReportAction, withdrawClientReportAction } from "@/lib/clientReportsActions";
import { ClientReportActions } from "./ClientReportActions";

const publish = vi.mocked(publishClientReportAction);
const withdraw = vi.mocked(withdrawClientReportAction);
const file = { id: "f1", filename: "a.pdf", contentType: "application/pdf", byteSize: 10 };
const draft = { id: "r1", title: "Account summary", status: "draft" as const, file };

let confirm: ReturnType<typeof vi.fn>;
beforeEach(() => {
  publish.mockReset(); withdraw.mockReset();
  confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  window.confirm = confirm as unknown as typeof window.confirm;
});
afterEach(() => vi.unstubAllGlobals());

describe("ClientReportActions: which buttons", () => {
  it("a draft offers Publish and no Withdraw", () => {
    render(<ClientReportActions report={draft} clientId="cl-1" />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });
  it("a published report offers Withdraw and no Publish", () => {
    render(<ClientReportActions report={{ ...draft, status: "published" }} clientId="cl-1" />);
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
  it("a withdrawn report offers neither", () => {
    const { container } = render(<ClientReportActions report={{ ...draft, status: "withdrawn" }} clientId="cl-1" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("a draft with no file still shows Publish, with the reason it will be refused", () => {
    render(<ClientReportActions report={{ ...draft, file: null }} clientId="cl-1" />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getByText(/no file yet/)).toBeInTheDocument();
  });
});

describe("ClientReportActions: Publish", () => {
  it("asks first, in the agreed words, then publishes", async () => {
    publish.mockResolvedValue({ ok: true, id: "r1", notice: "Published. The client's contacts have been told." });
    render(<ClientReportActions report={draft} clientId="cl-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(confirm).toHaveBeenCalledWith(
      "Publish to the client? Contacts who can see this project (or, with no project, the client's main contacts) will see it and get a notice.",
    );
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const fd = publish.mock.calls[0][1] as FormData;
    expect(fd.get("reportId")).toBe("r1");
    expect(fd.get("clientId")).toBe("cl-1");
    expect(await screen.findByRole("status")).toHaveTextContent(/Published/);
  });
  it("a declined confirm sends nothing", () => {
    confirm.mockReturnValue(false);
    render(<ClientReportActions report={draft} clientId="cl-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(publish).not.toHaveBeenCalled();
  });
  it("shows the action's refusal in words as an alert", async () => {
    publish.mockResolvedValue({ ok: false, error: "This report is no longer a draft, so it can't be published. Refresh the page to see where it stands." });
    render(<ClientReportActions report={draft} clientId="cl-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer a draft/);
  });
});

describe("ClientReportActions: Withdraw", () => {
  const published = { ...draft, status: "published" as const };

  it("is disabled, with the why beside it, until a reason is typed", () => {
    render(<ClientReportActions report={published} clientId="cl-1" />);
    const btn = screen.getByRole("button", { name: "Withdraw" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Say why/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Reason for withdrawing/), { target: { value: "Wrong figures" } });
    expect(btn).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Reason for withdrawing/), { target: { value: "   " } });
    expect(btn).toBeDisabled();
  });

  it("caps the reason at the backend's length", () => {
    render(<ClientReportActions report={published} clientId="cl-1" />);
    expect(screen.getByLabelText(/Reason for withdrawing/)).toHaveAttribute("maxlength", "2000");
  });

  it("asks first, then sends the reason", async () => {
    withdraw.mockResolvedValue({ ok: true, id: "r1", notice: "Withdrawn. The client no longer sees it." });
    render(<ClientReportActions report={published} clientId="cl-1" />);
    fireEvent.change(screen.getByLabelText(/Reason for withdrawing/), { target: { value: "Wrong figures" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1));
    const fd = withdraw.mock.calls[0][1] as FormData;
    expect(fd.get("reason")).toBe("Wrong figures");
    expect(fd.get("reportId")).toBe("r1");
    expect(await screen.findByRole("status")).toHaveTextContent(/Withdrawn/);
  });

  it("a declined confirm sends nothing", () => {
    confirm.mockReturnValue(false);
    render(<ClientReportActions report={published} clientId="cl-1" />);
    fireEvent.change(screen.getByLabelText(/Reason for withdrawing/), { target: { value: "Wrong figures" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("shows a refusal (409 not published) in words", async () => {
    withdraw.mockResolvedValue({ ok: false, error: "This report is not published, so there is nothing to withdraw. Refresh the page to see where it stands." });
    render(<ClientReportActions report={published} clientId="cl-1" />);
    fireEvent.change(screen.getByLabelText(/Reason for withdrawing/), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not published/);
  });
});

// PV7-07: an account summary has no file until Publish renders it, so a file-less summary draft is publishable with no warning.
describe("ClientReportActions: an account summary draft", () => {
  it("shows Publish with no 'no file yet' reason, while a file-less module draft still does", () => {
    const { unmount } = render(<ClientReportActions report={{ ...draft, file: null, source: "account_summary" }} clientId="cl-1" />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.queryByText(/no file yet/)).toBeNull();
    unmount();
    render(<ClientReportActions report={{ ...draft, file: null, source: "social_report" }} clientId="cl-1" />);
    expect(screen.getByText(/no file yet/)).toBeInTheDocument();
  });

  it("says a render failure in words, and that the summary stays a draft", async () => {
    publish.mockResolvedValue({ ok: false, error: "The PDF could not be made right now. The summary stays a draft; try again in a moment." });
    render(<ClientReportActions report={{ ...draft, file: null, source: "account_summary" }} clientId="cl-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/stays a draft/);
  });
});
