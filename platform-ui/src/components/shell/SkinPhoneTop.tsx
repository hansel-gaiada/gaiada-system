"use client";
import Link from "next/link";
import { Icon } from "./icons";
import { RowCount } from "./RowCount";
import { useWorkspaceShell } from "./WorkspaceShellContext";
import { phoneTopFor, pinnedFor, type ConcretePinned } from "@/lib/skins";
import { allRows } from "@/lib/shellModel";
import "./workspace-sidebar-social.css";

// SCP-Ke (DW-D51, plan §6.2): the phone's controls at the top right of the top bar in the Social skin: Notifications (the heart, with the unread
// count the bar's one read settled, `shell.unread`), Messages (ticketed SCP-1j, so absent until its page exists), and More. Nothing for Standard.
// Shown only on a phone (`workspace-sidebar-social.css`): there the menu column is gone, and the avatar menu and the bell are hidden in this skin.

export function SkinPhoneTop() {
  const shell = useWorkspaceShell();
  const ws = shell?.view.kind === "workspace" ? shell.view.ws : null;
  if (!shell || !ws || ws.skin === "standard") return null;
  const top = phoneTopFor(ws.skin, pinnedFor(ws.skin, allRows(ws)) ?? []);
  const sheetOpen = shell.more === "sheet";
  return (
    <div className="erp-top__phone">
      {top.map((pin) => (pin.kind === "link"
        ? <TopLink key={pin.key} pin={pin} />
        : pin.item === "notifications" ? <TopNotifications key={pin.key} pin={pin} unread={shell.unread} current={shell.pathname === INBOX || shell.pathname.startsWith(`${INBOX}/`)} /> : null))}
      {/* The design opens More from a ☰ on the profile. Until Profile (SCP-1k) exists this button stands in for it, so More is reachable on a phone. */}
      <button
        type="button"
        ref={shell.sheetAnchor}
        className="ws-phone__btn"
        aria-label="More"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-controls={shell.sheetId}
        onClick={() => shell.setMore(sheetOpen ? null : "sheet")}
      >
        <Icon name="menu" size={24} stroke={2} />
      </button>
    </div>
  );
}

const INBOX = "/me/inbox";

/** Notifications: the inbox, with the unread count as its badge. Unknown (null) and 0 draw no badge, never a made-up number. The visible name is
 *  the word plus the count's own name ("4 unread"), in text a screen reader reads. */
function TopNotifications({ pin, unread, current }: { pin: Extract<ConcretePinned, { kind: "shell" }>; unread: number | null; current: boolean }) {
  return (
    <Link href={INBOX} className="ws-phone__btn" aria-current={current ? "page" : undefined}>
      <Icon name={pin.icon} size={24} stroke={2} />
      <span className="ws-phone__sr">{pin.label}</span>
      {unread !== null && unread > 0 ? <RowCount count={unread} label={`${unread} unread`} className="ws-phone__count" /> : null}
    </Link>
  );
}

/** A link entry kept at the top (Messages, once its page is built). */
function TopLink({ pin }: { pin: Extract<ConcretePinned, { kind: "link" }> }) {
  return (
    <Link href={pin.href} className="ws-phone__btn" aria-label={pin.label}>
      <Icon name={pin.icon} size={24} stroke={2} />
      {pin.count ? <RowCount count={pin.count} className="ws-phone__count" /> : null}
    </Link>
  );
}
