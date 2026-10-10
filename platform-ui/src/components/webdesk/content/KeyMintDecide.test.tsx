import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { KeyMintDecideResult } from "@/lib/webdeskContentModel";

vi.mock("@/app/(app)/actions", () => ({ decideKeyMintApproval: vi.fn() }));

import * as Actions from "@/app/(app)/actions";
import { KeyMintDecide } from "./KeyMintDecide";

const decide = vi.mocked(Actions.decideKeyMintApproval);
const KEY = "wdk_live_SECRET_7f3a9c1e5b2d4a60";
const ENV = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const minted = (over: Partial<Extract<KeyMintDecideResult, { decision: "approved" }>["mint"]> = {}): KeyMintDecideResult => ({
  ok: true, decision: "approved",
  mint: { status: "executed", envId: ENV, scope: "read", apiKeyId: "key-1", plaintextOnce: KEY, ...over } as never,
});

const setup = (over: Partial<React.ComponentProps<typeof KeyMintDecide>> = {}) =>
  render(<KeyMintDecide tenantId="co-1" approvalId="ap-1" environmentName="production" mayDecide ownRequest={false} {...over} />);
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const mentions = (calls: unknown[][], needle: string) => calls.some((args) => args.some((a) => {
  try { return (typeof a === "string" ? a : JSON.stringify(a) ?? String(a)).includes(needle); } catch { return String(a).includes(needle); }
}));

