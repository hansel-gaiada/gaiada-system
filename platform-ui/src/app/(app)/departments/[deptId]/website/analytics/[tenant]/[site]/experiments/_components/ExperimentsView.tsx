import Link from "next/link";
import { Card } from "@/components/ui";
import { goalWords, STATUS_WORDS, type Experiment } from "@/lib/experimentsModel";
import "@/components/webdesk/content/content.css";
import "@/components/webdesk/analytics/analytics.css";
import "@/components/webdesk/analytics/aiVisibility.css";
import { RegisterForm } from "./RegisterForm";

export interface ExperimentsViewProps {
  siteName: string;
  analyticsHref: string;
  hrefBase: string;
  propertyId: string;
  tenantSlug: string;
  siteId: string;
  canUpdate: boolean;
  /** In the server's order (newest first). Never re-sorted here. */
  experiments: Experiment[];
}

export function ExperimentsView({ siteName, analyticsHref, hrefBase, propertyId, tenantSlug, siteId, canUpdate, experiments }: ExperimentsViewProps) {
  return (
    <div className="wa-page" data-testid="experiments">
      <p className="wc-lede">
        Tests that show visitors of {siteName} different versions of a section, to see which gets more of a goal.
        Results stay hidden until a test has seen enough visitors, so nobody can stop it early on a lucky number.{" "}
        <Link href={analyticsHref}>Back to visitor analytics</Link>.
      </p>
      <Card title="Tests">
        {experiments.length === 0 ? (
          <p className="wa-note" data-testid="exp-empty">No tests registered for this site yet.</p>
        ) : (
          <table className="wa-table" data-testid="exp-list">
            <thead><tr><th>Test</th><th>Status</th><th>Goal</th><th className="wa-num">Needs per variant</th><th className="wa-num">About (days)</th></tr></thead>
            <tbody>{experiments.map((e) => (
              <tr key={e.id} data-testid={`exp-row-${e.key}`}>
                <td><Link href={`${hrefBase}/${encodeURIComponent(e.id)}`}>{e.key}</Link><div className="wa-foot">{e.hypothesis}</div></td>
                <td>{STATUS_WORDS[e.status]}</td>
                <td>{goalWords(e.goal.event)}</td>
                <td className="wa-num">{e.preRegistration.nPerArm}</td>
                <td className="wa-num">{e.preRegistration.projectedDays}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <RegisterForm propertyId={propertyId} tenantSlug={tenantSlug} siteId={siteId} allowed={canUpdate} />
    </div>
  );
}
