"use client";
import { useCallback } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import { NewMenu, menuItemsFor } from "./NewMenu";
import { RowCount } from "./RowCount";
import { MENU_PREFIX, MorePanel, type SidebarAccount } from "./MorePanel";
import { WorkspaceSwitcher, type SidebarCompany } from "./WorkspaceSidebar";
import { useWorkspaceShell } from "./WorkspaceShellContext";
import type { PaletteOpenDetail } from "./CommandPalette";
import { allRows, type ShellWorkspace } from "@/lib/shellModel";
import { activePinKey, phoneBarFor, phoneMenuFor, phoneTopFor, pinnedFor, type ConcretePinned } from "@/lib/skins";
import type { MoreGroup } from "@/lib/morePanel";
import type { ConcreteRow } from "@/lib/workspaceAccess";
import "./workspace-sidebar-social.css";
import "./more-panel.css";

// SCP-Ke (DW-D51, plan §6.2): the Social skin on a phone (the shell's own breakpoint, 760px).
//
// A phone has no menu column: the sidebar is an off-canvas drawer, which this skin never opens. In its place the design has a bottom bar (Home,
// Search, Create, Tasks, Profile), Notifications and Messages at the top right (`SkinPhoneTop`), and More as a full-screen sheet. The sheet is the
// SAME `MorePanel` as the desktop's, so it also lists the pinned entries a phone has no other place for (Calendar, Reports, Saved, the AI Assistant,
// and Dashboard and Settings once their pages exist) as a first section, "Menu".
//
// Everything comes from the skin's pins (`pinnedFor`), so the bar can name no page the person's model does not offer. Rendered by the sidebar's
// server half (a sibling of the sidebar inside the frame), and NOT inside `.erp-side`: on a phone that is a fixed, transformed drawer, which would trap a
// fixed child. It draws nothing for Standard, so the Standard frame is unchanged. Hidden above 760px by CSS (`workspace-sidebar-social.css`).

/** The bottom bar's name as a landmark: distinct from the menu's own `<nav>` (named for the workspace) and from the Overview's "Quick actions" card, which
 *  an e2e scan found on the same page. */
const BAR_LABEL = "Bottom navigation";

export function SkinPhoneBar({ tenantId, newItems, company, companies, account }: {
  /** The active company, for the page context the Assistant drawer opens with, as the sidebar's own Assistant entry. */
  tenantId: string | null;
  newItems: { label: string; href: string }[];
  company: SidebarCompany | null;
  companies: SidebarCompany[];
  account: SidebarAccount | null;
}) {
  const shell = useWorkspaceShell();
  const ws = shell?.view.kind === "workspace" ? shell.view.ws : null;
  if (!shell || !ws || ws.skin === "standard") return null;
  return <Bar ws={ws} tenantId={tenantId} newItems={newItems} company={company} companies={companies} account={account} />;
}

function Bar({ ws, tenantId, newItems, company, companies, account }: {
  ws: ShellWorkspace; tenantId: string | null;
  newItems: { label: string; href: string }[]; company: SidebarCompany | null; companies: SidebarCompany[]; account: SidebarAccount | null;
}) {
  const shell = useWorkspaceShell()!;
  const pins = pinnedFor(ws.skin, allRows(ws)) ?? [];
  const activeKey = activePinKey(pins, shell.active);
  const items = menuItemsFor(ws.creates, newItems);
  const setMore = shell.setMore;
  const sheetOpen = shell.more === "sheet";
  const close = useCallback((returnFocus: boolean) => {
    setMore(null);
    if (returnFocus) shell.sheetAnchor.current?.focus();
  }, [setMore, shell.sheetAnchor]);

  // The sheet's first section: the pinned links the bar and the top do not hold, as single-page rows (no second line) with their own counts.
  const menuRows: ConcreteRow[] = phoneMenuFor(ws.skin, pins).map((p) => ({
    key: `${MENU_PREFIX}${p.key}`, label: p.label, icon: p.icon, ...(p.count ? { count: p.count } : {}),
    tabs: [{ key: p.tab, label: p.label, href: p.href, icon: p.icon }],
  }));
  // The sidebar's foot links, Company and Admin (a workspace's menu offers them below its rows): a phone has no sidebar, so they are listed here, or those
  // two areas would be one tap away on every other skin and none on a phone. Each opens the area's first page, as the foot link does.
  const areaRow = (key: string, label: string, icon: ConcreteRow["icon"], rows: readonly ConcreteRow[]): ConcreteRow[] => {
    const tab = rows[0]?.tabs[0];
    return tab ? [{ key: `${MENU_PREFIX}${key}`, label, icon, tabs: [{ key: tab.key, label, href: tab.href, icon }] }] : [];
  };
  const areaRows = [...areaRow("company", "Company", "sitemap", shell.model.company), ...areaRow("admin", "Admin", "settings", shell.model.admin)];
  const groups: MoreGroup[] = [
    { key: "menu", label: "Menu", rows: menuRows },
    { key: "work", label: "Work", rows: ws.rows.work },
    { key: "performance", label: "Performance", rows: ws.rows.performance },
    { key: "you", label: "You", rows: ws.rows.you },
    { key: "areas", label: "Company and Admin", rows: areaRows },
  ];

  return (
    <>
      <nav className="ws-bar" aria-label={BAR_LABEL}>
        {phoneBarFor(ws.skin, pins).map((pin) => (
          <BarSlot key={pin.key} pin={pin} current={activeKey === pin.key} items={items} />
        ))}
      </nav>
      {sheetOpen && (
        <MorePanel
          sheet
          id={shell.sheetId} groups={groups} active={shell.active} pathname={shell.pathname} tenantId={tenantId}
          currentKey={activeKey ? `${MENU_PREFIX}${activeKey}` : null}
          account={account} anchor={shell.sheetAnchor} onClose={close}
          switcher={<WorkspaceSwitcher model={shell.model} title={ws.label} current={ws.id} company={company} companies={companies} inline />}
        />
      )}
    </>
  );
}

/** One slot of the bar: icon only, named by `aria-label`. A link, Search (the command palette) or Create (the New menu, opening upward). */
function BarSlot({ pin, current, items }: { pin: ConcretePinned; current: boolean; items: { label: string; href: string }[] }) {
  if (pin.kind === "link") {
    return (
      <Link href={pin.href} className={`ws-bar__btn${current ? " ws-bar__btn--active" : ""}`} aria-label={pin.label} aria-current={current ? "page" : undefined}>
        <Icon name={pin.icon} size={24} stroke={2} />
        {pin.count ? <RowCount count={pin.count} className="ws-bar__count" /> : null}
      </Link>
    );
  }
  if (pin.item === "search") {
    return (
      <button
        type="button"
        className="ws-bar__btn"
        aria-label={pin.label}
        onClick={() => window.dispatchEvent(new CustomEvent<PaletteOpenDetail>("gaiada:palette:open", { detail: {} }))}
      >
        <Icon name={pin.icon} size={24} stroke={2} />
      </button>
    );
  }
  if (pin.item === "create") return <NewMenu items={items} row={{ label: pin.label, icon: pin.icon, bar: true }} />;
  return null;
}
