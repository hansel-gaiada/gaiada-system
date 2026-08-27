import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CreateRepoForm, type CreateRepoFormActions } from "./CreateRepoForm";
import type { ProvisionedSite } from "@/lib/webdevProvisionedSites";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const runs = [
  { id: "run-3", title: "Northwind — Checkout scope", clientName: "Northwind Traders", retry: false },
  { id: "run-2", title: "Lumen — portfolio discovery", clientName: "Lumen Studio", retry: true },
];
const provisioned = { ok: true as const, site: { status: "pending", slug: "northwind-checkout-scope" } as ProvisionedSite };
const actions = (over: Partial<CreateRepoFormActions> = {}): CreateRepoFormActions => ({ provision: vi.fn(async () => provisioned), ...over });

describe("CreateRepoForm — standalone (the default): a repository with no PRD run", () => {
  it("defaults to standalone: name + framework only, and provisions with no runId", async () => {
    const provision = vi.fn<CreateRepoFormActions["provision"]>(async () => ({ ok: true, site: { status: "pending", slug: "marketing-microsite" } as ProvisionedSite }));
    render(<CreateRepoForm runs={runs} actions={actions({ provision })} prdHref="/departments/dept-1/prd" />);
    expect(screen.getByRole("radio", { name: /standalone/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("combobox", { name: /prd run/i })).not.toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: /repository name/i });
    expect(screen.getByRole("button", { name: /^create repository$/i })).toBeDisabled(); // no name yet
    fireEvent.change(name, { target: { value: "marketing-microsite" } });
    fireEvent.click(screen.getByRole("button", { name: /^create repository$/i }));
    await waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
    const fd = provision.mock.calls[0][0];
    expect(fd.get("runId")).toBeNull();
    expect(fd.get("slug")).toBe("marketing-microsite");
    expect(fd.get("framework")).toBe("vite");
  });

  it("says plainly that a standalone repo is not linked to a client or project", () => {
    render(<CreateRepoForm runs={runs} actions={actions()} prdHref="/departments/dept-1/prd" />);
    expect(screen.getByText(/not linked to a client or project/i)).toBeInTheDocument();
  });

  it("with no eligible run, the PRD-run mode explains itself but standalone still works", () => {
    render(<CreateRepoForm runs={[]} actions={actions()} prdHref="/departments/dept-1/prd" />);
    expect(screen.getByRole("textbox", { name: /repository name/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /for a prd run/i }));
    expect(screen.getByText(/every prd run in this department already has a repository, or there are no runs yet/i)).toBeInTheDocument();
  });
});

describe("CreateRepoForm — for a PRD run", () => {
  it("offers only eligible runs, pre-fills the name from the chosen run, and provisions with run + framework + name", async () => {
    const provision = vi.fn<CreateRepoFormActions["provision"]>(async () => provisioned);
    render(<CreateRepoForm runs={runs} actions={actions({ provision })} prdHref="/departments/dept-1/prd" />);
    fireEvent.click(screen.getByRole("radio", { name: /for a prd run/i }));
    const runSelect = screen.getByRole("combobox", { name: /prd run/i });
    expect(Array.from((runSelect as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(["Choose a run…", "Northwind — Checkout scope · Northwind Traders", "Lumen — portfolio discovery · Lumen Studio (previous attempt failed)"]);
    fireEvent.change(runSelect, { target: { value: "run-3" } });
    const name = screen.getByRole("textbox", { name: /repository name/i }) as HTMLInputElement;
    expect(name.value).toBe("northwind-checkout-scope");
    fireEvent.change(screen.getByRole("combobox", { name: /framework/i }), { target: { value: "nextjs" } });
    fireEvent.click(screen.getByRole("button", { name: /^create repository$/i }));
    await waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
    const fd = provision.mock.calls[0][0];
    expect(fd.get("runId")).toBe("run-3");
    expect(fd.get("framework")).toBe("nextjs");
    expect(fd.get("slug")).toBe("northwind-checkout-scope");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/northwind-checkout-scope.*is being provisioned/i));
  });

  it("a bad name is refused before anything is sent, in plain words", async () => {
    const provision = vi.fn<CreateRepoFormActions["provision"]>(async () => provisioned);
    render(<CreateRepoForm runs={runs} actions={actions({ provision })} prdHref="/departments/dept-1/prd" />);
    fireEvent.click(screen.getByRole("radio", { name: /for a prd run/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /prd run/i }), { target: { value: "run-3" } });
    fireEvent.change(screen.getByRole("textbox", { name: /repository name/i }), { target: { value: "Not A Slug!" } });
    expect(screen.getByText(/lowercase letters, digits and hyphens/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create repository$/i })).toBeDisabled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("the platform's refusal is shown next to the button", async () => {
    const provision = vi.fn<CreateRepoFormActions["provision"]>(async () => ({ ok: false, error: "That name is already used by another site in this company." }));
    render(<CreateRepoForm runs={runs} actions={actions({ provision })} prdHref="/departments/dept-1/prd" />);
    fireEvent.click(screen.getByRole("radio", { name: /for a prd run/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /prd run/i }), { target: { value: "run-3" } });
    fireEvent.click(screen.getByRole("button", { name: /^create repository$/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already used by another site/i));
  });

});
