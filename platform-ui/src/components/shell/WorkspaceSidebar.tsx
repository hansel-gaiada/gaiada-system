"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { useRailTooltip } from "./railTooltip";
import { SidebarToggle } from "./SidebarToggle";
import { NewMenu } from "./NewMenu";
import { TenantSwitcher } from "./TenantSwitcher";
import { Eyebrow } from "@/components/ui";
import { overviewHref, type ShellModel, type ShellWorkspace } from "@/lib/shellModel";
import { assistantDrawerHref } from "@/lib/assistantContext";
import { ASSISTANT_ROW } from "@/lib/workspaces";
import type { ConcreteRow } from "@/lib/workspaceAccess";
import { useWorkspaceShell } from "./WorkspaceShellContext";
import "./workspace-sidebar.css";

// DW-2a: the department workspace sidebar (plan §2.2), drawn only for people on the pilot switch.
//
// Where the person is (area, view, active row) comes from `WorkspaceShellContext` (DW-2b), so the sidebar,
// the tab strip and the breadcrumbs share one answer. Rows arrive already gated and concrete
// (`lib/shellModel.ts`). This only draws them. A row carries a count only when the model read a real one above 0
// (DW-8m: Approvals); nothing here makes a number up, and a row with no `count` draws no pill.

export interface SidebarCompany { id: string; name: string; badge?: string | null }

export function WorkspaceSidebar({ tenantId, company, companies, newItems, brand }: {
  /** The active company, for the page context the Assistant drawer opens with (DW-2d). */
  tenantId: string | null;
  company: SidebarCompany | null;
  /** Every company the person may switch to; empty when there is only one. */
  companies: SidebarCompany[];
  newItems: { label: string; href: string }[];
  /** The wordmark: the group's name (PV-D13). Omitted when unknown, and the tagline stays. */
  brand?: string | null;
}) {
  const shell = useWorkspaceShell();
  // Only the workspace shell draws this, inside its provider. Outside it there is nothing to draw.
  if (!shell) return null;
  const { model, view, rows, active, pathname } = shell;

  const visiting = view.kind === "workspace" && !view.ws.mine;
  const atHome = view.kind === "workspace" ? view.ws.home : view.kind === "company" && model.home.kind === "company";
  const showBack = !atHome && (visiting || view.kind !== "workspace") && model.homeHref !== null;
  const title = view.kind === "workspace" ? view.ws.label : view.kind === "company" ? "Company" : "Admin";
  const companyHref = model.company[0]?.tabs[0]?.href ?? null;
  const adminHref = model.admin[0]?.tabs[0]?.href ?? null;
  // DW-2f: the current workspace's own create actions lead "+ New"; a later item with the same href is dropped.
  const createItems = view.kind === "workspace" ? view.ws.creates : [];
  const menuItems = [...createItems, ...newItems.filter((it) => !createItems.some((c) => c.href === it.href))];

  return (
    <aside className="erp-side ws-side" id="app-nav">
      <div className="erp-side__head">
        <Link href="/" className="erp-side__brand" aria-label="Home">
          <span className="erp-side__mark" aria-hidden="true"><Icon name="pulse" size={17} /></span>
          {brand ? <div className="erp-side__wordmark">{brand}</div> : null}
          <Eyebrow className="erp-side__tagline">Operating Platform</Eyebrow>
        </Link>
        <SidebarToggle />
      </div>

      <WorkspaceSwitcher model={model} title={title} current={view.kind === "workspace" ? view.ws.id : null} company={company} companies={companies} />

      <nav className="erp-side__nav erp-scroll ws-side__nav" aria-label={`${title} menu`}>
        {(visiting || showBack) && (
          <div className="ws-side__context">
            {visiting && <p className="ws-side__visiting">Visiting {title}</p>}
            {showBack && model.homeHref && <BackLink href={model.homeHref} label={model.homeLabel} />}
          </div>
        )}
        {view.kind === "workspace" ? (
          <>
            <RowGroup rows={view.ws.rows.top} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label="Work" rows={view.ws.rows.work} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label="Performance" rows={view.ws.rows.performance} active={active} pathname={pathname} tenantId={tenantId} />
            <RowGroup label="You" rows={view.ws.rows.you} active={active} pathname={pathname} tenantId={tenantId} />
          </>
        ) : (
          <RowGroup label={title} rows={rows} active={active} pathname={pathname} tenantId={tenantId} />
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

/** The count after a row's label (DW-8m). `role="img"` gives it the one accessible name, "3 waiting for you", in place of
 *  the bare digits; it is a `<b>`, not a `<span>`, so the collapsed rail (which hides every row `span`) keeps it, drawn as
 *  a dot-sized pill on the icon. Past 99 the figure reads "99+" and the name still says the real count. */
function RowCount({ count }: { count: number }) {
  return (
    <b className="ws-row__count" role="img" aria-label={`${count} waiting for you`}>
      {count > 99 ? "99+" : count}
    </b>
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

function WorkspaceSwitcher({ model, title, current, company, companies }: {
  model: ShellModel;
  title: string;
  current: string | null;
  company: SidebarCompany | null;
  companies: SidebarCompany[];
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
    <div className="ws-switch" ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={btn}
        className="ws-switch__btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${title}${company ? `, ${company.name}` : ""}. Switch workspace`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ws-switch__text">
          <span className="ws-switch__ws">{title}</span>
          {company && (
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
