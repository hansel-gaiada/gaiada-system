"use client";
// SM-29 — the editable per-tool scope-config surface. Replaces the engagement detail page's
// read-only "Metered tools" table + disabled "Edit scope (coming in SM-29)" affordance with a
// real editor: enable/cadence/limit per metered tool, a preset picker that seeds the grid, a
// live per-toggle + total projected monthly cost (priced by the backend's own what-if
// `cost-projection`, never re-estimated here — design §05), and the provider-budget cap.
//
// D-11 non-negotiable: an ABSENT toggle and `enabled: false` must render and BEHAVE identically —
// this component never invents a `true` default, and `patchToolScope` only ever writes the field
// the human touched.
//
// `canWrite` is a HINT, not the boundary: Cerbos enforces `search:scope:write` server-side
// (`saveEngagementScope` re-checks with `can()` too, and the PUT itself is gated by the `set_scope`
// Cerbos action regardless). When `canWrite` is false every control renders disabled and the Save
// button never mounts — a non-privileged viewer gets the same information, just inert.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import { SimulatedBadge, ProviderLabel } from "@/components/search/SimulatedBadge";
// From the CLIENT-SAFE shared module, never from lib/searchMarketing.ts directly — that file
// imports lib/platform.ts ("server-only") and would fail the build the moment this component
// pulled in even one constant from it. See searchMarketingShared.ts's header note.
import {
  CAPABILITY_TOGGLE,
  SCOPE_PRESET_SEEDS,
  TOGGLE_LIMIT_FIELD,
  anyEnabledToolSimulated,
  formatUsd,
  isToggleEnabled,
  isProjectionOverBudget,
  patchToolScope,
  toggleLimit,
  type ToolScopeConfig,
  type ToolScopeToggle,
  type CostProjection,
  type ScopePreset,
} from "@/lib/searchMarketingShared";
// "use server" exports compile to a callable RPC stub in the client bundle (Next.js strips the
// real implementation, which is what actually touches lib/platform.ts) — importing them directly
// here is safe and matches this repo's existing convention (e.g. components/pm/DocEditor.tsx,
// components/meetings/RecordControls.tsx both import straight from their *Actions.ts module).
import { previewScopeProjection, saveEngagementScope } from "@/lib/searchMarketingActions";

const CADENCE_OPTIONS = ["", "daily", "weekly", "monthly"] as const;
const PRESET_OPTIONS: { value: ScopePreset; label: string }[] = [
  { value: "light", label: "Light — $0 crawlers/AI only" },
  { value: "standard", label: "Standard — weekly rank + AI visibility" },
  { value: "heavy", label: "Heavy — daily rank + backlinks" },
  { value: "custom", label: "Custom — hand-tuned" },
];

