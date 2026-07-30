import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import type { ChainReport } from "@/lib/admin";
import "./systems.css";

// The failover chain in ORDER, with each provider's live circuit-breaker state. The order is the
// whole contract of a chain (first healthy provider wins), so the position is rendered explicitly
// rather than implied by row order alone.
//
// A provider can be absent from the live report while present in the configured order — an unknown
// name in the env, or a cloud provider dropped by "site" topology. That gap is shown, not hidden:
// silently rendering the configured order would tell the operator a provider is in the chain when
// the gateway never built it.
export function ChainTable({ title, chain, note }: { title: string; chain?: ChainReport; note?: string }) {
  const providers = chain?.providers ?? [];
  const order = chain?.order ?? [];
  const built = new Set(providers.map((p) => p.name));
  const missing = order.filter((n) => !built.has(n));

  return (
    <Card title={title}>
      {providers.length === 0 ? (
        <EmptyNote>
          {order.length > 0
            ? `Configured as ${order.join(" → ")}, but the gateway reported no built providers.`
            : "Chain appears once the gateway admin API is reachable."}
        </EmptyNote>
      ) : (
        <HairlineTable
          columns={[{ label: "#" }, { label: "Provider" }, { label: "State" }, { label: "Detail" }]}
          rows={providers.map((p) => [
            String(p.position),
            p.name,
            <StatusBadge key={`s-${p.name}`} label={p.state} />,
            breakerDetail(p.state, p.consecutiveFails, p.rateLimited, p.openUntil, p.available),
          ])}
        />
      )}
      {missing.length > 0 && (
        <p className="sys-empty-note" style={{ marginTop: 12 }}>
          Configured but not built by the gateway: {missing.join(", ")} — an unknown provider name, or excluded by
          site topology.
        </p>
      )}
      {note && (
        <p className="sys-empty-note" style={{ marginTop: 12 }}>
          {note}
        </p>
      )}
    </Card>
  );
}

/** Human explanation of WHY a provider is in its current state — the operator's actual question. */
function breakerDetail(
  state: string,
  consecutiveFails?: number,
  rateLimited?: boolean,
  openUntil?: string,
  available?: boolean,
): string {
  if (state === "unconfigured") return "No credential/endpoint configured — skipped";
  if (state === "open") {
    const until = openUntil ? ` until ${new Date(openUntil).toLocaleTimeString()}` : "";
    return rateLimited
      ? `Rate limited upstream — breaker open${until}`
      : `Breaker tripped by consecutive failures — open${until}`;
  }
  if (!available) return "Reported unavailable";
  return consecutiveFails ? `Healthy (${consecutiveFails} recent failure${consecutiveFails === 1 ? "" : "s"})` : "Healthy";
}
