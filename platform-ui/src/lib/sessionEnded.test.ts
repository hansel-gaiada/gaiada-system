// DW-7h (FRONTEND-BFF-CONTRACT §52.4): the session-ended refusal is a redirect Next recognises, and the layouts'
// `.catch` lets exactly that one through.
import { describe, it, expect } from "vitest";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { PlatformError } from "./platform";
import { isSessionEnded, rethrowIfSessionEnded, withSessionEndedRedirect, SESSION_ENDED_PATH, SESSION_REVOKED_MESSAGE } from "./sessionEnded";

const ended = () => withSessionEndedRedirect(new PlatformError(401, SESSION_REVOKED_MESSAGE, undefined, undefined, "session_revoked"));

describe("sessionEnded", () => {
  it("gives the error Next's own redirect digest for /auth/ended, and keeps it a PlatformError", () => {
    const e = ended();
    expect(e).toBeInstanceOf(PlatformError);
    expect(isRedirectError(e)).toBe(true);
    expect((e as unknown as { digest: string }).digest.split(";")).toContain(SESSION_ENDED_PATH);
  });

  it("rethrows the session-ended refusal and nothing else", () => {
    expect(() => rethrowIfSessionEnded(ended())).toThrow(SESSION_REVOKED_MESSAGE);
    expect(() => rethrowIfSessionEnded(new PlatformError(401, "session revoked — re-authenticate"))).not.toThrow();
    expect(() => rethrowIfSessionEnded(new PlatformError(401, "x", undefined, undefined, "session_revoked"))).not.toThrow();
    expect(() => rethrowIfSessionEnded(new Error("network"))).not.toThrow();
    expect(isSessionEnded(null)).toBe(false);
  });
});
