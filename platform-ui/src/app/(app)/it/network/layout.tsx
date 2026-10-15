import { SectionTabs } from "@/components/shell/SectionTabs";
import "@/components/it/network.css";

// IT > Network, the ERP side (DW-7h, DW-D36). The office network cannot be read until the office collector exists, so these four
// tabs show what reaches the ERP itself: who is connected, every sign-in, the alerts the ERP computes from them, and the
// addresses IT has blocked. Topology (/it/topology) stays the registry of devices.
//
// Connected is first because it answers the question IT asks first ("who is in right now"); the others follow from it.
const TABS = [
  { key: "connected", label: "Connected", href: "/it/network/presence", icon: "user" as const },
  { key: "sign-ins", label: "Sign-ins", href: "/it/network", icon: "pulse" as const },
  { key: "alerts", label: "Alerts", href: "/it/network/threats", icon: "bell" as const },
  { key: "blocks", label: "Blocks", href: "/it/network/rules", icon: "settings" as const },
];

export default function NetworkLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionTabs tabs={TABS} />
      <div style={{ marginTop: 18 }}>{children}</div>
    </>
  );
}
