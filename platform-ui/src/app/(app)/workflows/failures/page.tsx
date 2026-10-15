import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listFailuresResult, FAILURES_WINDOWS, type FailedRun } from "@/lib/automationFailures";
import { parseWindow, WINDOW_LABEL } from "@/lib/itSecurityView";
import { formatTimestamp } from "@/lib/format";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { WindowChoice } from "@/components/it/WindowChoice";
import "@/components/it/network.css";

export const metadata = { title: "Failing workflows" };
export const dynamic = "force-dynamic";

// DW-7i-1 (BFF §52.12, DW-D37): the failed runs of the shared n8n, for the owner, the GM, the PM and the platform operator. The
// server decides who may read (a refused read is a 403), the page only says it in words.
//
// ⚠ THREE STATES, NEVER TWO. `on` (n8n answered), `not_configured` (the automation service has no URL or key) and `unavailable` (n8n
// did not answer, or answered something that is not a list of runs). The last two carry no figures: a "0 failed runs" over a service
// that was not read would read as an all-clear, which is the one thing this page must not say.
const AUDIENCE = "This page is for the owner, the GM, the PM and the platform operator.";
const MODE_LABEL: Record<string, string> = { trigger: "Trigger", webhook: "Webhook", manual: "Manual", retry: "Retry", cli: "CLI", error: "Error workflow", integrated: "Sub-workflow" };
type SearchParams = Promise<{ window?: string | string[] }>;

/** A run's workflow, opened in the n8n editor when the platform knows its public address. */
function workflowCell(run: FailedRun, editorUrl: string | undefined) {
  if (!editorUrl) return run.workflowName;
  return (
    <a key={run.executionId} href={`${editorUrl.replace(/\/$/, "")}/workflow/${encodeURIComponent(run.workflowId)}`} target="_blank" rel="noreferrer">
      {run.workflowName}
    </a>
  );
}

export default async function FailingWorkflowsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const win = parseWindow((await searchParams).window, FAILURES_WINDOWS, "24h");
  const result = await listFailuresResult(userId, tenant, win);
  if (result.kind === "forbidden") return <ReadRefusal subject="the failing workflows" kind="forbidden" detail={AUDIENCE} />;
  if (result.kind === "unavailable") {
    return (
      <ReadRefusal
        subject="The failing workflows"
        kind="unavailable"
        reason={result.reason}
        detail="An empty list would say nothing failed; that cannot be said while the runs are unreadable."
      />
    );
  }

  const a = result.data;
  const choice = <WindowChoice base="/workflows/failures" options={FAILURES_WINDOWS} current={win} />;

  if (a.state !== "on") {
    return (
      <>
        {choice}
        <Card title={a.state === "not_configured" ? "Automation is not set up" : "Automation cannot be read"}>
          <div className="nw-banner nw-banner--warn" role="note" style={{ marginBottom: 0 }}>
            <span className="nw-banner__label">{a.state === "not_configured" ? "Not configured" : "Cannot be read"}</span>
            <span className="nw-banner__text">
              {a.reason}. Zero failed workflows is a claim; it cannot be made while the runs cannot be read.
            </span>
          </div>
        </Card>
      </>
    );
  }

  const runs = [...a.failed].sort((x, y) => y.startedAt.localeCompare(x.startedAt));
  const atLeast = a.capped;

  return (
    <>
      {choice}

      {atLeast ? (
        <div className="nw-banner nw-banner--warn" role="note">
          <span className="nw-banner__label">More than shown</span>
          <span className="nw-banner__text">{a.reason ?? "The window holds more failed runs than could be read, so the count is a lower bound."}</span>
        </div>
      ) : null}

      <div className="nw-kpis">
        <KpiTile
          label="Failed runs"
          value={atLeast ? `At least ${a.count}` : String(a.count)}
          foot={WINDOW_LABEL[win]}
          hint="Runs of the shared n8n that ended in an error. n8n serves the whole group, so these are not tied to this company."
        />
      </div>

      <Card title="Failed runs" hint="Newest first. Each workflow opens in n8n where its public address is known.">
        {runs.length === 0 ? (
          <EmptyNote>
            No failed runs in this window ({WINDOW_LABEL[win].toLowerCase()}), as of {formatTimestamp(a.asOf)}. n8n answered, so this is a real zero.
          </EmptyNote>
        ) : (
          <>
            <HairlineTable
              columns={[{ label: "Workflow" }, { label: "Started" }, { label: "Stopped" }, { label: "Mode" }]}
              tcols="2fr 1.2fr 1.2fr 0.8fr"
              rows={runs.map((r) => [
                workflowCell(r, a.editorUrl),
                formatTimestamp(r.startedAt),
                r.stoppedAt ? formatTimestamp(r.stoppedAt) : "—",
                r.mode ? (MODE_LABEL[r.mode] ?? r.mode) : "—",
              ])}
            />
            {a.count > runs.length ? (
              <p className="nw-more">Showing the newest {runs.length} of {atLeast ? "at least " : ""}{a.count} failed runs.</p>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
