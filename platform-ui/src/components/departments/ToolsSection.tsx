import { LauncherRow } from "./LauncherRow";
import { MAX_PINNED_TOOLS, pinnedToolsFor } from "@/lib/pinnedTools";
import { launcherSeatProps } from "@/lib/claudeSeats";
import type { Workspace } from "@/lib/workspaces";
import type { SeatRow } from "@/lib/claudeSeats";

// DW-6c: the Tools half of the pilot's Tools & connections page (plan §4.1). The workspace's tools in
// registry order, each opening in a new tab, with your own seat on the Claude tools exactly as the
// department Home shows it (same `LauncherRow`, same `launcherSeatProps`). Each tool has a pin button
// that is a real <button> in a <form> posting to a server action, so it works without JavaScript.

/** The three Claude tools are the only ones with a per-person seat (same set as the department Home). */
const CLAUDE_TOOL_KEYS = new Set(["claude-code", "claude", "claude-design"]);

export function ToolsSection({
  workspace, pins, seat, seatsUnavailable, toggleAction,
}: {
  workspace: Pick<Workspace, "key" | "tools">;
  /** The `pinnedTools` pref. The effective pins (default: the first six) are worked out here. */
  pins: Record<string, string[]>;
  seat: SeatRow | undefined;
  seatsUnavailable: boolean;
  /** `togglePinnedToolAction`. Bound per tool here; it re-checks everything on the server. */
  toggleAction: (workspaceKey: string, toolKey: string) => Promise<void>;
}) {
  const tools = workspace.tools;
  if (tools.length === 0) {
    return <p className="dept-conn-note">No tools are set up for this department yet.</p>;
  }
  const pinned = new Set(pinnedToolsFor(pins, workspace).map((t) => t.key));
  const full = pinned.size >= MAX_PINNED_TOOLS;
  const seatProps = launcherSeatProps(seat, seatsUnavailable);

  return (
    <>
      <ul className="dept-tools-list">
        {tools.map((t) => {
          const isPinned = pinned.has(t.key);
          const hasSeat = CLAUDE_TOOL_KEYS.has(t.key);
          const sp = hasSeat ? seatProps : {};
          const seatLine = sp.seatStatus === "mapped" ? sp.seatLabel : sp.seatStatus === "unmapped" ? "Map your seat" : null;
          return (
            <li key={t.key} className="dept-tools-row" data-tool={t.key}>
              <LauncherRow items={[{ key: t.key, label: t.label, desc: t.desc, href: t.url, glyph: t.glyph, icon: t.icon, ...sp }]} />
              <div className="dept-tools-row__text">
                <span className="dept-tools-row__label">{t.label}</span>
                <span className="dept-tools-row__desc">{t.desc}</span>
                {seatLine && <span className="dept-tools-row__seat">{seatLine}</span>}
              </div>
              <form action={toggleAction.bind(null, workspace.key, t.key)}>
                <button
                  type="submit"
                  className="dept-tools-row__pin"
                  aria-pressed={isPinned}
                  aria-label={isPinned ? `Unpin ${t.label} from the Overview` : `Pin ${t.label} to the Overview`}
                  disabled={!isPinned && full}
                >
                  {isPinned ? "Pinned" : "Pin"}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
      <p className="dept-conn-note" style={{ marginTop: 12 }}>
        Pinned tools show on the Overview. At most {MAX_PINNED_TOOLS} tools can be pinned.
        {full ? " Unpin one to pin another." : ""}
      </p>
    </>
  );
}
