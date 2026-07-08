import { describe, it, expect, beforeEach } from "vitest";
import { actionsEnabled, setActionsEnabled, killSwitchMessage } from "./kill-switch";

describe("kill-switch", () => {
  beforeEach(() => setActionsEnabled(true));

  it("defaults to enabled", () => {
    expect(actionsEnabled()).toBe(true);
  });

  it("runtime toggle disables all actions", () => {
    setActionsEnabled(false);
    expect(actionsEnabled()).toBe(false);
  });

  it("re-enabling restores actions", () => {
    setActionsEnabled(false);
    setActionsEnabled(true);
    expect(actionsEnabled()).toBe(true);
  });

  it("provides a user-facing message when off", () => {
    expect(killSwitchMessage()).toMatch(/temporarily disabled/i);
  });
});
