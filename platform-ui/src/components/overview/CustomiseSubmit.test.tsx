import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// DW-10d-3: the Customise button says it is working while its form posts, and keeps its accessible name.
const status = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), useFormStatus: () => ({ pending: status.pending }) }));

import { CustomiseSubmit } from "./CustomiseSubmit";

afterEach(() => { cleanup(); status.pending = false; });

describe("CustomiseSubmit (DW-10d-3)", () => {
  it("is a plain submit with the verb while idle", () => {
    render(<form><CustomiseSubmit verb="Hide" label="My activity" /></form>);
    const btn = screen.getByRole("button", { name: "Hide My activity" });
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).toHaveTextContent("Hide");
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute("aria-busy");
  });

  it("says Saving…, is disabled and busy while the form posts, under the same accessible name", () => {
    status.pending = true;
    render(<form><CustomiseSubmit verb="Switch on" label="Client health" /></form>);
    const btn = screen.getByRole("button", { name: "Switch on Client health" });
    expect(btn).toHaveTextContent("Saving…");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });
});
