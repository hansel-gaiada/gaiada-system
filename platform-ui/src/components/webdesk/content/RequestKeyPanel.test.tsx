import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EnvironmentRef, WdResult, KeyRequestFiled } from "@/lib/webdeskContentModel";

vi.mock("@/lib/webdeskContentActions", () => ({ requestKeyAction: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import * as A from "@/lib/webdeskContentActions";
import { RequestKeyPanel } from "./RequestKeyPanel";

const requestKey = vi.mocked(A.requestKeyAction);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const PROD = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const STG = "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e";
const ENVS: EnvironmentRef[] = [
  { envId: STG, name: "staging", domain: "24-pyevq.gaiada.com", status: "active" },
  { envId: PROD, name: "production", domain: "gaiada.com", status: "active" },
];
const ok = (d: KeyRequestFiled): WdResult<KeyRequestFiled> => ({ kind: "ok", data: d });

const setup = (over: Partial<React.ComponentProps<typeof RequestKeyPanel>> = {}) =>
  render(<RequestKeyPanel allowed scope={SCOPE} environments={ENVS} {...over} />);
const submit = async () => { await act(async () => { fireEvent.click(screen.getByTestId("request-key-submit")); }); };

beforeEach(() => { requestKey.mockReset(); });

describe("RequestKeyPanel: who sees it", () => {
  it("renders NOTHING for a user who cannot promote: no section, no disabled button, no hint", () => {
    const { container } = setup({ allowed: false });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("request-key")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the control for a user who can", () => {
    setup();
    expect(screen.getByRole("heading", { name: "API keys" })).toBeTruthy();
    expect(screen.getByTestId("request-key-submit").textContent).toBe("Request an API key");
  });
});

describe("RequestKeyPanel: the form", () => {
  it("lists the site's environments BY NAME, with no default when there are several; Submit waits for a choice", () => {
    setup();
    const env = screen.getByLabelText("Environment") as HTMLSelectElement;
    expect([...env.options].map((o) => o.textContent)).toEqual(["Choose an environment", "staging", "production"]);
    expect(env.value).toBe("");
    expect((screen.getByTestId("request-key-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a site with exactly one environment has it preselected", () => {
    setup({ environments: [ENVS[1]] });
    expect((screen.getByLabelText("Environment") as HTMLSelectElement).value).toBe(PROD);
    expect((screen.getByTestId("request-key-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a site with no environments says so and offers no form", () => {
    setup({ environments: [] });
    expect(screen.getByTestId("request-key-no-env").textContent).toMatch(/no environments yet/);
    expect(screen.queryByTestId("request-key-submit")).toBeNull();
  });

  it("scope defaults to read, offers write, and says in one plain sentence what write means", () => {
    setup();
    const scope = screen.getByLabelText("Scope") as HTMLSelectElement;
    expect(scope.value).toBe("read");
    expect([...scope.options].map((o) => o.value)).toEqual(["read", "write"]);
    expect(screen.getByTestId("request-key-hint").textContent).toBe("Write keys can change content through the API. Most sites only need read.");
  });
});

describe("RequestKeyPanel: filing", () => {
  it("files the chosen environment with scope READ by default", async () => {
    requestKey.mockResolvedValue(ok({ approvalId: "ap-1", alreadyPending: false }));
    setup();
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: PROD } });
    await submit();
    expect(requestKey).toHaveBeenCalledWith(SCOPE, PROD, "read");
  });

  it("files a write key when asked", async () => {
    requestKey.mockResolvedValue(ok({ approvalId: "ap-1", alreadyPending: false }));
    setup();
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: STG } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "write" } });
    await submit();
    expect(requestKey).toHaveBeenCalledWith(SCOPE, STG, "write");
  });

  it("new request: 'Request filed…' and a link to the request", async () => {
    requestKey.mockResolvedValue(ok({ approvalId: "ap-0001", alreadyPending: false }));
    setup({ environments: [ENVS[1]] });
    await submit();
    const msg = screen.getByTestId("request-key-message");
    expect(msg.textContent).toContain("Request filed. Someone else must approve it before the key is created.");
    expect(msg.textContent).not.toMatch(/key (was|has been) created/i); // it never claims a key exists
    expect(screen.getByRole("link", { name: "View the request" }).getAttribute("href")).toBe("/approvals/ap-0001");
    expect(msg.getAttribute("role")).toBe("status");
  });

  it("already pending: its own sentence, with the same link", async () => {
    requestKey.mockResolvedValue(ok({ approvalId: "ap-0007", alreadyPending: true }));
    setup({ environments: [ENVS[1]] });
    await submit();
    expect(screen.getByTestId("request-key-message").textContent).toContain("Already requested: a request for this environment and scope is waiting for approval.");
    expect(screen.getByTestId("request-key-message").textContent).not.toContain("Request filed");
    expect(screen.getByRole("link", { name: "View the request" }).getAttribute("href")).toBe("/approvals/ap-0007");
  });

  it.each<[string, WdResult<KeyRequestFiled>, string]>([
    ["environment-not-found", { kind: "not_found", slug: "environment-not-found" }, "That environment isn't part of this site."],
    ["forbidden", { kind: "forbidden", reason: "x" }, "You can't request API keys for this site."],
    ["unavailable (503)", { kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" }, "Editing is unavailable. WebDesk can't be reached. Nothing has been lost."],
  ])("%s is a plain sentence in an alert, with NO link and no raw slug", async (_n, result, text) => {
    requestKey.mockResolvedValue(result);
    setup({ environments: [ENVS[1]] });
    await submit();
    const msg = screen.getByTestId("request-key-message");
    expect(msg.textContent).toBe(text);
    expect(msg.getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a second click while the request is in flight does not file twice", async () => {
    let release: (r: WdResult<KeyRequestFiled>) => void = () => {};
    requestKey.mockReturnValue(new Promise((res) => { release = res; }));
    setup({ environments: [ENVS[1]] });
    const form = screen.getByRole("form", { name: "Request an API key" });
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(requestKey).toHaveBeenCalledTimes(1);
    await act(async () => { release(ok({ approvalId: "a", alreadyPending: false })); });
  });

  it("changing the choice clears the previous outcome", async () => {
    requestKey.mockResolvedValue(ok({ approvalId: "ap-1", alreadyPending: false }));
    setup();
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: PROD } });
    await submit();
    expect(screen.getByTestId("request-key-message")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "write" } });
    expect(screen.queryByTestId("request-key-message")).toBeNull();
  });
});
