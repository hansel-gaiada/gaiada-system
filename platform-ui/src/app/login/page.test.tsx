// DW-7h (FRONTEND-BFF-CONTRACT §52.4): the sign-in page says why the person is here after IT ended their session.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./actions", () => ({ login: vi.fn() })); // the dev-login server action; not exercised here
vi.mock("./login.css", () => ({}));

import LoginPage from "./page";

afterEach(() => vi.unstubAllEnvs());

const renderPage = async (sp: Record<string, string>) => render(await LoginPage({ searchParams: Promise.resolve(sp) }));

describe("/login", () => {
  it("shows the session-ended message for ?reason=session_revoked, in the SSO-only mode live runs", async () => {
    vi.stubEnv("AUTH_MODE", "oidc");
    await renderPage({ reason: "session_revoked" });
    expect(screen.getByRole("alert")).toHaveTextContent("Your session was ended by IT. Sign in again.");
  });

  it("shows it on the dev form too", async () => {
    vi.stubEnv("AUTH_MODE", "dev");
    await renderPage({ reason: "session_revoked" });
    expect(screen.getByRole("alert")).toHaveTextContent("Your session was ended by IT. Sign in again.");
  });

  it("shows nothing without a reason, and ignores a reason it does not know", async () => {
    vi.stubEnv("AUTH_MODE", "oidc");
    await renderPage({});
    expect(screen.queryByRole("alert")).toBeNull();
    await renderPage({ reason: "something-else" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
