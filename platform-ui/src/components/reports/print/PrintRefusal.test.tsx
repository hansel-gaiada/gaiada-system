import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrintRefusal } from "./PrintRefusal";

describe("PrintRefusal — the honest degrade for a missing/invalid/expired/burned jobToken", () => {
  it("renders an alert with a clear message and no internal detail (no token, no reason code)", () => {
    render(<PrintRefusal />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/can.t be rendered/i);
    expect(alert.textContent).toMatch(/single-use/i);
    expect(alert.textContent).not.toMatch(/not_found|malformed|upstream_error|jobToken|token[= ]/i);
  });
});
