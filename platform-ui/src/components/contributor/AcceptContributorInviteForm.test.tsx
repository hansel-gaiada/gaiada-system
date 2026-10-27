import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// M5-W1f: the contributor's accept page. Real form and real server action; only the network call and next/link are stubbed. What matters: the token
// travels in the request BODY to the contributor accept route (never the URL, never a query string), and the page is at a path that is not the client's.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { AcceptContributorInviteForm } from "./AcceptContributorInviteForm";
import { acceptContributorInviteAction } from "@/lib/contributorInviteActions";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const TOKEN = "ctr1.abcdefghijklmnop.sig";
const res = (status: number, body: Record<string, unknown>) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("token", TOKEN); f.set("password", "a-long-enough-password"); f.set("confirm", "a-long-enough-password");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

describe("acceptContributorInviteAction", () => {
  it("posts the token in the JSON BODY to the contributor accept route, with no token in the URL", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, email: "ayu@example.test", status: "active", accountPath: "created", secondFactor: "otp_required" }));
    const r = await acceptContributorInviteAction(null, fd());
    expect(r).toEqual({ ok: true, email: "ayu@example.test", existingAccount: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/editorial-invites\/accept$/);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("?");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, password: "a-long-enough-password" });
    expect(JSON.stringify(init.headers ?? {})).not.toContain(TOKEN);
  });

  it("an existing re-enabled account is reported as such (its password was not touched)", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, email: "ayu@example.test", status: "active", accountPath: "existing_reenabled", secondFactor: "otp_required" }));
    expect(await acceptContributorInviteAction(null, fd())).toEqual({ ok: true, email: "ayu@example.test", existingAccount: true });
  });

  it("the coarse 400 is one terminal answer that does not say why", async () => {
    fetchMock.mockResolvedValue(res(400, { error: "contributor_invite_invalid", reason: "contributor_invite_invalid" }));
    const r = await acceptContributorInviteAction(null, fd());
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(r.ok ? "" : r.error).toMatch(/no longer usable/);
  });

  it("the missing-Keycloak 503 never shows the operator detail", async () => {
    fetchMock.mockResolvedValue(res(503, { error: "keycloak_admin_not_configured" }));
    const r = await acceptContributorInviteAction(null, fd());
    expect(r.ok ? "" : r.error).not.toMatch(/keycloak/i);
  });

  it("a short or mismatched password never reaches the network; a transport failure is retryable", async () => {
    expect(await acceptContributorInviteAction(null, fd({ password: "short", confirm: "short" }))).toMatchObject({ ok: false, retryable: true });
    expect(await acceptContributorInviteAction(null, fd({ confirm: "different-different" }))).toMatchObject({ ok: false, retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await acceptContributorInviteAction(null, fd())).toMatchObject({ ok: false, retryable: true });
  });
});

describe("AcceptContributorInviteForm", () => {
  it("carries the token as a hidden field of the form body (no action URL with a token)", () => {
    const { container } = render(<AcceptContributorInviteForm token={TOKEN} />);
    const hidden = container.querySelector('input[type="hidden"][name="token"]') as HTMLInputElement;
    expect(hidden.value).toBe(TOKEN);
    expect(container.querySelector("form")?.getAttribute("action") ?? "").not.toContain(TOKEN);
  });

  it("submitting reaches the contributor route and then says two-step sign-in comes next", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true, email: "ayu@example.test", accountPath: "created" }));
    const { container } = render(<AcceptContributorInviteForm token={TOKEN} />);
    const pw = container.querySelector('input[name="password"]') as HTMLInputElement;
    const cf = container.querySelector('input[name="confirm"]') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "a-long-enough-password" } });
    fireEvent.change(cf, { target: { value: "a-long-enough-password" } });
    await act(async () => { fireEvent.submit(container.querySelector("form") as HTMLFormElement); });
    expect(await screen.findByTestId("contributor-accept-done")).toBeTruthy();
    expect(screen.getByTestId("contributor-accept-done").textContent).toMatch(/two-step sign-in/);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/editorial-invites\/accept/);
  });
});
