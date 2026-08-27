import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectBriefings } from "./ProjectBriefings";
import type { MeetingRecording } from "@/lib/meetings";
import type { PipelineGate, PipelineRun } from "@/lib/pipeline";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const rec = (over: Partial<MeetingRecording> & { id: string }): MeetingRecording => ({
  meeting_id: `mtg-${over.id}`, client_id: "cl-1", project_id: "p-web-1", department_id: "dept-1", title: "Kickoff", kind: "audio", status: "recording",
  started_at: null, ended_at: null, duration_sec: null, size_bytes: null, drive_status: "none", drive_link: null,
  pipeline_run_id: null, created_by: "u-1", created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z", ...over,
});
const run: PipelineRun = { id: "run-1", title: "Kickoff", status: "extracting", source_meeting_id: "mtg-r1", mom_ref: null, created_at: "2026-08-21T00:00:00Z", updated_at: "2026-08-21T00:00:00Z", client_id: "cl-1", project_id: "p-web-1" };
const gates: PipelineGate[] = [{ id: "g", run_id: "run-1", stage_id: null, kind: "prd_review", actor_side: "internal", status: "pending", decision: null, note: null, decided_by: null, decided_at: null, created_at: "2026-08-21T01:00:00Z" }];
const actions = {
  createBriefing: vi.fn(async () => ({ ok: true })),
  upload: vi.fn(async () => ({ ok: true, id: "x", audioRef: "a" })),
  retry: vi.fn(async () => ({ ok: true, id: "x" })),
  setTranscript: vi.fn(async () => ({ ok: true, id: "x" })),
  ingest: vi.fn(async () => ({ ok: true, id: "x" })),
  startRunManually: vi.fn(async () => ({ ok: true })),
  decideGate: vi.fn(async () => {}),
};

describe("ProjectBriefings — the PRD Studio flow, filed under one project", () => {
  it("composer is fixed to this project, briefings are cards in action order, runs show their approvals", () => {
    render(
      <ProjectBriefings
        project={{ id: "p-web-1", name: "Client site redesign", clientId: "cl-1", clientName: "Northwind Traders" }}
        recordings={[rec({ id: "a", title: "Intake call" }), rec({ id: "b", title: "Scope call", status: "transcribed", created_at: "2026-08-10T00:00:00Z" }), rec({ id: "r1", meeting_id: "mtg-r1", title: "Kickoff", status: "ingested", created_at: "2026-07-01T00:00:00Z" })]}
        runs={[{ run, gates }]}
        mayDecide
        actions={actions}
        prdHref="/departments/dept-1/prd"
      />,
    );
    expect(screen.getByText(/filed under client site redesign · northwind traders/i)).toBeInTheDocument();
    const cards = screen.getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Scope call", "Intake call"]); // ready first; old ingested one not a card
    expect(screen.getByRole("link", { name: "Kickoff" })).toHaveAttribute("href", "/pipeline/run-1");
    expect(screen.getByText(/waiting on gm/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /prd studio/i })).toHaveAttribute("href", "/departments/dept-1/prd");
  });

  it("with nothing yet, it says how a briefing becomes a PRD here", () => {
    render(<ProjectBriefings project={{ id: "p", name: "P", clientId: null, clientName: null }} recordings={[]} runs={[]} mayDecide={false} actions={actions} prdHref="/x/prd" />);
    expect(screen.getByText(/no briefings for this project yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no prd runs for this project yet/i)).toBeInTheDocument();
  });
});
