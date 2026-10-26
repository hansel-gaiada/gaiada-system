// SCP-1c — one client's (or one post's) schedule health as a chip (BFF §63.5): a dot and the words, in the state's design token. The words always
// carry the meaning ("On track · 3 spare days", "Late · 2 days · with the designer"), so the colour is never the only signal. No Health, no chip
// content: "No cycle" says the client has no cycle this month, which is a different fact from "on track".
import { HEALTH_TOKEN, healthText, type Health } from "@/lib/socialCycles";

export function HealthChip({ health }: { health: Health | null }) {
  if (!health) return <span className="scp-health scp-health--none">No cycle</span>;
  return (
    <span className="scp-health" data-state={health.state} style={{ color: HEALTH_TOKEN[health.state] }}>
      <span className="scp-health__dot" aria-hidden="true" />
      {healthText(health)}
    </span>
  );
}
