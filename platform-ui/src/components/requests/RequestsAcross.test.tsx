import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { push, refresh, createOutboundRequestAction, createRequestAction, cancelOutboundRequestAction, cancelRequestAction } = vi.hoisted(() => ({
  push: vi.fn(), refresh: vi.fn(), createOutboundRequestAction: vi.fn(), createRequestAction: vi.fn(), cancelOutboundRequestAction: vi.fn(), cancelRequestAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/requestActions", () => ({
  createOutboundRequestAction, createRequestAction, cancelOutboundRequestAction, cancelRequestAction,
  declineRequestAction: vi.fn(), deliverRequestAction: vi.fn(),
}));

import { DeliveredRequestsTable } from "./DeliveredRequestsTable";
import { IncomingRequestsTable } from "./IncomingRequestsTable";
import { RequestActions } from "./RequestActions";
import { RequestForm } from "./RequestForm";
import { RequestsTable } from "./RequestsTable";
import { SentRequests } from "./SentRequests";
import { mergeSentReads, normalizeRequestRow, type RequestRow } from "@/lib/requests";

// DW-10e (BFF §60.9): the components of requests across group companies: the sent list (scope wording, a part that failed named), the tables
// (a row to another company says "To <unit> · <company>" and opens the sender's page; the receiving side names the requesting company, its
// department and the client), the form with a route, and Cancel on the sender's page.
beforeEach(() => {
  for (const f of [push, refresh, createOutboundRequestAction, createRequestAction, cancelOutboundRequestAction, cancelRequestAction]) f.mockReset();
});

