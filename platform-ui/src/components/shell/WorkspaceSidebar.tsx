"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { useRailTooltip } from "./railTooltip";
import { SidebarToggle } from "./SidebarToggle";
import { NewMenu } from "./NewMenu";
import { TenantSwitcher } from "./TenantSwitcher";
import { Eyebrow } from "@/components/ui";
import { allRows, overviewHref, type ShellModel, type ShellWorkspace } from "@/lib/shellModel";
import { assistantDrawerHref } from "@/lib/assistantContext";
import { ASSISTANT_ROW } from "@/lib/workspaces";
import type { ConcreteRow } from "@/lib/workspaceAccess";
import { activePinKey, pinnedFor, type ConcretePinned } from "@/lib/skins";
import type { PaletteOpenDetail } from "./CommandPalette";
import { useWorkspaceShell } from "./WorkspaceShellContext";
import { RowCount } from "./RowCount";
import { MorePanel, type SidebarAccount } from "./MorePanel";
import { useSidebarState } from "./sidebarState";
import { moreCountOf, type MoreGroup } from "@/lib/morePanel";
import "./workspace-sidebar.css";
import "./workspace-sidebar-social.css";

// DW-2a: the department workspace sidebar (plan §2.2), the only sidebar (DW-D38).
//
// Where the person is (area, view, active row) comes from `WorkspaceShellContext` (DW-2b), so the sidebar,
// the tab strip and the breadcrumbs share one answer. Rows arrive already gated and concrete
// (`lib/shellModel.ts`). This only draws them. A row carries a count only when the model read a real one above 0
// (DW-8m: Approvals); nothing here makes a number up, and a row with no `count` draws no pill.
//
// SCP-Kc (DW-D51): a workspace whose skin is not Standard draws its PINNED menu in place of the Overview, Work, Performance and You groups
// (`PinnedMenu`, below): one row per entry the person's model offers, then "More", which slides the More panel out beside the menu (SCP-Kd,
// `MorePanel`): Find a page, today's Work, Performance and You rows, and the account. It is the same rows, links and gates, only arranged
// differently, and Standard never reaches that code.

export interface SidebarCompany { id: string; name: string; badge?: string | null }

