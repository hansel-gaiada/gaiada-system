// B0 — logout must actually remove a `__Host-` session cookie. The browser ignores a clear that lacks
// `Secure` + `Path=/`, so the old `jar.set(name, "", { maxAge: 0, path: "/" })` would have left
// every production user signed in after pressing "Sign out" — with nothing on screen to say so.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const set = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ set, get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prefs", () => ({ getPrefs: vi.fn(), writePrefs: vi.fn() }));
const getSession = vi.fn();
vi.mock("@/lib/session-server", () => ({ getSession: () => getSession() }));
const endIdpSession = vi.fn();
vi.mock("@/lib/idpLogout", () => ({ endIdpSession: (t: string) => endIdpSession(t) }));

import { logout } from "./actions";

const oidc = { mode: "oidc", userId: "u1", accessToken: "a", refreshToken: "r-123", expiresAt: 0 };

describe("logout", () => {
  beforeEach(() => {
    set.mockClear();
    getSession.mockReset().mockResolvedValue(null);
    endIdpSession.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  // B0 sweep: clearing only the ERP cookie left Keycloak's SSO session alive, so /auth/login signed straight back in.
  it("ends the Keycloak session with the session's refresh token, and clears the cookie", async () => {
    getSession.mockResolvedValue(oidc);
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(endIdpSession).toHaveBeenCalledWith("r-123");
    expect(set).toHaveBeenCalledWith(expect.stringContaining("gaiada_session"), "", expect.objectContaining({ maxAge: 0 }));
  });

  it("still clears the cookie and redirects when Keycloak refuses (fail-soft)", async () => {
    getSession.mockResolvedValue(oidc);
    endIdpSession.mockResolvedValue(false);
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(set).toHaveBeenCalledWith(expect.stringContaining("gaiada_session"), "", expect.objectContaining({ maxAge: 0 }));
  });

  it("does not call Keycloak without an OIDC session (dev mode, or no session)", async () => {
    getSession.mockResolvedValue({ mode: "dev", userId: "u1" });
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    getSession.mockResolvedValue(null);
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(endIdpSession).not.toHaveBeenCalled();
  });

  it("clears __Host-gaiada_session with Secure, Path=/ and maxAge 0 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(set).toHaveBeenCalledWith("__Host-gaiada_session", "", expect.objectContaining({ maxAge: 0, path: "/", secure: true }));
  });

  it("clears the bare name under next dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(logout()).rejects.toThrow("REDIRECT:/login");
    expect(set).toHaveBeenCalledWith("gaiada_session", "", expect.objectContaining({ maxAge: 0, path: "/" }));
  });
});
