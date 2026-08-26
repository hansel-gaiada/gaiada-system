import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BriefingComposer } from "./BriefingComposer";
import type { MeetingResult } from "@/lib/meetingsActions";

type StartAction = (prev: MeetingResult | null, formData: FormData) => Promise<MeetingResult>;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const clients = [{ id: "cl-1", name: "Cedar Group" }, { id: "cl-2", name: "Northwind" }];
const projects = [
  { id: "p-1", name: "Cedar site", client_id: "cl-1" },
  { id: "p-2", name: "Northwind SEO", client_id: "cl-2" },
];

describe("BriefingComposer — step 1, nothing records yet", () => {
  it("asks for the four things a briefing needs, and only those", () => {
    render(<BriefingComposer clients={clients} projects={projects} action={vi.fn(async () => ({ ok: true, id: "rec-9" }))} />);
    expect(screen.getByLabelText(/what is this briefing about/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^client/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/project/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^audio$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /audio \+ video/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create briefing/i })).toBeInTheDocument();
    expect(screen.getByText(/nothing records yet/i)).toBeInTheDocument();
  });

  it("only offers the projects that belong to the chosen client", () => {
    render(<BriefingComposer clients={clients} projects={projects} action={vi.fn(async () => ({ ok: true }))} />);
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    const options = Array.from((screen.getByLabelText(/project/i) as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toContain("Cedar site");
    expect(options).not.toContain("Northwind SEO");
  });

  it("submits title, client, project and the chosen medium to the start action", async () => {
    const action = vi.fn<StartAction>(async () => ({ ok: true, id: "rec-9" }));
    render(<BriefingComposer clients={clients} projects={projects} action={action} />);
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "Cedar — intake call" } });
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    fireEvent.change(screen.getByLabelText(/project/i), { target: { value: "p-1" } });
    fireEvent.click(screen.getByRole("radio", { name: /audio \+ video/i }));
    fireEvent.click(screen.getByRole("button", { name: /create briefing/i }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("title")).toBe("Cedar — intake call");
    expect(fd.get("clientId")).toBe("cl-1");
    expect(fd.get("projectId")).toBe("p-1");
    expect(fd.get("kind")).toBe("video");
  });

  it("confirms creation and points at the next step", async () => {
    const action = vi.fn(async () => ({ ok: true, id: "rec-9" }));
    render(<BriefingComposer clients={clients} projects={projects} action={action} />);
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "Cedar — intake call" } });
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    fireEvent.click(screen.getByRole("button", { name: /create briefing/i }));
    await waitFor(() => expect(screen.getByText(/briefing created/i)).toBeInTheDocument());
    expect(screen.getByText(/add its recording/i)).toBeInTheDocument();
  });

  it("shows the server's error next to the button, not a silent failure", async () => {
    const action = vi.fn(async () => ({ ok: false, error: "No active company selected." }));
    render(<BriefingComposer clients={clients} projects={projects} action={action} />);
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    fireEvent.click(screen.getByRole("button", { name: /create briefing/i }));
    await waitFor(() => expect(screen.getByText(/no active company selected/i)).toBeInTheDocument());
  });
});
