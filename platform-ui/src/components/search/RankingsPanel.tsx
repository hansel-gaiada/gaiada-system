"use client";
// SM-14's UI build — the Rankings console tab (tracker §6af: "a Rankings UI page remains unclaimed",
// discharged here). Backend landed weeks earlier; this is the first console surface to read
// `search_rank_snapshots`. Field names verified against `search.controller.ts`'s `listRankSnapshots`
// SELECT + `pullRanks` response construction (§4i discipline — never a fixture, never a guess).
//
// Three provenance states this panel must never collapse into two: a REAL captured position, a
// SIMULATED one (badge, same as every other provider-sourced figure in this module), and NOT YET
// PULLED (a keyword with no snapshot at all — "—", never "0" and never indistinguishable from a
// real not-found result). `position: null` is itself a fourth, honest fact ("not found in that
// SERP capture") that must render distinctly from "not pulled" — see `positionCell` below.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable } from "@/components/ui";
import { SimulatedBadge, ProviderLabel } from "@/components/search/SimulatedBadge";
import { PaidActionGate } from "@/components/search/PaidActionGate";
import { annotateRankDrops, formatPosition, type RankSnapshot, type CostProjectionTool, type ProviderMode } from "@/lib/searchMarketingShared";
import { pullRanks } from "@/lib/searchMarketingActions";

function positionCell(position: number | null) {
  if (position === null) {
    return <span title="Tracked property genuinely not found in this SERP capture — an honest outcome, never an error.">— (not found)</span>;
  }
  return <span>{formatPosition(position)}</span>;
}

export function RankingsPanel({
  tenantId, engagementId, snapshots, canManage, costProjectionTool, providerMode, overBudget,
}: {
  tenantId: string;
  engagementId: string;
  snapshots: RankSnapshot[];
  canManage: boolean;
  /** SM-19 — the "rank" row from `GET .../cost-projection`, so "Pull ranks now" discloses its
   *  resolved provider/cost/mode/budget-projection before the operator commits. `undefined` when
   *  the projection endpoint never answered (degrades to PaidActionGate's own honest "unknown"
   *  state, never a fabricated $0/real guess). */
  costProjectionTool?: CostProjectionTool | null;
  providerMode?: ProviderMode | null;
  overBudget?: boolean;
}) {
  const router = useRouter();
  const [pending, startPull] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function runPull() {
    setError(null);
    setMessage(null);
    startPull(async () => {
      const res = await pullRanks(tenantId, engagementId);
      if (!res.ok) {
        setError(res.error ?? "Rank pull failed.");
        return;
      }
      const r = res.result!;
      if (r.attempted === 0) {
        setMessage("No tracked keywords under this engagement yet — mark a keyword \"tracked\" from the Keywords tab first.");
      } else {
        setMessage(
          `Pulled ${r.pulled} of ${r.attempted} tracked keyword(s)` +
            (r.skipped > 0 ? ` — ${r.skipped} skipped (budget/scope/pillar refusal)` : "") +
            (r.failed > 0 ? ` — ${r.failed} failed` : "") + ".",
        );
      }
      router.refresh();
    });
  }

  const decorated = annotateRankDrops(snapshots).sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  const trackedKeywordCount = new Set(snapshots.map((s) => s.keywordId)).size;

  return (
    <div>
      {canManage && (
        <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: "0.5px solid var(--erp-hairline)", display: "flex", flexDirection: "column", gap: 10 }}>
          <PaidActionGate
            tool="rank"
            projection={costProjectionTool}
            providerMode={providerMode ?? null}
            overBudget={overBudget ?? false}
            triggerLabel={pending ? "Pulling…" : "Pull ranks now"}
            confirmLabel="Confirm — pull ranks"
            disabled={pending}
            helpText={'Pulls every keyword marked "tracked" under this engagement — a metered provider call, counted against this engagement’s budget.'}
            onConfirm={runPull}
          />
          {error && <p role="alert" style={{ font: "400 13px var(--font-body)", color: "var(--erp-danger, #B5622F)", margin: 0, width: "100%" }}>{error}</p>}
          {!error && message && <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ok, #3a7a54)", margin: 0, width: "100%" }}>{message}</p>}
        </div>
      )}

      {snapshots.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No rank captures yet for this engagement&apos;s property. {canManage ? "Pull ranks above once a keyword is marked tracked." : "Ask someone with search.manage to pull ranks."}
        </p>
      ) : (
        <>
          <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", marginBottom: 8 }}>
            {trackedKeywordCount} keyword{trackedKeywordCount === 1 ? "" : "s"} with capture history — every row keeps its own provenance across a mode flip (badge, not filter).
          </p>
          <div style={{ overflowX: "auto" }}>
            <HairlineTable
              tcols="1.4fr 90px 90px 150px 90px 1fr 100px"
              columns={[
                { label: "Keyword" }, { label: "Engine" }, { label: "Device" },
                { label: "Captured" }, { label: "Position", align: "right" },
                { label: "Ranked URL" }, { label: "" },
              ]}
              rows={decorated.map((s) => [
                s.keyword,
                s.engine,
                s.device,
                new Date(s.capturedAt).toLocaleString(),
                <span key="pos" style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", justifyContent: "flex-end", width: "100%" }}>
                  {positionCell(s.position)}
                  {s.simulated && <SimulatedBadge />}
                  <ProviderLabel provider={s.provider} />
                </span>,
                s.rankedUrl ? (
                  <a key="url" href={s.rankedUrl} target="_blank" rel="noreferrer" style={{ font: "400 12px var(--font-body)", color: "var(--text-primary)" }}>
                    {s.rankedUrl.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  "—"
                ),
                s.dropped ? (
                  <span
                    key="drop"
                    title={`Regressed from position ${s.previousPosition ?? "?"} in the immediately-prior capture.`}
                    style={{ font: "600 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-danger, #B5622F)" }}
                  >
                    ▼ dropped
                  </span>
                ) : (
                  ""
                ),
              ])}
            />
          </div>
        </>
      )}
    </div>
  );
}
