// B0 — the `__Host-` prefix on the session, auth and tenant-context cookies (lib/cookieNames.ts).
// The two ways this goes wrong are both silent: a call site that still writes the bare name (the
// prefix protects nothing, every test stays green), and a clear without `Secure` + `Path=/` (the
// browser ignores it, so logout "works" and leaves the session in place).
import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  HOST_COOKIES,
  cookieName,
  hostCookieOptions,
  clearedHostCookieOptions,
  setHostCookie,
  readHostCookie,
  clearHostCookie,
} from "./cookieNames";

afterEach(() => {
  vi.unstubAllEnvs();
});

function jar(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const set = vi.fn((name: string, value: string) => {
    store.set(name, value);
  });
  return { set, get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined), store };
}

describe("cookie names", () => {
  it("are prefixed __Host- in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const base of Object.values(HOST_COOKIES)) expect(cookieName(base)).toBe(`__Host-${base}`);
  });

  it("stay bare outside production (next dev on http://localhost, e2e addCookies)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(cookieName(HOST_COOKIES.session)).toBe("gaiada_session");
    expect(cookieName(HOST_COOKIES.tenant)).toBe("gaiada_tenant");
  });

  it("cover exactly the eight session/auth/tenant-context and OAuth-flow cookies", () => {
    expect(Object.values(HOST_COOKIES).sort()).toEqual(
      [
        "gaiada_pm_scope",
        "gaiada_portal_client",
        "gaiada_portal_tenant",
        "gaiada_session",
        "gaiada_tenant",
        "oidc_pkce",
        "sm_drive_oauth_pending",
        "sm_google_oauth_pending",
      ].sort(),
    );
  });
});

describe("cookie attributes", () => {
  it("in production: Secure, Path=/, SameSite=Lax, httpOnly, and never a Domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    const o = hostCookieOptions({ maxAge: 600 });
    expect(o).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure: true, maxAge: 600 });
    expect(o).not.toHaveProperty("domain");
  });

  it("extra options cannot weaken path/secure or add a domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    const o = hostCookieOptions({ path: "/x", secure: false, domain: ".gaiada.com" } as never);
    expect(o.path).toBe("/");
    expect(o.secure).toBe(true);
    expect(o).not.toHaveProperty("domain");
  });

  it("the clear carries Secure + Path=/ + maxAge 0 — a bare maxAge:0 would not remove a __Host- cookie", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(clearedHostCookieOptions()).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure: true, maxAge: 0 });
  });

  it("outside production Secure is off (a browser drops Secure cookies over plain http)", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(hostCookieOptions().secure).toBe(false);
  });
});

describe("set / read / clear helpers", () => {
  it("write, read and clear the SAME prefixed name in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const j = jar();
    setHostCookie(j, HOST_COOKIES.session, "sealed", { maxAge: 10 });
    expect(j.set).toHaveBeenLastCalledWith("__Host-gaiada_session", "sealed", expect.objectContaining({ secure: true, path: "/", maxAge: 10 }));
    expect(readHostCookie(j, HOST_COOKIES.session)).toBe("sealed");
    clearHostCookie(j, HOST_COOKIES.session);
    expect(j.set).toHaveBeenLastCalledWith("__Host-gaiada_session", "", expect.objectContaining({ secure: true, path: "/", maxAge: 0 }));
  });

  it("does NOT fall back to the unprefixed name in production — that is the tossed cookie", () => {
    vi.stubEnv("NODE_ENV", "production");
    const j = jar({ gaiada_session: "planted-by-a-sibling", gaiada_tenant: "co-attacker" });
    expect(readHostCookie(j, HOST_COOKIES.session)).toBeUndefined();
    expect(readHostCookie(j, HOST_COOKIES.tenant)).toBeUndefined();
  });

  it("reads the bare name under next dev, so e2e's addCookies({ name: 'gaiada_tenant' }) keeps working", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(readHostCookie(jar({ gaiada_tenant: "co-agency" }), HOST_COOKIES.tenant)).toBe("co-agency");
  });
});

// Guard: no source file may spell one of these names as a string literal. A literal bypasses the
// prefix (and the clear attributes) without failing anything else.
describe("no call site names these cookies directly", () => {
  const SRC = path.resolve(__dirname, "..");
  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) yield* files(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield p;
    }
  }

  it("only lib/cookieNames.ts holds the quoted names", () => {
    const names = Object.values(HOST_COOKIES).join("|");
    const literal = new RegExp(`["'\`](${names})["'\`]`);
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      if (f.endsWith(path.join("lib", "cookieNames.ts"))) continue;
      const lines = readFileSync(f, "utf8").split(/\r?\n/); // CRLF on a Windows checkout
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").trim();
        if (code.startsWith("*") || code.startsWith("/*")) return; // JSDoc / block comment line
        if (literal.test(code)) offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
