import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// The accept page for a client-contact invite. When the platform reports `existingAccount: true` the person's
// login was left untouched (the password typed here was ignored), so the page must say "sign in with your
// existing account" and must not imply a new password was created. Real form and real server action; only the
// network call (global fetch) and next/link are stubbed.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { AcceptInviteForm } from "./AcceptInviteForm";
import { acceptInviteAction } from "@/lib/inviteActions";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const okResponse = (extra: Record<string, unknown>) =>
  ({ ok: true, status: 200, json: async () => ({ ok: true, email: "pat@example.test", status: "active", portalPath: "/portal", ...extra }) }) as unknown as Response;

function fd(): FormData {
  const f = new FormData();
  f.set("token", "inv1.tok");
  f.set("password", "a-long-enough-password");
  f.set("confirm", "a-long-enough-password");
  return f;
}

describe("acceptInviteAction", () => {
  it("passes existingAccount: true through", async () => {
    fetchMock.mockResolvedValue(okResponse({ existingAccount: true }));
    expect(await acceptInviteAction(null, fd())).toEqual({ ok: true, email: "pat@example.test", existingAccount: true });
  });
  it("treats a missing existingAccount (older API) as a new account", async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    expect(await acceptInviteAction(null, fd())).toEqual({ ok: true, email: "pat@example.test", existingAccount: false });
  });
});

describe("AcceptInviteForm", () => {
  async function submit() {
    const { container } = render(<AcceptInviteForm token="inv1.tok" clientName="Acme" />);
    const form = container.querySelector("form")!;
    (form.querySelector('input[name="password"]') as HTMLInputElement).value = "a-long-enough-password";
    (form.querySelector('input[name="confirm"]') as HTMLInputElement).value = "a-long-enough-password";
    await act(async () => { fireEvent.submit(form); });
  }

  it("existing account: says to sign in with it, and never mentions the password just chosen", async () => {
    fetchMock.mockResolvedValue(okResponse({ existingAccount: true }));
    await submit();
    expect(await screen.findByText(/You already have an account\. Sign in with it to open your portal\. If you have forgotten its password, ask\s+your project manager to reset it\./)).toBeTruthy();
    expect(screen.queryByText(/password you just chose/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("the form no longer hints that an existing account's password can be set here", async () => {
    render(<AcceptInviteForm token="inv1.tok" clientName="Acme" />);
    expect(screen.queryByText(/keeps its\s+current password/i)).toBeNull();
  });

  it("new account: still says to sign in with the password just chosen", async () => {
    fetchMock.mockResolvedValue(okResponse({ existingAccount: false }));
    await submit();
    expect(await screen.findByText(/password you just chose/i)).toBeTruthy();
    expect(screen.queryByText(/You already have an account/)).toBeNull();
  });
});
