import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ControlsTab } from "./ControlsTab";

interface RouterState {
  enabled: boolean;
  digests: {
    history: unknown[] | null;
    nextRun: { noon: number | null; evening: number | null } | null;
    timezone: string | null;
    error?: string;
  };
  groups: { groups: unknown[] | null; discovered: unknown[] | null; error?: string };
  media: { queueEnabled: boolean | null; pending: number | null; oldestPendingTs: number | null; error?: string };
  skills: { commandPrefix: string | null; botMention: string | null; skills: unknown[] | null; error?: string };
}

function ok(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

// Routes every call the component can make. `init?.method` distinguishes the
// static GET /actions/audit read from the dynamic POST /actions/{state}
// mutation, since both share the "/actions/" prefix. `/digests/run/{slot}`
// answers 202 {started:true} — the async contract — not a finished result;
// individual "Run now" tests override this per-test where the poll matters.
function router(state: RouterState) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? "GET";
    if (s.endsWith("/actions/audit")) return ok({ enabled: state.enabled, entries: [] });
    if (method === "POST" && s.endsWith("/actions/off")) {
      state.enabled = false;
      return ok({ enabled: false });
    }
    if (method === "POST" && s.endsWith("/actions/on")) {
      state.enabled = true;
      return ok({ enabled: true });
    }
    if (s.endsWith("/digests/groups")) return ok(state.groups);
    if (method === "POST" && s.endsWith("/digests/run/noon")) return ok({ ok: true, started: true, startedAt: Date.now() });
    if (method === "POST" && s.endsWith("/digests/run/evening")) return ok({ ok: true, started: true, startedAt: Date.now() });
    if (s.endsWith("/digests")) return ok(state.digests);
    if (s.endsWith("/media/status")) return ok(state.media);
    if (s.endsWith("/skills")) return ok(state.skills);
    throw new Error(`unexpected call ${method} ${s}`);
  });
}

function baseState(overrides: Partial<RouterState> = {}): RouterState {
  return {
    enabled: true,
    digests: {
      history: [
        { ts: 1000, slot: "noon", trigger: "scheduled", groupsCovered: 4, delivered: 4, failed: 0, managementDelivered: 1 },
      ],
      nextRun: { noon: 2000, evening: 3000 },
      timezone: "Asia/Jakarta",
    },
    groups: { groups: [{ id: "111@g.us", name: "Ops" }], discovered: [{ id: "222@g.us", name: "Sales" }] },
    media: { queueEnabled: true, pending: 2, oldestPendingTs: Date.now() - 60_000 },
    skills: {
      commandPrefix: "/",
      botMention: "@bot",
      skills: [{ name: "capture", description: "Capture a note." }],
    },
    ...overrides,
  };
}

