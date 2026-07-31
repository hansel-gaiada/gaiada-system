import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrintMark } from "./PrintMark";

describe("PrintMark — the §6.3/§15 mandatory PDF provenance banner", () => {
  it("an unsealed document renders the exact AD HOC · UNSEALED wording, styled as the ad-hoc variant", () => {
    render(
      <PrintMark
        header={{ sealed: false, generatedAt: "2026-07-31T09:00:00.000Z" }}
        position="top"
      />,
    );
    const el = screen.getByRole("note", { name: "Document provenance" });
    expect(el.textContent).toBe("AD HOC · UNSEALED · as of 2026-07-31T09:00:00.000Z");
    expect(el.className).toContain("tr20-mark--adhoc");
    expect(el.className).toContain("tr20-mark--top");
    expect(el.className).not.toContain("tr20-mark--sealed");
  });

  it("a sealed document renders the exact SEALED · rev N · <hash prefix> wording, styled as sealed", () => {
    render(
      <PrintMark
        header={{ sealed: true, revision: 3, generatedAt: "2026-07-31T09:00:00.000Z" }}
        sealHash="aa11bb22cc33dd44"
        position="bottom"
      />,
    );
    const el = screen.getByRole("note", { name: "Document provenance" });
    expect(el.textContent).toBe("SEALED · rev 3 · aa11bb22cc33");
    expect(el.className).toContain("tr20-mark--sealed");
    expect(el.className).toContain("tr20-mark--bottom");
    expect(el.className).not.toContain("tr20-mark--adhoc");
  });

  it("a sealed document with no sealHash still renders (as 'unknown'), never crashing", () => {
    render(<PrintMark header={{ sealed: true, generatedAt: "2026-07-31T09:00:00.000Z" }} position="top" />);
    expect(screen.getByRole("note").textContent).toBe("SEALED · rev 0 · unknown");
  });
});
