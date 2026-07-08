import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EmptyNote } from "./EmptyNote";

describe("EmptyNote", () => {
  it("renders its children", () => {
    render(<EmptyNote>Agent goals appear once the agents admin API is connected.</EmptyNote>);
    expect(screen.getByText("Agent goals appear once the agents admin API is connected.")).toBeInTheDocument();
  });
});
