import { LineChart } from "@/components/LineChart";
import { Eyebrow } from "@/components/ui";
import "./dashboard.css";

// Command Center's demoted chart (UX-2 §1.2: "a demoted sparkline keeps
// glance value without leading" — the queue is the hero now, not this).
// Thin extraction of the existing LineChart + weeklyThroughput usage that
// used to anchor the old personal-dashboard "Your throughput" Card.
export function ThroughputSparkline({ series }: { series: number[] }) {
  return (
    <div className="throughput-sparkline">
      <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>Throughput · last 8 weeks</Eyebrow>
      <LineChart series={series} height={56} />
    </div>
  );
}