const sender = (over: Record<string, unknown> = {}): RequestRow => normalizeRequestRow({
  id: "x1", kind: "assets", title: "Reception banners", status: "open", neededBy: null, createdAt: "2026-10-12T03:00:00Z", closedAt: null,
  fromUnit: { id: "hosp-dept-1", name: "Front Office" }, toUnit: { id: "dept-2", name: "Creatives" }, requestedBy: { id: "u-resort", name: "Ni Luh Sekar" },
  work: { type: "pm_task", status: "in_progress", isDone: false, responsibleName: "Putu Rani" }, assetCount: 0,
  receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" }, routeId: "rt-1", price: null, ...over,
}, { outbound: true })!;
const same = (over: Record<string, unknown> = {}): RequestRow => normalizeRequestRow({
  id: "s1", kind: "assets", title: "Blog headers", status: "open", createdAt: "2026-10-10T00:00:00Z",
  fromUnit: { id: "dept-3", name: "SEO", unitMissing: false }, toUnit: { id: "dept-2", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u-seo", name: "Luh Ayu" }, work: { type: "pm_task", id: "t1", status: "new", isDone: false, responsibleName: null }, assetCount: 0, ...over,
})!;
const incoming = (over: Record<string, unknown> = {}): RequestRow => normalizeRequestRow({
  id: "i1", kind: "assets", title: "Reception banners", status: "open", createdAt: "2026-10-12T03:00:00Z", fromUnit: null,
  toUnit: { id: "dept-2", name: "Creatives", unitMissing: false }, requestedBy: { id: "u-resort", name: "Ni Luh Sekar" },
  work: { type: "pm_task", id: "t1", status: "new", isDone: false, responsibleName: null }, assetCount: 0,
  requestingCompany: { id: "co-resort", name: "Viceroy" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" }, client: { id: "cl-1", name: "Viceroy (client)" }, ...over,
})!;
const ok = <T,>(data: T) => ({ kind: "ok" as const, data });

describe("My requests: the sent list and its scope (DW-D40)", () => {
  it("says 'Requests you sent' and that only the caller's requests to other companies are shown, in scope own", () => {
    const merged = mergeSentReads(ok([same()]), ok({ scope: "own" as const, rows: [sender()] }));
    render(<SentRequests merged={merged} company="Viceroy" empty="none" showRequester={false} />);
    expect(screen.getByRole("heading", { name: /^Requests you sent/ })).toBeInTheDocument();
    expect(screen.getByText("Only the requests you sent to other companies are shown. Managers and administrators of Viceroy see all of them.")).toBeInTheDocument();
  });

  it("says 'Requests <company> sent' in scope company, with no 'only yours' note", () => {
    const merged = mergeSentReads(ok([]), ok({ scope: "company" as const, rows: [sender()] }));
    render(<SentRequests merged={merged} company="Viceroy" empty="none" showRequester={false} />);
    expect(screen.getByRole("heading", { name: /^Requests Viceroy sent/ })).toBeInTheDocument();
    expect(screen.queryByText(/Only the requests you sent/)).toBeNull();
  });

  it("lists a request to another company naming the receiving department and company, linked to the sender's page", () => {
    const merged = mergeSentReads(ok([same()]), ok({ scope: "own" as const, rows: [sender()] }));
    render(<SentRequests merged={merged} company="Viceroy" empty="none" showRequester={false} />);
    expect(screen.getByText("To Creatives · Gaia Digital Agency")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reception banners" })).toHaveAttribute("href", "/requests/outbound/x1");
    // The same-company row is as it was: the department's name, the ordinary page.
    expect(screen.getByRole("link", { name: "Blog headers" })).toHaveAttribute("href", "/requests/s1");
    expect(screen.queryByText("To Creatives")).toBeNull();
  });

  it("when the other-companies read fails, shows the departments part AND says which part could not be read", () => {
    const merged = mergeSentReads(ok([same()]), { kind: "unavailable", reason: "boom" });
    render(<SentRequests merged={merged} company="Viceroy" empty="You have no open requests." showRequester={false} />);
    expect(screen.getByRole("link", { name: "Blog headers" })).toBeInTheDocument();
    expect(screen.getByText(/The requests you sent to other companies cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("What is listed below is the other part only.")).toBeInTheDocument();
  });

  it("when the departments read fails, names that part and lists the companies' rows", () => {
    const merged = mergeSentReads({ kind: "forbidden" }, ok({ scope: "company" as const, rows: [sender()] }));
    render(<SentRequests merged={merged} company="Viceroy" empty="none" showRequester={false} />);
    expect(screen.getByText(/You don't have access to The requests you sent to other departments/i)).toBeInTheDocument();
    expect(screen.getByText("To Creatives · Gaia Digital Agency")).toBeInTheDocument();
  });

  it("claims 'nothing' only when both reads answered", () => {
    const answered = mergeSentReads(ok([]), ok({ scope: "own" as const, rows: [] }));
    const first = render(<SentRequests merged={answered} company="Viceroy" empty="You have no open requests." showRequester={false} />);
    expect(screen.getByText("You have no open requests.")).toBeInTheDocument();
    first.unmount();
    const half = mergeSentReads(ok([]), { kind: "unavailable", reason: "boom" });
    render(<SentRequests merged={half} company="Viceroy" empty="You have no open requests." showRequester={false} />);
    expect(screen.queryByText("You have no open requests.")).toBeNull();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
  });

  it("keeps a department's Sent tab's own title and the scope note", () => {
    const merged = mergeSentReads(ok([]), ok({ scope: "own" as const, rows: [sender()] }));
    render(<SentRequests merged={merged} company="Viceroy" empty="none" showRequester titleOverride="Sent requests" hintOverride="h" />);
    expect(screen.getByRole("heading", { name: /^Sent requests/ })).toBeInTheDocument();
    expect(screen.getByText(/Only the requests you sent to other companies are shown/)).toBeInTheDocument();
    expect(screen.getByText("Requested by")).toBeInTheDocument();
  });
});

describe("the tables name the other company", () => {
  it("RequestsTable: a request to another company opens the sender's page", () => {
    render(<RequestsTable rows={[sender()]} showRequester={false} />);
    expect(screen.getByRole("link", { name: "Reception banners" })).toHaveAttribute("href", "/requests/outbound/x1");
    expect(screen.getByText("To Creatives · Gaia Digital Agency")).toBeInTheDocument();
  });

  it("Incoming: names the requesting company and its department under From, and the client the work is billed to", () => {
    render(<IncomingRequestsTable rows={[incoming()]} now={new Date(2026, 9, 14, 12)} />);
    expect(screen.getByText("Viceroy · Front Office")).toBeInTheDocument();
    expect(screen.getByText("Billed to Viceroy (client)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reception banners" })).toHaveAttribute("href", "/requests/i1");
  });

  it("Incoming: a same-company row reads as it did, with no client line", () => {
    render(<IncomingRequestsTable rows={[same()]} now={new Date(2026, 9, 14, 12)} />);
    expect(screen.getByText("SEO")).toBeInTheDocument();
    expect(screen.queryByText(/Billed to/)).toBeNull();
  });

  it("Delivered: says who asked, the other company included", () => {
    render(<DeliveredRequestsTable rows={[incoming({ status: "delivered", closedAt: "2026-10-13T00:00:00Z" })]} />);
    expect(screen.getByText("Viceroy · Front Office")).toBeInTheDocument();
  });
});

describe("RequestForm with a route", () => {
  const route = { routeId: "5a0c0000-0000-4000-8000-000000000001", companyName: "Gaia Digital Agency", unitName: "Creatives", requestingCompanyName: "Viceroy" };
  const field = (label: string) => screen.getByLabelText(new RegExp(`^${label}`));
  const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
  const send = () => fireEvent.click(screen.getByRole("button", { name: "Send request" }));

  it("says 'To <unit> · <company>', says the work is billed to the company as a client, and offers no campaign picker", () => {
    render(<RequestForm kind="assets" toUnitId="" toUnitName="Creatives" campaigns={[{ partId: "p1", label: "Launch" }]} route={route} />);
    expect(screen.getByText("Creatives · Gaia Digital Agency")).toBeInTheDocument();
    expect(screen.getByText(/This is client work: Gaia Digital Agency bills Viceroy for it as a client/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Campaign/)).toBeNull();
    expect(screen.queryByText(/The campaigns could not be read/)).toBeNull();
  });

  it("is the same form per kind: assets ask for deliverables, engineering for the kind of change", () => {
    const first = render(<RequestForm kind="assets" toUnitId="" toUnitName="Creatives" campaigns={null} route={route} />);
    expect(screen.getByText("What you need")).toBeInTheDocument();
    first.unmount();
    render(<RequestForm kind="engineering" toUnitId="" toUnitName="Web Dev" campaigns={null} route={{ ...route, unitName: "Web Dev" }} />);
    expect(screen.getByLabelText(/^What kind of change/)).toBeInTheDocument();
    expect(screen.queryByText("What you need")).toBeNull();
  });

  it("sends through the outbound action with the route, then opens the sender's page", async () => {
    createOutboundRequestAction.mockResolvedValue({ ok: true, id: "r-9", receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" } });
    render(<RequestForm kind="assets" toUnitId="" toUnitName="Creatives" campaigns={null} route={route} />);
    type("Title", "  Banners ");
    type("Format", "image");
    type("Quantity", "3");
    send();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/requests/outbound/r-9"));
    expect(createRequestAction).not.toHaveBeenCalled();
    expect(createOutboundRequestAction).toHaveBeenCalledWith({
      routeId: route.routeId, kind: "assets", title: "Banners", form: { deliverables: [{ format: "image", size: "", quantity: 3 }] },
    });
  });

  it("still explains a mistake next to its field and does not ask the server", () => {
    render(<RequestForm kind="assets" toUnitId="" toUnitName="Creatives" campaigns={null} route={route} />);
    send();
    expect(screen.getByText("Give the request a title.")).toBeInTheDocument();
    expect(createOutboundRequestAction).not.toHaveBeenCalled();
  });

  it("shows a refusal as the sentence the action returned, and does not leave the page", async () => {
    createOutboundRequestAction.mockResolvedValue({ ok: false, error: "Gaia Digital Agency has not set your company up as a client yet. Ask an administrator.", reason: "group_client_missing" });
    render(<RequestForm kind="assets" toUnitId="" toUnitName="Creatives" campaigns={null} route={route} />);
    type("Title", "Banners");
    type("Format", "image");
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Gaia Digital Agency has not set your company up as a client yet. Ask an administrator.");
    expect(push).not.toHaveBeenCalled();
  });

  it("puts a 400 field refusal beside its field", async () => {
    createOutboundRequestAction.mockResolvedValue({ ok: false, error: "A title is 1 to 200 characters.", reason: "title_invalid", field: "title" });
    render(<RequestForm kind="assets" toUnitId="" toUnitName="Creatives" campaigns={null} route={route} />);
    type("Title", "Banners");
    type("Format", "image");
    send();
    await waitFor(() => expect(screen.getAllByText("A title is 1 to 200 characters.").length).toBe(2));
  });

  it("a form with no route still sends the ordinary request to its department", async () => {
    createRequestAction.mockResolvedValue({ ok: true, id: "r-3" });
    render(<RequestForm kind="assets" toUnitId="d-cre" toUnitName="Creatives" campaigns={[{ partId: "p1", label: "Launch" }]} />);
    expect(screen.getByLabelText(/^Campaign/)).toBeInTheDocument();
    type("Title", "Banners");
    type("Format", "image");
    send();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/requests/r-3"));
    expect(createOutboundRequestAction).not.toHaveBeenCalled();
  });
});

describe("Cancel on the sender's page", () => {
  const offered = { cancel: true, deliver: false, deliverMore: false, decline: false };

  it("cancels through the sender's route, under the asking company, and refreshes", async () => {
    cancelOutboundRequestAction.mockResolvedValue({ ok: true });
    render(<RequestActions requestId="x1" offered={offered} library={null} outbound />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(cancelOutboundRequestAction).toHaveBeenCalledWith("x1");
    expect(cancelRequestAction).not.toHaveBeenCalled();
  });

  it("shows the live-price 409 as a sentence under the control", async () => {
    cancelOutboundRequestAction.mockResolvedValue({ ok: false, error: "A price agreement is already open for this request, so it can no longer be cancelled here.", reason: "price_agreement_open" });
    render(<RequestActions requestId="x1" offered={offered} library={null} outbound />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert.parentElement!).getByRole("alert")).toHaveTextContent(/price agreement is already open/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the ordinary page still cancels through §32's route", async () => {
    cancelRequestAction.mockResolvedValue({ ok: true });
    render(<RequestActions requestId="r1" offered={offered} library={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(cancelRequestAction).toHaveBeenCalledWith("r1"));
    expect(cancelOutboundRequestAction).not.toHaveBeenCalled();
  });
});
