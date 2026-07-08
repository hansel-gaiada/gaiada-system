import type { Me } from "@/lib/platform";
import type { IconName } from "./icons";

export interface NavItem { label: string; href: string; icon: IconName }
export interface NavGroup { label: string; items: NavItem[] }

const ELEVATED = new Set(["platform_admin", "group_executive"]);

export function navFor(me: Me): NavGroup[] {
  const elevated = me.roles.some((r) => ELEVATED.has(r.role));
  const business: NavItem[] = [
    { label: "Companies", href: "/companies", icon: "finance" },
    { label: "Projects", href: "/projects", icon: "projects" },
    { label: "Tasks", href: "/tasks", icon: "check" },
    { label: "Agency", href: "/agency", icon: "sales" },
    ...(elevated ? [{ label: "Rollups", href: "/rollups", icon: "pulse" } as NavItem] : []),
  ];
  const groups: NavGroup[] = [
    { label: "Workspace", items: [
      { label: "My Work", href: "/", icon: "home" },
      { label: "Approvals", href: "/approvals", icon: "check" },
    ] },
    { label: "Business", items: business },
    { label: "Intelligence", items: [
      { label: "Knowledge", href: "/knowledge", icon: "box" },
      { label: "AI Agents", href: "/agents", icon: "agents" },
    ] },
    { label: "Systems", items: [
      { label: "WA/TG Bot", href: "/systems/bot", icon: "bot" },
      { label: "AI Gateway", href: "/systems/gateway", icon: "gateway" },
      { label: "MCP Hub", href: "/systems/hub", icon: "hub" },
      { label: "Automation", href: "/systems/automation", icon: "automation" },
    ] },
  ];
  if (elevated) {
    groups.push({ label: "Admin", items: [
      { label: "Users & Roles", href: "/admin/users", icon: "hr" },
      { label: "Identity Links", href: "/admin/identity", icon: "hub" },
      { label: "Modules & Fields", href: "/admin/modules", icon: "box" },
      { label: "Compliance Gates", href: "/admin/compliance", icon: "check" },
      { label: "Audit", href: "/admin/audit", icon: "clock" },
    ] });
  }
  return groups;
}
