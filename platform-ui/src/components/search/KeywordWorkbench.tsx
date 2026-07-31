"use client";
// SM-12 — the Keywords tab's interactive half: import (CSV/paste), embed, cluster, and the
// resulting keyword table + cluster/intent summary for one already-selected keyword set. Set
// SELECTION and CREATION live in the server page (a plain GET-form + a tiny inline create action,
// matching this repo's `lux-filters` convention) — this component owns what happens INSIDE a set.
//
// `canManage` is a HINT, not the boundary — same rule `ScopeEditor.tsx` documents. Every write here
// (`importKeywords`/`embedKeywords`/`clusterKeywords` in searchMarketingActions.ts) re-checks
// `can(..., "search.manage", ...)` server-side, and Cerbos is the actual gate regardless.
//
// `volumeScopeEnabled` decides how the volume column renders (design §12 MUST HOLD: "per-keyword
// search VOLUME is a metered capability behind its own scope toggle... render its state rather than
// pretending it is free") — see `keywordVolumeState`'s header note in searchMarketingShared.ts for
// the three states this deliberately does NOT collapse into one.
//
// SM-38: the Volume/Difficulty columns below carry NO SIMULATED chip and NO vendor label, on
// purpose — `listKeywords`'s SELECT (search.controller.ts) has no `metrics_provider`/
// `metrics_simulated` columns to read. Those need migration 0048, owned by SM-36 (not started).
// This is the honest option here: no chip, no claim either way, rather than inventing a field that
// would read `undefined` (falsy) and silently render every simulated value as real — the exact
// failure direction this whole ticket exists to prevent. Once SM-36 lands, badge these two columns
// the same way ScopeEditor badges its per-tool cost cells.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import {
  groupKeywordsByCluster,
  keywordVolumeState,
  formatVolume,
  formatUsd,
  numberOrDash,
  type SearchKeyword,
} from "@/lib/searchMarketingShared";
import { importKeywords, embedKeywords, clusterKeywords } from "@/lib/searchMarketingActions";

