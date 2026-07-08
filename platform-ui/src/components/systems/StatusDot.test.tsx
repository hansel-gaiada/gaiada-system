import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  it("ok=true renders Online", () => {
    render(<StatusDot ok={true} />);
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("ok=false renders Down", () => {
    render(<StatusDot ok={false} />);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("ok=null renders Unknown", () => {
    render(<StatusDot ok={null} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
