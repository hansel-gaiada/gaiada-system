import { SectionTabs } from "@/components/shell/SectionTabs";
import "@/components/it/network.css";

// The network console is the fourth plane of the estate, alongside Hardware (/it/topology),
// Servers (/systems/observability) and the device registry. It answers a different question from
// all of them: not "what exists" but "what moves, and can we stop it".
//
// Presence is last and deliberately worded as occupancy, never as detection of intruders. It rides
// WiFi hardware, which is why it is filed here, but it is a facilities tool. If "3 people in
// Meeting Room A" ever renders in the same list as an IDS alert, someone will eventually read the
// first as the second.
const TABS = [
  { key: "traffic", label: "Traffic", href: "/it/network", icon: "pulse" as const },
  { key: "threats", label: "Threats", href: "/it/network/threats", icon: "bell" as const },
  { key: "rules", label: "Isolation", href: "/it/network/rules", icon: "settings" as const },
  { key: "presence", label: "Occupancy", href: "/it/network/presence", icon: "user" as const },
];

export default function NetworkLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionTabs tabs={TABS} />
      <div style={{ marginTop: 18 }}>{children}</div>
    </>
  );
}