export function ScopeEditor({
  tenantId, engagementId, canWrite,
  initialScopePreset, initialToolScope, initialProviderBudgetUsd, initialProjection,
}: {
  tenantId: string;
  engagementId: string;
  canWrite: boolean;
  initialScopePreset: string | null;
  initialToolScope: ToolScopeConfig;
  initialProviderBudgetUsd: number | null;
  initialProjection: CostProjection | null;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<ToolScopeConfig>(initialToolScope);
  // null means "never explicitly set" (legacy/never-preset engagement) — the picker shows it as
  // 'custom' but this stays null until the human actually chooses a preset, so a save that only
  // touches the budget doesn't invent a preset label that was never true.
  const [preset, setPreset] = useState<ScopePreset | null>((initialScopePreset as ScopePreset) ?? null);
  const [budget, setBudget] = useState<number>(initialProviderBudgetUsd ?? 10);
  const [preview, setPreview] = useState<CostProjection | null>(initialProjection);
  const [previewPending, startPreview] = useTransition();
  const [savePending, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    JSON.stringify(scope) !== JSON.stringify(initialToolScope) ||
    preset !== ((initialScopePreset as ScopePreset) ?? null) ||
    budget !== (initialProviderBudgetUsd ?? 10);

  function preview_(nextScope: ToolScopeConfig) {
    startPreview(async () => {
      const res = await previewScopeProjection(tenantId, engagementId, nextScope);
      if (res.ok) setPreview(res.projection ?? null);
      // A failed preview leaves the last-known projection in place rather than blanking it —
      // losing the whole grid's cost column over one flaky preview call would be a worse failure
      // mode than a momentarily-stale number.
    });
  }

  function editTool(tool: string, patch: Partial<ToolScopeToggle>) {
    const next = patchToolScope(scope, tool, patch);
    setScope(next);
    setPreset("custom"); // any hand edit un-seeds whatever preset was picked (design §04)
    preview_(next);
  }

  function pickPreset(value: ScopePreset) {
    setPreset(value);
    if (value === "custom") {
      // 'custom' leaves tool_scope exactly as-is — nothing to seed, nothing to preview-refresh.
      return;
    }
    const seeded = SCOPE_PRESET_SEEDS[value];
    setScope(seeded);
    preview_(seeded);
  }

  function save() {
    setError(null);
    const payload =
      preset === "light" || preset === "standard" || preset === "heavy"
        ? { scopePreset: preset }
        : { scopePreset: "custom", toolScope: scope };
    const withBudget = budget !== (initialProviderBudgetUsd ?? 10) ? { ...payload, providerBudgetUsd: budget } : payload;
    startSave(async () => {
      const res = await saveEngagementScope(tenantId, engagementId, withBudget);
      if (!res.ok) {
        setError(res.error ?? "Couldn't save the scope.");
        return;
      }
      if (res.scope) {
        setScope(res.scope.toolScope);
        setPreset((res.scope.scopePreset as ScopePreset) ?? null);
        setBudget(res.scope.providerBudgetUsd ?? 10);
      }
      if (res.projection !== undefined) setPreview(res.projection);
      setSavedAt(Date.now());
      router.refresh(); // re-renders the parent server page's header/KPI/stop-loss banner
    });
  }

  const perToolByToggle = new Map((preview?.perTool ?? []).map((row) => [row.tool, row]));
  const overBudgetNow = preview ? isProjectionOverBudget(preview.totalMonthlyUsd, budget) : false;

  return (
    <div>
      <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginBottom: 12 }}>
        A capability whose toggle is off is <strong>refused at dispatch</strong> naming that toggle —
        an absent toggle counts as off, exactly the same as an explicit <code>enabled: false</code>.
        {canWrite
          ? " Edit a row below, or seed the whole grid from a preset; nothing is billed until you Save."
          : " Editing this grid needs the elevated search.scope.write permission."}
      </p>

      {/* Preset picker — seeds the grid locally for preview; Save is what actually persists it. */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Preset
          <select
            value={preset ?? "custom"}
            disabled={!canWrite}
            onChange={(e) => pickPreset(e.target.value as ScopePreset)}
            style={{ marginLeft: 8, font: "400 13px var(--font-body)", padding: "4px 8px" }}
          >
            {PRESET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Provider budget/mo
          <input
            type="number" min={0.01} step="0.01" value={budget} disabled={!canWrite}
            onChange={(e) => setBudget(Number(e.target.value))}
            style={{ marginLeft: 8, width: 100, font: "400 13px var(--font-body)", padding: "4px 8px" }}
          />
        </label>
        {previewPending && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>pricing…</span>}
      </div>

      <HairlineTable
        columns={[
          { label: "Capability" },
          { label: "Enabled" },
          { label: "Cadence" },
          { label: "Limit" },
          { label: "Projected monthly cost", align: "right" },
        ]}
        rows={Object.entries(CAPABILITY_TOGGLE).map(([capability, tool]) => {
          const entry = scope[tool];
          const enabled = isToggleEnabled(scope, tool);
          const limitField = TOGGLE_LIMIT_FIELD[tool];
          const limit = toggleLimit(entry, tool);
          const projected = perToolByToggle.get(tool);
          return [
            <span key="cap" style={{ opacity: enabled ? 1 : 0.5 }}>{capability.replace(/_/g, " ")}</span>,
            <input
              key="en" type="checkbox" checked={enabled} disabled={!canWrite}
              onChange={(e) => editTool(tool, { enabled: e.target.checked })}
            />,
            <select
              key="cad" value={entry?.cadence ?? ""} disabled={!canWrite}
              onChange={(e) => editTool(tool, { cadence: e.target.value || null })}
              style={{ font: "400 13px var(--font-body)", padding: "3px 6px" }}
            >
              {CADENCE_OPTIONS.map((c) => (
                <option key={c || "none"} value={c}>{c || "on-demand"}</option>
              ))}
            </select>,
            limitField ? (
              <input
                key="lim" type="number" min={1} disabled={!canWrite}
                value={limit ?? ""}
                placeholder="default"
                onChange={(e) => {
                  const n = e.target.value === "" ? undefined : Number(e.target.value);
                  editTool(tool, { [limitField]: n } as Partial<ToolScopeToggle>);
                }}
                style={{ width: 80, font: "400 13px var(--font-body)", padding: "3px 6px" }}
              />
            ) : (
              <span key="lim" style={{ opacity: 0.5 }}>—</span>
            ),
            <span key="cost" style={{ opacity: enabled ? 1 : 0.5 }}>
              {projected ? formatUsd(projected.projectedMonthlyUsd) : "—"}
              {/* SM-38: badge + vendor label ride the SAME row the price came from — only when the
                  toggle is actually enabled, since a disabled row's $0 is not a number a provider
                  sourced at all (see anyEnabledToolSimulated's header note). */}
              {projected && enabled && <ProviderLabel provider={projected.provider} />}
              {projected && enabled && projected.simulated && <SimulatedBadge />}
            </span>,
          ];
        })}
        tcols="1.3fr .7fr 1fr .8fr 1.2fr"
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
        <span style={{ font: "600 13px var(--font-body)", color: "var(--text-primary)" }}>
          Preview total: {preview ? formatUsd(preview.totalMonthlyUsd) : "—"}/mo
          {/* A total derived from simulated inputs is itself simulated (SM-38 AC: "aggregates
              count") — badged once here rather than assumed from the per-row chips above. */}
          {preview && anyEnabledToolSimulated(preview.perTool) && <SimulatedBadge />}
          {!preview && (
            <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", marginLeft: 8 }}>
              (cost-projection did not answer)
            </span>
          )}
        </span>
        {canWrite && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, #B5622F)" }}>{error}</span>}
            {!error && savedAt && !dirty && (
              <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ok, #3a7a54)" }}>Saved</span>
            )}
            <Button variant="solid" size="sm" onClick={save} disabled={!dirty || savePending}>
              {savePending ? "Saving…" : "Save scope"}
            </Button>
          </div>
        )}
      </div>

      {overBudgetNow && (
        <div
          role="alert"
          style={{
            border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--erp-danger, #B5622F)",
            background: "rgba(181,98,47,.06)", padding: "12px 14px", marginTop: 16,
            font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)",
          }}
        >
          <strong style={{ color: "var(--erp-danger, #B5622F)" }}>Over budget:</strong> this configuration is
          projected to exceed the {formatUsd(budget)}/mo cap. Pulls will be refused by the stop-loss once
          the cap is reached this period, even for toggles that are switched on.{" "}
          {dirty && <StatusBadge label="unsaved" />}
        </div>
      )}
    </div>
  );
}
