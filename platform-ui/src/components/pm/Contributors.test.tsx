import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Contributors } from "./Contributors";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("Contributors (TR-32)", () => {
  it("degrades honestly when contributors is undefined — never a false empty state", () => {
    render(
      <Contributors
        contributors={undefined}
        ownerId="u-owner"
        ownerName="Owner Person"
        candidates={[{ id: "u-a", name: "A" }]}
        canEdit
        add={vi.fn()}
        remove={vi.fn()}
      />,
    );
    // Must not render the real-empty-list copy ("No contributors yet") — that
    // would misleadingly imply "confirmed: nobody contributed".
    expect(screen.queryByText("No contributors yet.")).not.toBeInTheDocument();
    expect(screen.getByText(/isn't available from this backend/i)).toBeInTheDocument();
    // The add picker is withheld too — adding against unknown backend support
    // is not the same discoverable affordance as a confirmed-supported empty list.
    expect(screen.queryByText("Add a contributor…")).not.toBeInTheDocument();
  });

  it("renders a real empty list distinctly from the undefined/absent case", () => {
    render(
      <Contributors
        contributors={[]}
        ownerId="u-owner"
        ownerName="Owner Person"
        candidates={[{ id: "u-a", name: "A" }]}
        canEdit
        add={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(screen.getByText("No contributors yet.")).toBeInTheDocument();
  });

  it("renders owner and contributor as visually distinct groups (owner-takes-all attribution)", () => {
    render(
      <Contributors
        contributors={[{ userId: "u-c", name: "Contributor Person" }]}
        ownerId="u-owner"
        ownerName="Owner Person"
        candidates={[]}
        canEdit
        add={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(screen.getByText("Owner · outcome-credited")).toBeInTheDocument();
    expect(screen.getByText("Contributors · hours only, no outcome credit")).toBeInTheDocument();
    const ownerLink = screen.getByText("Owner Person").closest(".pm-contributor");
    const contribLink = screen.getByText("Contributor Person").closest(".pm-contributor");
    expect(ownerLink?.className).toContain("pm-contributor--owner");
    expect(contribLink?.className).not.toContain("pm-contributor--owner");
  });

  it("removes a contributor via its Remove button", () => {
    const add = vi.fn().mockResolvedValue({ ok: true });
    const remove = vi.fn().mockResolvedValue({ ok: true });
    render(
      <Contributors
        contributors={[{ userId: "u-c", name: "Contributor Person" }]}
        ownerId="u-owner"
        ownerName="Owner Person"
        candidates={[{ id: "u-new", name: "New Person" }]}
        canEdit
        add={add}
        remove={remove}
      />,
    );
    fireEvent.click(screen.getByText("Remove"));
    expect(remove).toHaveBeenCalledWith("u-c");
  });

  it("adds a contributor via the picker", () => {
    const add = vi.fn().mockResolvedValue({ ok: true });
    const remove = vi.fn().mockResolvedValue({ ok: true });
    render(
      <Contributors
        contributors={[]}
        ownerId="u-owner"
        ownerName="Owner Person"
        candidates={[{ id: "u-new", name: "New Person" }]}
        canEdit
        add={add}
        remove={remove}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "u-new" } });
    fireEvent.click(screen.getByText("Add"));
    expect(add).toHaveBeenCalledWith("u-new");
  });

  it("hides edit affordances when canEdit is false (update-level, not manage-level, gate lives in the caller)", () => {
    render(
      <Contributors
        contributors={[{ userId: "u-c", name: "Contributor Person" }]}
        ownerId="u-owner"
        ownerName="Owner Person"
        candidates={[{ id: "u-new", name: "New Person" }]}
        canEdit={false}
        add={vi.fn()}
        remove={vi.fn()}
      />,
    );
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
    expect(screen.queryByText("Add")).not.toBeInTheDocument();
  });
});