export function WorkspaceSidebar({ tenantId, company, companies, newItems, brand, account = null }: {
  /** The active company, for the page context the Assistant drawer opens with (DW-2d). */
  tenantId: string | null;
  company: SidebarCompany | null;
  /** Every company the person may switch to; empty when there is only one. */
  companies: SidebarCompany[];
  newItems: { label: string; href: string }[];
  /** The wordmark: the group's name (PV-D13). Omitted when unknown, and the tagline stays. */
  brand?: string | null;
  /** The person, for the Social skin's More panel (SCP-Kd): the account the top bar's avatar menu offers, which that skin moves into the panel. */
  account?: SidebarAccount | null;
}) {
  const shell = useWorkspaceShell();
  // Only the workspace shell draws this, inside its provider. Outside it there is nothing to draw.
  if (!shell) return null;
  const { model, view, active, pathname } = shell;

  const visiting = view.kind === "workspace" && !view.ws.mine;
  const atHome = view.kind === "workspace" ? view.ws.home : view.kind === "company" && model.home.kind === "company";
  const showBack = !atHome && (visiting || view.kind !== "workspace") && model.homeHref !== null;
  const title = view.kind === "workspace" ? view.ws.label : view.kind === "company" ? "Company" : "Admin";
  const companyHref = model.company[0]?.tabs[0]?.href ?? null;
  const adminHref = model.admin[0]?.tabs[0]?.href ?? null;
  // DW-2f: the current workspace's own create actions lead "+ New"; a later item with the same href is dropped.
  const createItems = view.kind === "workspace" ? view.ws.creates : [];
  const menuItems = [...createItems, ...newItems.filter((it) => !createItems.some((c) => c.href === it.href))];
  // SCP-Kc: the pinned entries of a skinned workspace; null for Standard (and for Company and Admin, which are always Standard).
  const ws = view.kind === "workspace" ? view.ws : null;
  const pins = ws && ws.skin !== "standard" ? pinnedFor(ws.skin, allRows(ws)) : null;

  return (
    <aside className="erp-side ws-side" id="app-nav">
      <div className="erp-side__head">
        <Link href="/" className="erp-side__brand" aria-label="Home">
          <span className="erp-side__mark" aria-hidden="true"><Icon name="pulse" size={17} /></span>
          {brand ? <div className="erp-side__wordmark">{brand}</div> : pins ? <div className="erp-side__wordmark">{title}</div> : null}
          <Eyebrow className="erp-side__tagline">Operating Platform</Eyebrow>
        </Link>
        <SidebarToggle />
      </div>

      {/* A skinned workspace carries its one switcher inside the More panel (SCP-Kd), so every skin still has exactly one. */}
      {!pins && <WorkspaceSwitcher model={model} title={title} current={view.kind === "workspace" ? view.ws.id : null} company={company} companies={companies} />}

      <nav className="erp-side__nav erp-scroll ws-side__nav" aria-label={`${title} menu`}>
        {(visiting || showBack) && (
          <div className="ws-side__context">
            {visiting && <p className="ws-side__visiting">Visiting {title}</p>}
            {showBack && model.homeHref && <BackLink href={model.homeHref} label={model.homeLabel} />}
          </div>
        )}
        {ws && pins ? (
          <PinnedMenu
            ws={ws} pins={pins} active={active} pathname={pathname} tenantId={tenantId} menuItems={menuItems} account={account}
            switcher={<WorkspaceSwitcher model={model} title={title} current={ws.id} company={company} companies={companies} inline />}
          />
        ) : view.kind === "workspace" ? (
          <>
            <RowGroup rows={view.ws.rows.top} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label="Work" rows={view.ws.rows.work} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label="Performance" rows={view.ws.rows.performance} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label="You" rows={view.ws.rows.you} active={active} pathname={pathname} tenantId={tenantId} />
          </>
        ) : (
          <>
            {/* The AI Assistant row leads the Company and Admin menus too (it is in a workspace's top block), so the assistant is one click away in every area. */}
            <RowGroup rows={view.kind === "company" ? model.companyTop : model.adminTop} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label={title} rows={view.kind === "company" ? model.company : model.admin} active={active} pathname={pathname} tenantId={tenantId} />
          </>
        )}
      </nav>

      <div className="ws-side__foot">
        {companyHref && <FootLink href={companyHref} label="Company" icon="sitemap" />}
        {adminHref && <FootLink href={adminHref} label="Admin" icon="settings" />}
        <div className="erp-side__new">
          <NewMenu items={menuItems} />
        </div>
      </div>
    </aside>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

function RowGroup({ label, rows, active, pathname, tenantId }: {
  label?: string; rows: ConcreteRow[]; active: { rowKey: string } | null; pathname: string; tenantId: string | null;
}) {
  const id = useId();
  if (rows.length === 0) return null;
  return (
    <div className="ws-side__group" {...(label ? { role: "group", "aria-labelledby": id } : {})}>
      {label && <div className="ws-side__label" id={id}>{label}</div>}
      {rows.map((row) => (
        <RowLink key={row.key} row={row} active={active?.rowKey === row.key} pathname={pathname} tenantId={tenantId} />
      ))}
    </div>
  );
}

/** A row links to its first tab; the shell's tab strip (WorkspaceTabStrip) shows the rest.
 *
 *  DW-2d: the AI Assistant row opens today's assistant DRAWER over the current page, the way the floating
 *  button did, so it links to `assistantDrawerHref` (the page context rides in the URL) with the button's
 *  `id` (the drawer returns focus to it when it closes; the button is not drawn in this shell, so the id
 *  stays unique) and no prefetch, for the button's reason: a prefetched payload can be the full page
 *  instead of the drawer, so the click must fetch the intercepted route itself. On /assistant it is just
 *  the active row, linking to the page. */
function RowLink({ row, active, pathname, tenantId }: { row: ConcreteRow; active: boolean; pathname: string; tenantId: string | null }) {
  const { tip, triggerProps } = useRailTooltip(row.label);
  const assistant = row.key === ASSISTANT_ROW.key;
  return (
    <>
      <Link
        href={assistant && pathname !== row.tabs[0].href ? assistantDrawerHref(pathname, tenantId) : row.tabs[0].href}
        {...(assistant ? { id: "asst-fab-trigger", prefetch: false } : {})}
        className={`erp-navbtn ws-row${active ? " erp-navbtn--active ws-row--active" : ""}`}
        aria-current={active ? "page" : undefined}
        {...triggerProps}
      >
        <Icon name={row.icon} size={16} />
        <span>{row.label}</span>
        {row.count ? <RowCount count={row.count} /> : null}
      </Link>
      {tip}
    </>
  );
}

// ── The pinned menu (SCP-Kc) ──────────────────────────────────────────────────────────────────────
// What a skinned workspace draws instead of the groups: the pinned entries in the skin's order (a link to a page the model offers, or one of
// the shell's own items), then "More". Which entry is current is `activePinKey` over the shell's one answer for where the person is.

/** The bell's page: the Inbox row's Notifications tab (`YOU_ROWS`). */
const INBOX_HREF = "/me/inbox";

/** Whether `pathname` is `base` or a page below it. */
const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

function PinnedMenu({ ws, pins, active, pathname, tenantId, menuItems, account, switcher }: {
  ws: ShellWorkspace; pins: ConcretePinned[]; active: { rowKey: string; tabKey: string } | null; pathname: string; tenantId: string | null;
  menuItems: { label: string; href: string }[]; account: SidebarAccount | null; switcher: ReactNode;
}) {
  const shell = useWorkspaceShell();
  const unread = shell?.unread ?? null;
  const activeKey = activePinKey(pins, active);
  // Notifications is a shell entry, so it is current by its own page; that page is also the Inbox row's first tab, which More still lists.
  const inboxHere = isUnder(pathname, INBOX_HREF);
  // The rows More lists, exactly as the model gives them: Work, Performance and You.
  const groups: MoreGroup[] = [
    { key: "work", label: "Work", rows: ws.rows.work },
    { key: "performance", label: "Performance", rows: ws.rows.performance },
    { key: "you", label: "You", rows: ws.rows.you },
  ];
  const moreCount = moreCountOf(groups);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const moreButton = useRef<HTMLButtonElement>(null);
  const more = useRailTooltip("More");
  const close = useCallback((returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreButton.current?.focus();
  }, []);

  // While the panel is open the menu is its icon rail. The rail is the collapsed sidebar's own CSS, keyed on `<html data-sidebar="collapsed">`, so
  // that is what is set, and removed on close unless the person had collapsed the menu themselves. Their saved choice (the cookie and the
  // toggle's state, `sidebarState.tsx`) is never touched. It follows `collapsed`, so using the toggle while the panel is open stays consistent.
  const { collapsed } = useSidebarState();
  const collapsedNow = useRef(collapsed);
  collapsedNow.current = collapsed;
  useEffect(() => {
    if (!moreOpen) return;
    const root = document.documentElement;
    root.setAttribute("data-sidebar", "collapsed");
    return () => {
      if (!collapsedNow.current) root.removeAttribute("data-sidebar");
    };
  }, [moreOpen, collapsed]);

  // Another page was chosen (a link anywhere), so the panel has done its job.
  useEffect(() => setMoreOpen(false), [pathname]);

  return (
    <>
      <div className="ws-side__group ws-pins">
        {pins.map((pin) =>
          pin.kind === "link" ? (
            <PinLink key={pin.key} pin={pin} active={activeKey === pin.key} pathname={pathname} tenantId={tenantId} />
          ) : pin.item === "search" ? (
            <PinSearch key={pin.key} pin={pin} />
          ) : pin.item === "notifications" ? (
            <PinNotifications key={pin.key} pin={pin} unread={unread} active={inboxHere} />
          ) : (
            <NewMenu key={pin.key} items={menuItems} row={{ label: pin.label, icon: pin.icon }} />
          ),
        )}
      </div>
      <div className="ws-side__group ws-pins ws-pins__more">
        <button
          type="button"
          ref={moreButton}
          className="erp-navbtn ws-row ws-pin"
          aria-expanded={moreOpen}
          aria-controls={moreId}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen((v) => !v)}
          {...more.triggerProps}
        >
          <Icon name="menu" size={24} stroke={2} />
          <span>More</span>
          {moreCount > 0 ? <RowCount count={moreCount} /> : null}
        </button>
        {more.tip}
        {moreOpen && (
          <MorePanel
            id={moreId} groups={groups} active={active} pathname={pathname} tenantId={tenantId}
            account={account} switcher={switcher} anchor={moreButton} onClose={close}
          />
        )}
      </div>
    </>
  );
}

/** A pinned link. The AI Assistant entry is today's Assistant row exactly: the drawer's href, the button's `id`, no prefetch. */
function PinLink({ pin, active, pathname, tenantId }: { pin: Extract<ConcretePinned, { kind: "link" }>; active: boolean; pathname: string; tenantId: string | null }) {
  const { tip, triggerProps } = useRailTooltip(pin.label);
  const assistant = pin.row === ASSISTANT_ROW.key;
  return (
    <>
      <Link
        href={assistant && pathname !== pin.href ? assistantDrawerHref(pathname, tenantId) : pin.href}
        {...(assistant ? { id: "asst-fab-trigger", prefetch: false } : {})}
        className={`erp-navbtn ws-row ws-pin${active ? " erp-navbtn--active ws-row--active ws-pin--active" : ""}`}
        aria-current={active ? "page" : undefined}
        {...triggerProps}
      >
        <Icon name={pin.icon} size={24} stroke={2} />
        <span>{pin.label}</span>
        {pin.count ? <RowCount count={pin.count} /> : null}
      </Link>
      {tip}
    </>
  );
}

/** Search opens the command palette, as the top bar's field does (`TopBarSearch`); the shortcut itself lives in `CommandPalette`. */
function PinSearch({ pin }: { pin: Extract<ConcretePinned, { kind: "shell" }> }) {
  const { tip, triggerProps } = useRailTooltip(pin.label);
  return (
    <>
      <button
        type="button"
        className="erp-navbtn ws-row ws-pin"
        onClick={() => window.dispatchEvent(new CustomEvent<PaletteOpenDetail>("gaiada:palette:open", { detail: {} }))}
        {...triggerProps}
      >
        <Icon name={pin.icon} size={24} stroke={2} />
        <span>{pin.label}</span>
      </button>
      {tip}
    </>
  );
}

/** Notifications opens the inbox and carries the unread count the top bar's one read settled. Unknown (null) draws no badge, never 0. */
function PinNotifications({ pin, unread, active }: { pin: Extract<ConcretePinned, { kind: "shell" }>; unread: number | null; active: boolean }) {
  const { tip, triggerProps } = useRailTooltip(pin.label);
  return (
    <>
      <Link
        href={INBOX_HREF}
        className={`erp-navbtn ws-row ws-pin${active ? " erp-navbtn--active ws-row--active ws-pin--active" : ""}`}
        aria-current={active ? "page" : undefined}
        {...triggerProps}
      >
        <Icon name={pin.icon} size={24} stroke={2} />
        <span>{pin.label}</span>
        {unread !== null && unread > 0 ? <RowCount count={unread} label={`${unread} unread`} /> : null}
      </Link>
      {tip}
    </>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  const text = `Back to ${label}`;
  const { tip, triggerProps } = useRailTooltip(text);
  return (
    <>
      <Link href={href} className="erp-navbtn ws-side__back" aria-label={text} {...triggerProps}>
        <Icon name="chevron" size={14} />
        <span>{text}</span>
      </Link>
      {tip}
    </>
  );
}

function FootLink({ href, label, icon }: { href: string; label: string; icon: "sitemap" | "settings" }) {
  const { tip, triggerProps } = useRailTooltip(label);
  return (
    <>
      <Link href={href} className="erp-navbtn ws-row" aria-label={label} {...triggerProps}>
        <Icon name={icon} size={16} />
        <span>{label}</span>
      </Link>
      {tip}
    </>
  );
}

// ── The switcher (plan §2.2) ──────────────────────────────────────────────────────────────────────
// A disclosure: the button shows where you are, the panel lists your own workspaces, then every
// department (ungated, like the org chart, GM-01), then the company switch. Escape and an outside click
// close it, and Escape hands focus back to the button. Arrow keys move through the links.

// `inline` (SCP-Kd): the Social skin's More panel carries the switcher as its "Switch workspace" row, naming the current workspace on a second
// line, with the same list opening beneath it instead of floating. The same component, so the list, the keys and the company switch are one.
function WorkspaceSwitcher({ model, title, current, company, companies, inline = false }: {
  model: ShellModel;
  title: string;
  current: string | null;
  company: SidebarCompany | null;
  companies: SidebarCompany[];
  inline?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const mineId = useId();
  const allId = useId();

  // Choosing a workspace navigates; the panel has done its job.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const entries = (list: ShellWorkspace[]) =>
    list.flatMap((ws) => {
      const href = overviewHref(ws);
      return href ? [{ ws, href }] : [];
    });
  const mine = entries(model.workspaces.filter((w) => w.mine));
  const others = entries(model.workspaces.filter((w) => !w.mine));

  function links(): HTMLElement[] {
    return Array.from(wrap.current?.querySelectorAll<HTMLElement>(".ws-switch__pop a, .ws-switch__pop select") ?? []);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // A native select uses the arrows itself.
    if ((e.target as HTMLElement).tagName === "SELECT") return;
    e.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const items = links();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at < 0 ? 0 : Math.min(items.length - 1, at + 1)) : Math.max(0, at - 1);
    items[next]?.focus();
  }

  const item = ({ ws, href }: { ws: ShellWorkspace; href: string }) => (
    <li key={ws.id}>
      <Link href={href} className="ws-switch__item" aria-current={ws.id === current ? "true" : undefined} onClick={() => setOpen(false)}>
        <span>{ws.label}</span>
        {ws.home && <span className="ws-switch__tag">Home</span>}
      </Link>
    </li>
  );

  return (
    <div className={`ws-switch${inline ? " ws-switch--inline" : ""}`} ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={btn}
        className="ws-switch__btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={inline ? `Switch workspace, ${title}${company ? `, ${company.name}` : ""}` : `${title}${company ? `, ${company.name}` : ""}. Switch workspace`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ws-switch__text">
          <span className="ws-switch__ws">{inline ? "Switch workspace" : title}</span>
          {inline ? (
            <span className="ws-switch__co">{title}</span>
          ) : company && (
            <span className="ws-switch__co">
              {company.name}
              {company.badge && <span className="erp-company__served-badge">· {company.badge}</span>}
            </span>
          )}
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="ws-switch__pop" id={panelId}>
          {mine.length > 0 && (
            <>
              <p className="ws-switch__label" id={mineId}>Your workspaces</p>
              <ul className="ws-switch__list" aria-labelledby={mineId}>{mine.map(item)}</ul>
            </>
          )}
          {others.length > 0 && (
            <>
              <p className="ws-switch__label" id={allId}>Departments</p>
              <ul className="ws-switch__list" aria-labelledby={allId}>{others.map(item)}</ul>
            </>
          )}
          {companies.length > 1 && (
            <div className="ws-switch__company">
              <p className="ws-switch__label">Switch company</p>
              <TenantSwitcher companies={companies} current={company?.id ?? null} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
