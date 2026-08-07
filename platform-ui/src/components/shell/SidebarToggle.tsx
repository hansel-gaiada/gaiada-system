"use client";
import { Icon } from "./icons";
import { useRailTooltip } from "./railTooltip";
import { useSidebarState } from "./sidebarState";

// Collapse control in the sidebar header.
export function SidebarToggle() {
  const { collapsed, toggle } = useSidebarState();
  const label = collapsed ? "Open sidebar" : "Close sidebar";
  const { tip, triggerProps } = useRailTooltip(label);

  return (
    <>
      <button
        type="button"
        className="erp-sidetoggle"
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls="app-nav"
        onClick={toggle}
        {...triggerProps}
      >
        <Icon name="panelLeft" size={19} />
      </button>
      {tip}
    </>
  );
}
