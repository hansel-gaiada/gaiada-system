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
        className={`erp-sidetoggle${collapsed ? " erp-sidetoggle--collapsed" : ""}`}
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls="app-nav"
        onClick={toggle}
        {...triggerProps}
      >
        {/* A chevron on the panel edge, per the design — it points the way
            the panel will travel, so it flips with the state. */}
        <Icon name="chevron" size={13} />
      </button>
      {tip}
    </>
  );
}