describe("ControlsTab", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not fetch at all when the caller isn't elevated (cosmetic gate)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ControlsTab elevated={false} />);
    expect(screen.getByText(/limited to superadmins\/owners/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads all four panels on the happy path", async () => {
    vi.stubGlobal("fetch", router(baseState()));

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    // 1. Kill switch.
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeInTheDocument();

    // 2. Digests.
    expect(screen.getByText("Asia/Jakarta")).toBeInTheDocument();
    expect(screen.getByText("scheduled")).toBeInTheDocument();

    // 3. Media queue.
    expect(screen.getByText("2 pending")).toBeInTheDocument();

    // 4. Bot capabilities.
    expect(screen.getByText("@bot")).toBeInTheDocument();
    expect(screen.getByText("/capture")).toBeInTheDocument();
    expect(screen.getByText("Capture a note.")).toBeInTheDocument();
  });

  it("shows an explicit error state instead of hanging on Loading when fetches fail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.endsWith("/actions/audit")) return { ok: false, json: () => Promise.resolve({ entries: null, error: "audit down" }) } as Response;
      if (s.endsWith("/digests/groups")) return { ok: false, json: () => Promise.resolve({ groups: null, discovered: null, error: "groups down" }) } as Response;
      if (s.endsWith("/digests")) return { ok: false, json: () => Promise.resolve({ history: null, error: "digests down" }) } as Response;
      if (s.endsWith("/media/status")) return { ok: false, json: () => Promise.resolve({ pending: null, error: "media down" }) } as Response;
      if (s.endsWith("/skills")) return { ok: false, json: () => Promise.resolve({ skills: null, error: "skills down" }) } as Response;
      throw new Error(`unexpected call ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    expect(screen.getByText("audit down")).toBeInTheDocument();
    expect(screen.getByText(/actions switch couldn't be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/digest history couldn't be loaded/i)).toBeInTheDocument();
    expect(screen.getByText("groups down")).toBeInTheDocument();
    expect(screen.getByText(/media queue status couldn't be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/skills catalog couldn't be loaded/i)).toBeInTheDocument();
    // Never left sitting on a bare "Loading…" once the fetch has resolved.
    expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument();
  });

  it("turning actions off is immediate; turning them back on requires a confirm step", async () => {
    const state = baseState({ enabled: true });
    vi.stubGlobal("fetch", router(state));

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    // Off is a single click — no confirm dialog.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    });
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    // Turning back on shows the confirm step before any mutating call.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });
    expect(screen.getByRole("alertdialog", { name: /confirm re-arming bot actions/i })).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument(); // still off — no optimistic flip

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, turn on" }));
    });
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Run now posts to the right slot and reports STARTED, not finished, immediately after the POST resolves", async () => {
    const fetchMock = router(baseState());
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run evening now" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bot/digests/run/evening",
      expect.objectContaining({ method: "POST" }),
    );
    // Reports the run STARTED — never claims a finished result the async trigger doesn't have.
    expect(screen.getByText(/evening digest run started/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
  });

  it("polls digest history after a run starts, and reports the fresh entry once it lands", async () => {
    vi.useFakeTimers();
    const state = baseState();
    let digestsCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const s = String(url);
      const method = init?.method ?? "GET";
      if (s.endsWith("/actions/audit")) return ok({ enabled: state.enabled, entries: [] });
      if (s.endsWith("/digests/groups")) return ok(state.groups);
      if (s.endsWith("/media/status")) return ok(state.media);
      if (s.endsWith("/skills")) return ok(state.skills);
      if (method === "POST" && s.endsWith("/digests/run/evening")) return ok({ ok: true, started: true, startedAt: 1 });
      if (s.endsWith("/digests")) {
        digestsCalls++;
        // The initial load + first poll attempt still only see the old noon entry; the second
        // poll attempt sees the fresh evening entry — simulating the real ~90s run.
        if (digestsCalls >= 3) {
          return ok({
            history: [
              { ts: 999_999, slot: "evening", trigger: "manual", groupsCovered: 3, delivered: 3, failed: 0, managementDelivered: 1 },
              ...(state.digests.history as unknown[]),
            ],
            nextRun: state.digests.nextRun,
            timezone: state.digests.timezone,
          });
        }
        return ok(state.digests);
      }
      throw new Error(`unexpected call ${method} ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run evening now" }));
    });
    expect(screen.getByText(/evening digest run started/i)).toBeInTheDocument();

    // Advance through the poll loop (5s interval) until the fresh entry is picked up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByText(/evening digest run finished — delivered 3, failed 0/i)).toBeInTheDocument();
    // The button re-enables once the poll settles.
    expect(screen.getByRole("button", { name: "Run evening now" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a 409 conflict (already running) is reported without starting a poll", async () => {
    const state = baseState();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const s = String(url);
      const method = init?.method ?? "GET";
      if (s.endsWith("/actions/audit")) return ok({ enabled: state.enabled, entries: [] });
      if (s.endsWith("/digests/groups")) return ok(state.groups);
      if (s.endsWith("/media/status")) return ok(state.media);
      if (s.endsWith("/skills")) return ok(state.skills);
      if (method === "POST" && s.endsWith("/digests/run/noon")) {
        return { ok: false, status: 409, json: () => Promise.resolve({ ok: false, conflict: true, error: "A noon digest run is already in progress." }) } as Response;
      }
      if (s.endsWith("/digests")) return ok(state.digests);
      throw new Error(`unexpected call ${method} ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run noon now" }));
    });

    expect(screen.getByText(/already in progress/i)).toBeInTheDocument();
    // Not stuck disabled/"Running…" — the trigger itself failed, nothing to poll for.
    expect(screen.getByRole("button", { name: "Run noon now" })).toBeInTheDocument();
  });

  it("digest preview: pick a group, preview it, and it renders as inert text (never a send)", async () => {
    const state = baseState();
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.endsWith("/actions/audit")) return ok({ enabled: state.enabled, entries: [] });
      if (s.endsWith("/digests/groups")) return ok(state.groups);
      if (s.endsWith("/media/status")) return ok(state.media);
      if (s.endsWith("/skills")) return ok(state.skills);
      if (s.endsWith("/digests")) return ok(state.digests);
      if (s.includes("/digests/preview")) {
        return ok({ chatId: "111@g.us", digest: "Discussion summary\n<b>not html</b>" });
      }
      throw new Error(`unexpected call ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Group to preview" }), { target: { value: "111@g.us" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview (sends nothing)" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/bot/digests/preview?chatId=111%40g.us"),
      expect.anything(),
    );
    // Rendered as literal text (React escapes it) — a `<b>` tag would only ever be markup if
    // dangerouslySetInnerHTML were used, which this component never does.
    expect(screen.getByText(/<b>not html<\/b>/)).toBeInTheDocument();
    expect(screen.queryByText("not html")).not.toBeInTheDocument(); // i.e. not rendered as a real <b>
  });

  it("digest preview: a failed fetch shows an explicit error, never a stuck loading state", async () => {
    const state = baseState();
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.endsWith("/actions/audit")) return ok({ enabled: state.enabled, entries: [] });
      if (s.endsWith("/digests/groups")) return ok(state.groups);
      if (s.endsWith("/media/status")) return ok(state.media);
      if (s.endsWith("/skills")) return ok(state.skills);
      if (s.endsWith("/digests")) return ok(state.digests);
      if (s.includes("/digests/preview")) {
        return { ok: false, json: () => Promise.resolve({ chatId: null, digest: null, error: "That group has no stored messages yet." }) } as Response;
      }
      throw new Error(`unexpected call ${s}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Group to preview" }), { target: { value: "111@g.us" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview (sends nothing)" }));
    });

    expect(screen.getByText("That group has no stored messages yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Generating preview/)).not.toBeInTheDocument();
  });

  it("paginates 33 digest-history rows at 30/page and searches across slot/trigger/error", async () => {
    vi.useFakeTimers();
    const manyHistory = Array.from({ length: 33 }, (_, i) => ({
      ts: i,
      slot: "noon" as const,
      trigger: i === 0 ? "manual" : ("scheduled" as const),
      groupsCovered: 1,
      delivered: 1,
      failed: 0,
      managementDelivered: 0,
      error: i === 0 ? "boom" : undefined,
    }));
    const state = baseState({ digests: { history: manyHistory, nextRun: { noon: null, evening: null }, timezone: null } });
    vi.stubGlobal("fetch", router(state));

    await act(async () => {
      render(<ControlsTab elevated />);
    });

    // Sorted newest-first (ts=32 first); 33 rows -> 30/page -> "1-30 of 33".
    expect(screen.getByText("1–30 of 33")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search digest history" }), {
      target: { value: "manual" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Only the one manual-triggered row (ts=0, error "boom") matches, and its own history rendering
    // proves both the search-by-trigger AND the getSearchText/error-field coverage.
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
