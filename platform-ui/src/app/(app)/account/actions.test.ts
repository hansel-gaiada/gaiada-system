// B0 — logout must actually remove a `__Host-` session cookie. The browser ignores a clear that lacks
// `Secure` + `Path=/`, so the old `jar.set(name, "", { maxAge: 0, path: "/" })` would have left
// every production user signed in after pressing "Sign out" — with nothing on screen to say so.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const set = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ set, get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prefs", () => ({ getPrefs: vi.fn(), writePrefs: vi.fn() }));

import { logout } from "./actions";

describe("logout", () => {
  beforeEach(() => set.mockClear());
  afterEach(() => vi.unstubAllEnvs());

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
