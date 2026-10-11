import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { NoWebsiteAccess, PortalWebsiteRefusal } from "./PortalWebsiteStates";
import { ConfirmAction } from "./ConfirmAction";

type Fail = Exclude<WdResult<unknown>, { kind: "ok" }>;
const show = (r: Fail) => render(<PortalWebsiteRefusal result={r} subject="your website" retryHref="/portal/website" />);

describe("the no-access page", () => {
  it("is the owner's sentence, a plain page, never a list", () => {
    render(<NoWebsiteAccess />);
    expect(screen.getByTestId("no-website-access").textContent).toBe("You don't have website editing access. Ask your company's admin.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Website");
  });
});

describe("a read that did not return data is a state, never an empty list", () => {
  it("the service is down: says so, says nothing was lost, offers Try again", () => {
    show({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    const n = screen.getByTestId("website-unavailable");
    expect(n.getAttribute("role")).toBe("status");
    expect(n.textContent).toContain("Editing is unavailable right now");
    expect(n.textContent).toContain("Nothing has been lost.");
    expect(n.textContent).not.toContain("circuit_open");
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/portal/website");
  });

  it("a contract drift is a louder, different state that does not claim the site is empty", () => {
    show({ kind: "unavailable", code: "contract_drift", reason: "clientEditable: expected object, got missing" });
    const n = screen.getByTestId("website-drift");
    expect(n.textContent).toContain("This does not mean there is nothing here.");
    expect(n.textContent).not.toContain("clientEditable");
  });

  it("a 403 is the no-access page", () => {
    show({ kind: "forbidden", reason: "forbidden" });
    expect(screen.getByTestId("no-website-access")).toBeTruthy();
  });

  it("a site or page that is not theirs is plain 'not available to you' (no hint it exists)", () => {
    show({ kind: "not_found", slug: "site-not-found" });
    expect(screen.getByTestId("website-not_found").textContent).toBe("This site isn't available to you.");
  });

  it("the module being off is plain words", () => {
    show({ kind: "not_enabled", reason: "module_disabled" });
    expect(screen.getByTestId("website-not_enabled").textContent).toBe("Website editing isn't available right now.");
  });
});

describe("ConfirmAction: a two-step button with a focus story", () => {
  const mount = (onConfirm = vi.fn()) => render(<ConfirmAction label="Publish now" question="Publish it?" confirmLabel="Yes, publish" testId="x" onConfirm={onConfirm} />);

  it("the first press only asks, and moves focus to the confirming button; Cancel restores focus to the button that asked", async () => {
    const onConfirm = vi.fn();
    mount(onConfirm);
    const ask = screen.getByTestId("x");
    ask.focus();
    fireEvent.click(ask);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId("x-confirm"));
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Confirm");
    expect(screen.getByRole("status").textContent).toBe("Publish it?");
    fireEvent.click(screen.getByTestId("x-cancel"));
    expect(document.activeElement).toBe(screen.getByTestId("x"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the second press does it, once, and returns to the first state", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    mount(onConfirm);
    fireEvent.click(screen.getByTestId("x"));
    await act(async () => { fireEvent.click(screen.getByTestId("x-confirm")); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("x")).toBeTruthy();
  });

  it("disabled and busy states are real", () => {
    const { rerender } = render(<ConfirmAction label="Publish now" question="q" confirmLabel="c" testId="x" onConfirm={vi.fn()} disabled />);
    expect((screen.getByTestId("x") as HTMLButtonElement).disabled).toBe(true);
    rerender(<ConfirmAction label="Publish now" question="q" confirmLabel="c" testId="x" onConfirm={vi.fn()} busy />);
    expect(screen.getByTestId("x").textContent).toBe("Working…");
  });
});
