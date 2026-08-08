import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PortalChangeRequestForm } from "./PortalChangeRequestForm";

// MI-04 — render-only: this suite never fires a submit event. `useActionState`'s action is
// `portalSubmitChangeRequest` (a `"use server"` export that resolves the session/tenant via
// `next/headers`), which has no meaning outside a real Next request — firing a submit here would
// exercise that path in jsdom rather than the form's own rendering logic. What IS worth pinning
// without a network round trip is exactly the "subtle AC" the design doc calls out: what the project
// selector offers for each of the two caller shapes, plus the always-present labels/required-ness a11y
// depends on.
const PROJECTS = [
  { id: "p-1", name: "Website relaunch" },
  { id: "p-2", name: "Brand refresh" },
];

describe("PortalChangeRequestForm", () => {
  it("a client-wide contact sees the 'whole account' option alongside their projects", () => {
    render(<PortalChangeRequestForm allowClientWide projects={PROJECTS} />);
    const select = screen.getByLabelText(/which project is this for/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain("");
    expect(values).toEqual(["", "p-1", "p-2"]);
    expect(select).not.toBeRequired();
  });

  it("a project-scoped contact gets NO 'whole account' option and must name a project", () => {
    render(<PortalChangeRequestForm allowClientWide={false} projects={PROJECTS} />);
    const select = screen.getByLabelText(/which project is this for/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).not.toContain("");
    expect(values).toEqual(["p-1", "p-2"]);
    expect(select).toBeRequired();
  });

  it("a project-scoped contact with no project yet gets a teach-state instead of a dead-end submit", () => {
    render(<PortalChangeRequestForm allowClientWide={false} projects={[]} />);
    expect(screen.getByText(/don't have a project on your account yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/which project is this for/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send request/i })).toBeDisabled();
  });

  it("every field has an accessible label (a11y)", () => {
    render(<PortalChangeRequestForm allowClientWide projects={PROJECTS} />);
    expect(screen.getByLabelText(/what kind of request is this/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/in a few words/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/details \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/which project is this for/i)).toBeInTheDocument();
  });

  it("offers all four request kinds", () => {
    render(<PortalChangeRequestForm allowClientWide projects={PROJECTS} />);
    const select = screen.getByLabelText(/what kind of request is this/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value).sort()).toEqual(["bug", "content", "design", "feature"]);
  });
});
