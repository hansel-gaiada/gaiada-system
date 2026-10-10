import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/lib/webdeskContentActions", () => ({ restoreVersionAndOpenAction: vi.fn() }));

import * as A from "@/lib/webdeskContentActions";
import { RestoreButton } from "./RestoreButton";

const a = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };

async function restoreWith(r: WdResult<never>) {
  a.restoreVersionAndOpenAction.mockResolvedValue(r as never);
  render(<RestoreButton scope={SCOPE} itemId="i1" version={2} baseVersion={3} editorHref="/x" />);
  fireEvent.click(screen.getByTestId("restore-2"));
  await act(async () => { fireEvent.click(screen.getByTestId("confirm-restore-2")); });
}

beforeEach(() => { a.restoreVersionAndOpenAction.mockReset(); push.mockReset(); });

describe("RestoreButton: success navigates from the server", () => {
  it("the action redirects (its promise rejects with Next's redirect error): no client push, no error shown", async () => {
    a.restoreVersionAndOpenAction.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/x;307;" }));
    render(<RestoreButton scope={SCOPE} itemId="i1" version={2} baseVersion={3} editorHref="/x" />);
    fireEvent.click(screen.getByTestId("restore-2"));
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-restore-2")); });
    expect(a.restoreVersionAndOpenAction).toHaveBeenCalledWith(SCOPE, "i1", 2, 3, "/x", "Restored from v2");
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("RestoreButton: what it claims after a failed restore", () => {
  it("502 webdesk_ambiguous: 'couldn't confirm', never 'Nothing was restored'", async () => {
    await restoreWith({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    expect(screen.getByRole("alert").textContent).toBe("We couldn't confirm the restore. Reload to see what happened.");
    expect(push).not.toHaveBeenCalled();
  });
  it("an ordinary outage still says nothing was restored", async () => {
    await restoreWith({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    expect(screen.getByRole("alert").textContent).toBe("WebDesk can't be reached right now. Nothing was restored.");
  });
});