export function KeywordWorkbench({
  tenantId, setId, keywords, volumeScopeEnabled, canManage,
}: {
  tenantId: string;
  setId: string;
  keywords: SearchKeyword[];
  volumeScopeEnabled: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [locale, setLocale] = useState("id-ID");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importPending, startImport] = useTransition();
  const [embedPending, startEmbed] = useTransition();
  const [clusterPending, startCluster] = useTransition();

  function runImport() {
    setError(null);
    setMessage(null);
    if (!text.trim()) {
      setError("Paste at least one keyword (CSV or one per line) first.");
      return;
    }
    startImport(async () => {
      const res = await importKeywords(tenantId, setId, text, locale);
      if (!res.ok) {
        // SM-32: the backend refuses an over-cap import with a 400 naming the limit — this is
        // exactly that message, surfaced verbatim, never swallowed.
        setError(res.error ?? "Import failed.");
        return;
      }
      setText("");
      setMessage(
        `Imported ${res.result?.imported ?? 0} of ${res.result?.submitted ?? 0} submitted` +
          (res.result?.duplicates ? ` (${res.result.duplicates} duplicate${res.result.duplicates === 1 ? "" : "s"} skipped)` : ""),
      );
      router.refresh();
    });
  }

  function runEmbed() {
    setError(null);
    setMessage(null);
    startEmbed(async () => {
      const res = await embedKeywords(tenantId, setId);
      if (!res.ok) {
        setError(res.error ?? "Embedding failed.");
        return;
      }
      setMessage(`Embedded ${res.result?.embedded ?? 0} keyword(s) (${res.result?.mode ?? "unknown"} mode).`);
      router.refresh();
    });
  }

  function runCluster() {
    setError(null);
    setMessage(null);
    startCluster(async () => {
      const res = await clusterKeywords(tenantId, setId);
      if (!res.ok) {
        setError(res.error ?? "Clustering failed.");
        return;
      }
      const skipped = res.result?.skipped ?? 0;
      setMessage(
        `Formed ${res.result?.clusters.length ?? 0} cluster(s)` +
          (skipped > 0 ? ` — ${skipped} keyword(s) skipped (embed them first).` : "."),
      );
      router.refresh();
    });
  }

  const clusters = groupKeywordsByCluster(keywords);

  return (
    <div>
      {canManage && (
        <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: "0.5px solid var(--erp-hairline)" }}>
          <label style={{ display: "block", font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)", marginBottom: 6 }}>
            Import keywords (CSV or one per line)
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={"seo tools\ncontent marketing, id-ID\n\"best, cheap\" seo tools"}
            style={{ width: "100%", font: "400 13px var(--font-body)", padding: "8px 10px", border: "0.5px solid var(--erp-hairline)", background: "transparent", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
              Locale
              <input
                value={locale} onChange={(e) => setLocale(e.target.value)}
                style={{ marginLeft: 8, width: 80, font: "400 13px var(--font-body)", padding: "4px 8px" }}
              />
            </label>
            <Button variant="solid" size="sm" onClick={runImport} disabled={importPending}>
              {importPending ? "Importing…" : "Import"}
            </Button>
            <Button variant="ghost" size="sm" onClick={runEmbed} disabled={embedPending || keywords.length === 0}>
              {embedPending ? "Embedding…" : "Embed keywords"}
            </Button>
            <Button variant="ghost" size="sm" onClick={runCluster} disabled={clusterPending || keywords.length === 0}>
              {clusterPending ? "Clustering…" : "Cluster keywords"}
            </Button>
          </div>
          <p style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 6 }}>
            Embed before cluster — clustering skips any keyword with no embedding yet and reports how
            many it skipped, rather than embedding them on the fly.
          </p>
          {error && <p role="alert" style={{ font: "400 13px var(--font-body)", color: "var(--erp-danger, var(--status-critical-fg))", marginTop: 8 }}>{error}</p>}
          {!error && message && <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ok, var(--status-ok-fg))", marginTop: 8 }}>{message}</p>}
        </div>
      )}

      {clusters.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ font: "700 12px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-60)", marginBottom: 8 }}>
            Clusters
          </h4>
          <HairlineTable
            columns={[{ label: "Cluster" }, { label: "Intent" }, { label: "Size", align: "right" }]}
            rows={clusters.map((c) => [c.clusterLabel, c.intent ? <StatusBadge key="i" label={c.intent} /> : "—", String(c.keywords.length)])}
            tcols="2fr 1fr .6fr"
          />
        </div>
      )}

      {keywords.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No keywords in this set yet. {canManage ? "Import some above to get started." : ""}
        </p>
      ) : (
        <div>
          <h4 style={{ font: "700 12px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-60)", marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
            Keywords ({keywords.length})
            <CostTierBadge tier="data_key" />
            <span style={{ textTransform: "none", letterSpacing: "normal", font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
              Volume is {volumeScopeEnabled ? "enabled" : "off"} for this engagement
            </span>
          </h4>
          <HairlineTable
            columns={[
              { label: "Keyword" }, { label: "Intent" }, { label: "Cluster" },
              { label: "Volume", align: "right" }, { label: "Difficulty", align: "right" }, { label: "CPC", align: "right" },
            ]}
            rows={keywords.map((k) => {
              const state = keywordVolumeState(volumeScopeEnabled, k.volume);
              const volumeCell =
                state === "disabled" ? (
                  <span key="v" title="The volume scope toggle is off for this engagement — enable it there to pull real numbers." style={{ opacity: 0.6 }}>
                    🔵 off
                  </span>
                ) : state === "unpulled" ? (
                  <span key="v" style={{ opacity: 0.6 }}>— (not pulled)</span>
                ) : (
                  <span key="v">{formatVolume(k.volume)}</span>
                );
              return [
                k.keyword,
                k.intent ? <StatusBadge key="i" label={k.intent} /> : "—",
                k.clusterLabel ?? "—",
                volumeCell,
                numberOrDash(k.difficulty),
                formatUsd(k.cpcUsd),
              ];
            })}
            tcols="1.6fr .9fr 1.2fr .9fr .8fr .8fr"
          />
        </div>
      )}
    </div>
  );
}
