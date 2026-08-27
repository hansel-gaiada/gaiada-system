import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BriefingComposer } from "./BriefingComposer";
import type { BriefingResult } from "@/lib/prdActions";

type StartAction = (prev: BriefingResult | null, formData: FormData) => Promise<BriefingResult>;

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
    expect(screen.getByRole("radio", { name: /new project/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /link an existing project/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("combobox", { name: /^project/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^audio$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /audio \+ video/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create briefing/i })).toBeInTheDocument();
    expect(screen.getByText(/nothing records yet/i)).toBeInTheDocument();
  });

  it("the default explains that a project is created with the briefing, named after it", () => {
    render(<BriefingComposer clients={clients} projects={projects} departmentName="Web Dev" action={vi.fn(async () => ({ ok: true }))} />);
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "Cedar — intake call" } });
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    expect(screen.getByText(/a web dev project “cedar — intake call” is created for cedar group/i)).toBeInTheDocument();
  });

  it("link mode offers only the chosen client's projects in this department", () => {
    render(<BriefingComposer clients={clients} projects={projects} action={vi.fn(async () => ({ ok: true }))} />);
    fireEvent.click(screen.getByRole("radio", { name: /link an existing project/i }));
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    const options = Array.from((screen.getByRole("combobox", { name: /^project/i }) as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toContain("Cedar site");
    expect(options).not.toContain("Northwind SEO");
  });

  it("a client with no project in this department gets told where to make one, not a dead select", () => {
    render(<BriefingComposer clients={clients} projects={[projects[0]]} departmentName="Web Dev" action={vi.fn(async () => ({ ok: true }))} />);
    fireEvent.click(screen.getByRole("radio", { name: /link an existing project/i }));
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-2" } });
    expect(screen.getByText(/no web dev project for northwind yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create briefing/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /new project/i }));
    expect(screen.getByRole("button", { name: /create briefing/i })).toBeEnabled();
  });

  it("submits title, client, the project choice and the chosen medium to the action", async () => {
    const action = vi.fn<StartAction>(async () => ({ ok: true, id: "rec-9" }));
    render(<BriefingComposer clients={clients} projects={projects} departmentId="dept-1" action={action} />);
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "Cedar — intake call" } });
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    fireEvent.click(screen.getByRole("radio", { name: /audio \+ video/i }));
    fireEvent.click(screen.getByRole("button", { name: /create briefing/i }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("title")).toBe("Cedar — intake call");
    expect(fd.get("clientId")).toBe("cl-1");
    expect(fd.get("kind")).toBe("video");
    expect(fd.get("projectMode")).toBe("new");
    expect(fd.get("departmentId")).toBe("dept-1");
  });

  it("link mode submits the chosen project id", async () => {
    const action = vi.fn<StartAction>(async () => ({ ok: true, id: "rec-9" }));
    render(<BriefingComposer clients={clients} projects={projects} departmentId="dept-1" action={action} />);
    fireEvent.click(screen.getByRole("radio", { name: /link an existing project/i }));
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "Follow-up" } });
    fireEvent.change(screen.getByLabelText(/^client/i), { target: { value: "cl-1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^project/i }), { target: { value: "p-1" } });
    fireEvent.click(screen.getByRole("button", { name: /create briefing/i }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("projectMode")).toBe("existing");
    expect(fd.get("projectId")).toBe("p-1");
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

describe("BriefingComposer — fixed lineage (inside a project workspace)", () => {
  it("shows where the briefing is filed instead of asking, and submits that client and project", async () => {
    const action = vi.fn<StartAction>(async () => ({ ok: true, id: "rec-9" }));
    render(<BriefingComposer clients={[]} projects={[]} action={action} fixed={{ clientId: "cl-1", clientName: "Northwind Traders", projectId: "p-web-1", projectName: "Client site redesign" }} />);
    expect(screen.getByText(/filed under client site redesign · northwind traders/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /client/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /new project/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/what is this briefing about/i), { target: { value: "Sprint 3 review" } });
    fireEvent.click(screen.getByRole("button", { name: /create briefing/i }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("clientId")).toBe("cl-1");
    expect(fd.get("projectMode")).toBe("existing");
    expect(fd.get("projectId")).toBe("p-web-1");
  });
});
