import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PortalChangeRequestForm } from "./PortalChangeRequestForm";
import { wholeAccountValue } from "@/lib/portal";

// MI-04 — render-only: this suite never fires a submit event. `useActionState`'s action is
// `portalSubmitChangeRequest` (a `"use server"` export that resolves the session/tenant via
// `next/headers`), which has no meaning outside a real Next request — firing a submit here would
// exercise that path in jsdom rather than the form's own rendering logic. What IS worth pinning
// without a network round trip is exactly the "subtle AC" the design doc calls out: what the project
// selector offers for each of the caller shapes, plus the always-present labels/required-ness a11y
// depends on.
//
// PV4-13: the whole-account option is PER CLIENT (`wideClients`, from the profile's `access.wideClientIds`).
const PROJECTS = [
  { id: "p-1", name: "Website relaunch" },
  { id: "p-2", name: "Brand refresh" },
];
const NORTHWIND = { id: "c-a", name: "Northwind" };
const CONTOSO = { id: "c-b", name: "Contoso" };

describe("PortalChangeRequestForm", () => {
  it("a client-wide contact sees the 'whole account' option alongside their projects", () => {
    render(<PortalChangeRequestForm wideClients={[NORTHWIND]} projects={PROJECTS} />);
    const select = screen.getByLabelText(/which project is this for/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual([wholeAccountValue("c-a"), "p-1", "p-2"]);
    expect([...select.options][0].textContent).toBe("Your whole account");
    expect(select.value).toBe(wholeAccountValue("c-a"));
    expect(select).not.toBeRequired();
  });

  it("a project-scoped contact gets NO 'whole account' option and must name a project", () => {
    render(<PortalChangeRequestForm wideClients={[]} projects={PROJECTS} />);
    const select = screen.getByLabelText(/which project is this for/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values.some((v) => v.startsWith("client:"))).toBe(false);
    expect(values).toEqual(["p-1", "p-2"]);
    expect(select).toBeRequired();
  });

  it("client-wide on A and project-scoped on B: whole account for A only, and B's projects stay selectable", () => {
    // The profile says wideClientIds = [A]; B appears nowhere in `wideClients`, so no option can name it.
    render(<PortalChangeRequestForm wideClients={[NORTHWIND]} projects={[...PROJECTS, { id: "p-b1", name: "Contoso site" }]} />);
    const select = screen.getByLabelText(/which project is this for/i) as HTMLSelectElement;
    const options = [...select.options];
    expect(options.map((o) => o.value)).toEqual([wholeAccountValue("c-a"), "p-1", "p-2", "p-b1"]);
    expect(options.map((o) => o.value)).not.toContain(wholeAccountValue("c-b"));
    expect(screen.getByRole("option", { name: "Contoso site" })).toBeInTheDocument();
  });

  it("client-wide on SEVERAL clients: one whole-account option per client, each named", () => {
    render(<PortalChangeRequestForm wideClients={[NORTHWIND, CONTOSO]} projects={PROJECTS} />);
    const select = screen.getByLabelText(/which project is this for/i) as HTMLSelectElement;
    const options = [...select.options];
    expect(options.slice(0, 2).map((o) => [o.value, o.textContent])).toEqual([
      [wholeAccountValue("c-a"), "Whole account: Northwind"],
      [wholeAccountValue("c-b"), "Whole account: Contoso"],
    ]);
  });

  it("a project-scoped contact with no project yet gets a teach-state instead of a dead-end submit", () => {
    render(<PortalChangeRequestForm wideClients={[]} projects={[]} />);
    expect(screen.getByText(/don't have a project on your account yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/which project is this for/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send request/i })).toBeDisabled();
  });

  it("every field has an accessible label (a11y)", () => {
    render(<PortalChangeRequestForm wideClients={[NORTHWIND]} projects={PROJECTS} />);
    expect(screen.getByLabelText(/what kind of request is this/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/in a few words/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/details \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/which project is this for/i)).toBeInTheDocument();
  });

  it("offers all four request kinds", () => {
    render(<PortalChangeRequestForm wideClients={[NORTHWIND]} projects={PROJECTS} />);
    const select = screen.getByLabelText(/what kind of request is this/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value).sort()).toEqual(["bug", "content", "design", "feature"]);
  });
});
