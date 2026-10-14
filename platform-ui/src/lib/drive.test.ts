import { describe, it, expect } from "vitest";
import {
  DRIVE_CALLBACK_UI_PATH, attachPath, callbackPath, canAttachFromDrive, disconnectPath, driveErrorText, driveErrorToken,
  driveOutcomeText, isDriveUrl, normalizeCredentials, normalizeStatus, parseDrivePending, pickerPath, startPath, statusPath,
} from "./drive";

// DW-6i UI: the pure half of Google Drive (BFF §42). The error tokens are put in words, the Picker answer is reduced to a status
// that never carries the token, and the route paths are what the backend serves.

const picker = (over: Record<string, unknown> = {}) => ({
  configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", accessToken: "ya29.secret", expiresAt: "2026-10-14T10:00:00Z",
  apiKey: "key", appId: "123", ...over,
});

describe("driveErrorText: every backend token is a plain sentence", () => {
  const tokens = [
    "drive_not_configured", "drive_not_connected", "drive_needs_reconnect", "drive_state_invalid", "drive_exchange_failed",
    "drive_consent_denied", "drive_file_not_found", "drive_unavailable", "drive_already_attached", "target_not_found",
    "unsupported_target_type", "bad_drive_file_id", "user_required",
  ];

  it("has a distinct sentence for each token, read from the START of `error`", () => {
    const seen = new Set<string>();
    for (const t of tokens) {
      const text = driveErrorText({ status: 409, error: `${t}: some backend detail` });
      expect(text, t).not.toContain(t);
      expect(text, t).not.toContain("backend detail");
      expect(text.endsWith("."), t).toBe(true);
      seen.add(text);
    }
    expect(seen.size).toBe(tokens.length);
  });

  it("says the specific things people need to hear", () => {
    expect(driveErrorText({ error: "drive_not_configured: x" })).toBe("Google Drive isn't set up for this ERP yet.");
    expect(driveErrorText({ error: "drive_already_attached: x" })).toBe("That file is already attached to this task.");
    expect(driveErrorText({ error: "drive_needs_reconnect: x" })).toMatch(/Reconnect Google Drive/);
    expect(driveErrorText({ error: "drive_file_not_found: x" })).toMatch(/couldn't be found in your Google Drive/);
  });

  it("prefers `reason` when it is a known token", () => {
    expect(driveErrorToken("something else", "drive_unavailable")).toBe("drive_unavailable");
    expect(driveErrorToken("drive_not_connected: x", "not_a_token")).toBe("drive_not_connected");
  });

  it("does not match a token that merely appears later in the message", () => {
    expect(driveErrorToken("failed: drive_unavailable", null)).toBeNull();
  });

  it("a 403 is a calm permission sentence and a 401 asks to sign in again, whatever the message", () => {
    expect(driveErrorText({ status: 403, error: "drive_file_not_found" })).toMatch(/don't have permission/);
    expect(driveErrorText({ status: 401, error: "x" })).toBe("Your session expired. Sign in again.");
  });

  it("an unknown token still gets a sentence, not the raw words", () => {
    expect(driveErrorText({ status: 500, error: "kaboom" })).toMatch(/didn't work/);
    expect(driveErrorText({ status: 404, error: "kaboom" })).toBe("That wasn't found. Reload the page.");
  });
});

describe("driveOutcomeText", () => {
  it("says each coarse flag in one line and invents nothing for an unknown one", () => {
    expect(driveOutcomeText("connected")).toBe("Google Drive is connected.");
    expect(driveOutcomeText("denied")).toMatch(/declined/);
    expect(driveOutcomeText("error")).toMatch(/couldn't be connected/);
    expect(driveOutcomeText("weird")).toBeNull();
    expect(driveOutcomeText(undefined)).toBeNull();
  });

  it("uses the reason only when it is a known token", () => {
    expect(driveOutcomeText("error", "drive_state_invalid")).toMatch(/couldn't be verified/);
    expect(driveOutcomeText("error", "<script>")).toMatch(/couldn't be connected/);
  });
});

describe("normalizeStatus and normalizeCredentials", () => {
  it("reduces the Picker answer to a status that has no token in it", () => {
    const s = normalizeStatus(picker());
    expect(s).toEqual({ configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test" });
    expect(JSON.stringify(s)).not.toContain("ya29");
    expect(JSON.stringify(s)).not.toContain("apiKey");
  });

  it("not configured is not connected, whatever else it says", () => {
    expect(normalizeStatus(picker({ configured: false, connected: true, needsReconnect: true }))).toEqual({
      configured: false, connected: false, needsReconnect: false, accountEmail: "a@b.test",
    });
  });

  it("carries needsReconnect", () => {
    expect(normalizeStatus(picker({ connected: false, needsReconnect: true }))).toMatchObject({ connected: false, needsReconnect: true });
  });

  it("refuses an answer that is not the documented shape", () => {
    expect(normalizeStatus(null)).toBeNull();
    expect(normalizeStatus([])).toBeNull();
    expect(normalizeStatus({ configured: "yes", connected: true })).toBeNull();
    expect(normalizeStatus({ configured: true })).toBeNull();
  });

  it("credentials need a connected answer with all three values", () => {
    expect(normalizeCredentials(picker())).toEqual({ accessToken: "ya29.secret", apiKey: "key", appId: "123" });
    expect(normalizeCredentials(picker({ connected: false }))).toBeNull();
    expect(normalizeCredentials(picker({ configured: false }))).toBeNull();
    expect(normalizeCredentials(picker({ accessToken: null }))).toBeNull();
    expect(normalizeCredentials(picker({ appId: "" }))).toBeNull();
  });

  it("the attach button gate is connected AND configured", () => {
    expect(canAttachFromDrive({ configured: true, connected: true, needsReconnect: false, accountEmail: null })).toBe(true);
    expect(canAttachFromDrive({ configured: true, connected: false, needsReconnect: true, accountEmail: null })).toBe(false);
    expect(canAttachFromDrive({ configured: false, connected: false, needsReconnect: false, accountEmail: null })).toBe(false);
    expect(canAttachFromDrive(null)).toBe(false);
  });
});

describe("the route paths", () => {
  it("builds the six backend routes for the active company", () => {
    expect(statusPath("co-1")).toBe("/api/co-1/integrations/google-drive");
    expect(pickerPath("co-1")).toBe("/api/co-1/integrations/google-drive/picker");
    expect(startPath("co-1")).toBe("/api/co-1/integrations/google-drive/oauth/start");
    expect(disconnectPath("co-1")).toBe("/api/co-1/integrations/google-drive");
    expect(attachPath("co-1")).toBe("/api/co-1/integrations/google-drive/attach");
    expect(callbackPath("c/1", "s 2")).toBe("/api/google-drive/oauth/callback?code=c%2F1&state=s%202");
  });

  it("encodes the company id", () => {
    expect(pickerPath("a/b")).toBe("/api/a%2Fb/integrations/google-drive/picker");
  });

  it("the redirect URI path the owner registers", () => {
    expect(DRIVE_CALLBACK_UI_PATH).toBe("/api/google-drive/callback");
  });
});

describe("isDriveUrl", () => {
  it("is true for https Drive and Docs links", () => {
    expect(isDriveUrl("https://drive.google.com/file/d/abc/view")).toBe(true);
    expect(isDriveUrl("https://docs.google.com/document/d/abc/edit")).toBe(true);
    expect(isDriveUrl("https://DOCS.google.com/spreadsheets/d/abc")).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isDriveUrl("http://drive.google.com/file/d/abc")).toBe(false);
    expect(isDriveUrl("https://drive.google.com.evil.test/x")).toBe(false);
    expect(isDriveUrl("https://evil.test/drive.google.com")).toBe(false);
    expect(isDriveUrl("https://www.figma.com/design/k")).toBe(false);
    expect(isDriveUrl("not a url")).toBe(false);
    expect(isDriveUrl(null)).toBe(false);
    expect(isDriveUrl(undefined)).toBe(false);
  });
});

describe("parseDrivePending", () => {
  it("returns the stored path", () => {
    expect(parseDrivePending(JSON.stringify({ returnPath: "/departments/d1/connections" }))).toEqual({ returnPath: "/departments/d1/connections" });
  });

  it("never lets an outside target through: it degrades to the root", () => {
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)", "evil"]) {
      expect(parseDrivePending(JSON.stringify({ returnPath: bad })), bad).toEqual({ returnPath: "/" });
    }
  });

  it("is null for a missing or malformed value", () => {
    expect(parseDrivePending(undefined)).toBeNull();
    expect(parseDrivePending("")).toBeNull();
    expect(parseDrivePending("{not json")).toBeNull();
    expect(parseDrivePending(JSON.stringify({ returnPath: 5 }))).toBeNull();
  });
});