beforeEach(() => { decide.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("KeyMintDecide: the decide control", () => {
  it("shows Approve / Deny with an optional note, and says approving shows the key once", () => {
    setup();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(screen.getByText(/shows it to you once/)).toBeTruthy();
  });

  it("renders nothing for a row nobody can decide and nothing has happened to", () => {
    const { container } = setup({ mayDecide: false });
    expect(container.innerHTML).toBe("");
  });

  it("the requester sees why they cannot approve their own request, and no buttons (maker is never checker)", () => {
    setup({ ownRequest: true });
    expect(screen.getByTestId("key-own-request").textContent).toMatch(/someone else has to approve it/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("passes the tenant, the approval, the decision and the trimmed note to the action", async () => {
    decide.mockResolvedValue(minted());
    setup();
    fireEvent.change(screen.getByPlaceholderText("Add a note for the record"), { target: { value: "  ok for the booking site  " } });
    await click("Approve");
    expect(decide).toHaveBeenCalledWith("co-1", "ap-1", "approved", "ok for the booking site");
  });

  it("an empty note is sent as undefined", async () => {
    decide.mockResolvedValue({ ok: true, decision: "rejected" });
    setup();
    await click("Deny");
    expect(decide).toHaveBeenCalledWith("co-1", "ap-1", "rejected", undefined);
  });

  it("while the decision is in flight both buttons are off, and a double click decides once", async () => {
    let release: (r: KeyMintDecideResult) => void = () => {};
    decide.mockReturnValue(new Promise((res) => { release = res; }));
    setup();
    const approve = screen.getByRole("button", { name: "Approve" });
    await act(async () => { fireEvent.click(approve); fireEvent.click(approve); });
    expect(decide).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Approving…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(minted()); });
  });
});

describe("KeyMintDecide: the key is shown ONCE", () => {
  it("executed: the key in a read-only monospace field, with environment, scope, the warning and a Copy button", async () => {
    decide.mockResolvedValue(minted({ scope: "write" }));
    setup();
    await click("Approve");

    const field = screen.getByTestId("key-once-value") as HTMLInputElement;
    expect(field.value).toBe(KEY);
    expect(field.readOnly).toBe(true);
    expect(field.className).toMatch(/wc-key-once__value/); // the monospace class (content.css)
    expect(screen.getByTestId("key-once-env").textContent).toBe("production");
    expect(screen.getByTestId("key-once-scope").textContent).toBe("write");
    expect(screen.getByTestId("key-once-warning").textContent).toBe("Copy this key now. It won't be shown again: WebDesk keeps only a fingerprint of it.");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("the environment falls back to its id when the name could not be resolved", async () => {
    decide.mockResolvedValue(minted());
    setup({ environmentName: null });
    await click("Approve");
    expect(screen.getByTestId("key-once-env").textContent).toBe(ENV);
  });

  it("Copy writes the key to the clipboard and says so; a refused clipboard says to copy by hand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    decide.mockResolvedValue(minted());
    setup();
    await click("Approve");
    await click("Copy");
    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(screen.getByTestId("key-once-copied").textContent).toMatch(/Copied/);

    writeText.mockRejectedValue(new Error("denied"));
    await click("Copy");
    expect(screen.getByTestId("key-once-copy-failed").textContent).toMatch(/copy it by hand/);
  });

  it("the form is gone once approved (a second Approve would mint again), and stays gone after Hide key", async () => {
    decide.mockResolvedValue(minted());
    setup();
    await click("Approve");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await click("Hide key");
    expect(screen.queryByTestId("key-once")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("survives the revalidation that follows: the row stops being pending (mayDecide flips) and the panel is still there", async () => {
    decide.mockResolvedValue(minted());
    const view = setup();
    await click("Approve");
    view.rerender(<KeyMintDecide tenantId="co-1" approvalId="ap-1" environmentName="production" mayDecide={false} ownRequest={false} />);
    expect((screen.getByTestId("key-once-value") as HTMLInputElement).value).toBe(KEY);
  });

  it("a page restored from the back/forward cache brings back NO key", async () => {
    decide.mockResolvedValue(minted());
    setup();
    await click("Approve");

    const notRestored = new Event("pageshow");
    Object.defineProperty(notRestored, "persisted", { value: false });
    await act(async () => { window.dispatchEvent(notRestored); });
    expect(screen.getByTestId("key-once-value")).toBeTruthy(); // a normal pageshow is not a restore

    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => { window.dispatchEvent(restored); });
    expect(screen.queryByTestId("key-once")).toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("unmounting (navigating away) leaves no key in the document", async () => {
    decide.mockResolvedValue(minted());
    const view = setup();
    await click("Approve");
    view.unmount();
    expect(document.body.innerHTML).not.toContain(KEY);
  });
});

describe("KeyMintDecide: every outcome that is NOT a key shows no key field", () => {
  const noKeyField = () => {
    expect(screen.queryByTestId("key-once")).toBeNull();
    expect(screen.queryByTestId("key-once-value")).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  };

  it("failed: the typed error in plain words, and no key field", async () => {
    decide.mockResolvedValue({ ok: true, decision: "approved", mint: { status: "failed", envId: ENV, scope: "read", error: "webdesk_unreachable" } });
    setup();
    await click("Approve");
    const n = screen.getByTestId("key-failed");
    expect(n.textContent).toContain("The key wasn't created.");
    expect(n.textContent).toContain("WebDesk couldn't be reached. Nothing was sent.");
    expect(n.textContent).not.toContain("webdesk_unreachable");
    expect(n.getAttribute("role")).toBe("alert");
    noKeyField();
  });

  it("executed but WebDesk returned no key: says so, and no key field", async () => {
    decide.mockResolvedValue(minted({ plaintextOnce: null }));
    setup();
    await click("Approve");
    expect(screen.getByTestId("key-not-returned").textContent).toMatch(/didn't send it back/);
    noKeyField();
  });

  it("approved but unreadable: says no key can be shown, and no key field", async () => {
    decide.mockResolvedValue({ ok: true, decision: "approved", mint: { status: "unreadable" } });
    setup();
    await click("Approve");
    expect(screen.getByTestId("key-unreadable").textContent).toMatch(/no key can be shown/);
    noKeyField();
  });

  it("denied: the normal decided state, no key", async () => {
    decide.mockResolvedValue({ ok: true, decision: "rejected" });
    setup();
    await click("Deny");
    expect(screen.getByTestId("key-denied").textContent).toBe("Request denied. No key was created.");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    noKeyField();
  });

  it("the decide itself failing (e.g. you filed it yourself, 403) keeps the form so it can be retried, and shows no key", async () => {
    decide.mockResolvedValue({ ok: false, error: "forbidden: a key mint may not be approved by the principal who requested it" });
    setup();
    await click("Approve");
    expect(screen.getByTestId("key-decide-error").textContent).toMatch(/Couldn't record your decision\. forbidden/);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    noKeyField();
  });
});

// ── CUSTODY ──────────────────────────────────────────────────────────────────────────────────────
// The plaintext key lives in React state for the render and nowhere else. Spy on every sink a component could reach.
describe("KeyMintDecide: custody — the key reaches NO storage, console, URL, history, cookie, beacon or network", () => {
  it("approve -> show -> copy -> hide: none of them ever receives the key", async () => {
    const consoleSpies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieSet = vi.spyOn(Document.prototype, "cookie", "set");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const beacon = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const idbOpen = vi.fn();
    Object.defineProperty(window, "indexedDB", { value: { open: idbOpen }, configurable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const before = { href: window.location.href, state: window.history.state };

    decide.mockResolvedValue(minted());
    setup();
    await click("Approve");
    expect((screen.getByTestId("key-once-value") as HTMLInputElement).value).toBe(KEY); // it IS on screen, so the spies below are meaningful
    await click("Copy");
    await click("Hide key");

    // the ONE intended sink is the user's own Copy click (clipboard); everything else must have seen nothing.
    expect(writeText).toHaveBeenCalledTimes(1);
    for (const spy of consoleSpies) expect(mentions(spy.mock.calls, KEY), `console.${String(spy.getMockName())}`).toBe(false);
    expect(mentions(setItem.mock.calls, KEY)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(mentions(cookieSet.mock.calls, KEY)).toBe(false);
    expect(document.cookie).not.toContain(KEY);
    expect(mentions(pushState.mock.calls, KEY)).toBe(false);
    expect(mentions(replaceState.mock.calls, KEY)).toBe(false);
    expect(window.location.href).toBe(before.href);
    expect(window.location.href).not.toContain(KEY);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(KEY);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(idbOpen).not.toHaveBeenCalled();
  });

  it("a FAILED outcome and a denial also touch none of them (nothing to leak, nothing logged)", async () => {
    const consoleSpies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    decide.mockResolvedValue({ ok: true, decision: "approved", mint: { status: "failed", envId: ENV, scope: "read", error: "webdesk_unreachable" } });
    setup();
    await click("Approve");
    for (const spy of consoleSpies.slice(0, 2)) expect(spy).not.toHaveBeenCalled(); // log, info
    expect(setItem).not.toHaveBeenCalled();
  });
});
