import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PrdFlowHeader } from "./PrdFlowHeader";

describe("PrdFlowHeader — the four beats, in order, with live counts", () => {
  it("names the four steps as verbs in the order a person does them", () => {
    render(<PrdFlowHeader counts={{ toCapture: 0, processing: 0, readyToConvert: 0, failed: 0, awaitingGm: 0, awaitingClient: 0, complete: 0 }} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/create a briefing/i);
    expect(items[1]).toMatch(/add the recording/i);
    expect(items[2]).toMatch(/convert to a prd run/i);
    expect(items[3]).toMatch(/get it approved/i);
  });

  it("shows what is waiting at each step, and stays quiet where nothing is", () => {
    render(<PrdFlowHeader counts={{ toCapture: 2, processing: 1, readyToConvert: 1, failed: 0, awaitingGm: 1, awaitingClient: 3, complete: 4 }} />);
    expect(screen.getByText(/2 waiting for a recording/i)).toBeInTheDocument();
    expect(screen.getByText(/1 transcribing/i)).toBeInTheDocument();
    expect(screen.getByText(/1 ready to convert/i)).toBeInTheDocument();
    expect(screen.getByText(/1 with the gm/i)).toBeInTheDocument();
    expect(screen.getByText(/3 with the client/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
});
