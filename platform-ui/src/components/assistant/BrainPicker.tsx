"use client";
import { useEffect, useState } from "react";
import { BRAIN_OPTIONS, BRAIN_TIER_CHOICES, brainOptionLabel, brainTierLabel, type AssistantThread, type BrainTier } from "@/lib/assistant";
import { refreshBrainsAction, setThreadBrainAction, type BrainChoiceBody } from "@/lib/assistantActions";

// ASST-16 — the per-thread brain picker (blueprint Phase-2 gate). Reuses ASST-05's existing thread
// PATCH endpoint (no new route) via `setThreadBrainAction`. Picking a value sends it as
// ai-gateway-go's `provider` HINT on every subsequent generation in this thread (ASST-15) — never a
// hard requirement: a down/unavailable provider silently falls over to the chain (OQ-6), and the
// "served by" badge on each reply (`Message.tsx`, ASST-12) always names the ACTUAL server, which
// may legitimately differ from what's picked here. That divergence is deliberate, not a bug — this
// picker states intent, the badge states truth.
//
// AIP-00c: only brains the gateway reports as available are offered (`GET :t/assistant/brains`), plus
// Auto. When that list cannot be read (`null` / failed fetch) only Auto is offered, with a muted line.
// A thread's stored value that is not offered is still shown as the current choice, labelled
// "<label> (unavailable)", so a stored value is never silently hidden.
//
// AIP-08a: the options are Auto, Fast and Strong (each only when the gateway reports that tier in `tiers`), then the named
// providers as above. A thread stores a tier OR a provider, never both. Standard is not offered (Auto already means the gateway's
// default for the task, which is `standard`), but a stored `standard` is shown as the current choice. Select values are prefixed
// (`tier:fast`, `provider:openai`) so a tier and a provider name can never collide; Auto is "".
//
// Disabled while a generation is in flight: switching mid-stream would race the in-flight relay's
// already-captured `provider`/`providerSession` inputs (assistant.controller.ts's `stream()` reads
// `thread.brainProvider`/`hermesSessionId` once, at the moment `relayGeneration` is called) —
// nothing breaks, but the picker would silently apply to only the NEXT turn while looking like it
// changed the current one, which is confusing enough to just prevent.
const tierValue = (t: BrainTier) => `tier:${t}`;
const providerValue = (p: string) => `provider:${p}`;

export function BrainPicker({ thread, disabled, onChanged }: {
  thread: AssistantThread | null;
  disabled: boolean;
  onChanged: (patch: Partial<AssistantThread>) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `undefined` = not loaded yet; `null` = unknown (a failed or unreadable check); a Set = the available values.
  const [available, setAvailable] = useState<Set<string> | null | undefined>(undefined);
  const [tiers, setTiers] = useState<Set<string> | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await refreshBrainsAction();
        if (!alive) return;
        setAvailable(r && r.ok && Array.isArray(r.brains)
          ? new Set(r.brains.filter((b) => b.available).map((b) => b.value))
          : null);
        setTiers(r && r.ok && Array.isArray(r.tiers) ? new Set(r.tiers) : null);
      } catch {
        if (alive) { setAvailable(null); setTiers(null); }
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!thread) return null;

  // While the list is loading, the stored choice keeps its plain label: it is not yet known to be unavailable.
  const loading = available === undefined;
  const stored = thread.brainProvider;
  const storedTier = thread.brainTier ?? null;
  const offeredTiers = BRAIN_TIER_CHOICES.filter((t) => (tiers instanceof Set && tiers.has(t)) || (loading && t === storedTier));
  const offered = BRAIN_OPTIONS.filter((o) => o.value === null || (available instanceof Set && available.has(o.value)) || (loading && o.value === stored));
  const storedHidden = !loading && stored !== null && !offered.some((o) => o.value === stored);
  // A stored tier that is not offered (Standard, or one the gateway no longer reports) is still the current choice.
  const storedTierHidden = storedTier !== null && !offeredTiers.includes(storedTier);
  const storedTierUnavailable = !loading && storedTierHidden && !(tiers instanceof Set && tiers.has(storedTier));
  const current = storedTier !== null ? tierValue(storedTier) : stored !== null ? providerValue(stored) : "";

  async function handleChange(raw: string) {
    if (raw === current) return;
    const t = thread!;
    let body: BrainChoiceBody;
    let optimistic: Partial<AssistantThread>;
    // The platform clears `hermesSessionId` server-side when the stored provider is left or changed (patchThread's ASST-16 rule);
    // reflect that here too so the UI never shows a stale "resuming" session id for a brain that's no longer active.
    if (raw.startsWith("tier:")) {
      const tier = raw.slice(5) as BrainTier;
      body = { brainTier: tier };
      optimistic = { brainTier: tier, brainProvider: null, hermesSessionId: t.brainProvider !== null ? null : t.hermesSessionId };
    } else if (raw.startsWith("provider:")) {
      const provider = raw.slice(9);
      body = { brainProvider: provider };
      optimistic = { brainProvider: provider, brainTier: null, hermesSessionId: null };
    } else {
      body = { brainProvider: null, brainTier: null };
      optimistic = { brainProvider: null, brainTier: null, hermesSessionId: t.brainProvider !== null ? null : t.hermesSessionId };
    }
    setSaving(true);
    setError(null);
    // Optimistic — mirrors ThreadRail's rename/pin/archive pattern.
    onChanged(optimistic);
    const r = await setThreadBrainAction(t.id, body);
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      onChanged({ brainProvider: t.brainProvider, brainTier: t.brainTier ?? null, hermesSessionId: t.hermesSessionId });
    }
  }

  const autoOption = offered.find((o) => o.value === null)!;
  const providerOptions = offered.filter((o) => o.value !== null);
  return (
    <div className="asst-brain-picker">
      <label htmlFor="asst-brain-select" className="asst-brain-picker__label">Brain</label>
      <select
        id="asst-brain-select"
        className="asst-brain-picker__select"
        aria-describedby="asst-brain-help"
        value={current}
        disabled={disabled || saving}
        onChange={(e) => void handleChange(e.target.value)}
      >
        <option value="">{autoOption.label}</option>
        {offeredTiers.map((t) => (
          <option key={t} value={tierValue(t)}>{brainTierLabel(t)}</option>
        ))}
        {storedTierHidden && <option value={tierValue(storedTier!)}>{brainTierLabel(storedTier!)}{storedTierUnavailable ? " (unavailable)" : ""}</option>}
        {providerOptions.map((o) => (
          <option key={o.value!} value={providerValue(o.value!)}>{o.label}</option>
        ))}
        {storedHidden && <option value={providerValue(stored!)}>{brainOptionLabel(stored)} (unavailable)</option>}
      </select>
      <span id="asst-brain-help" className="asst-brain-picker__note asst-brain-picker__help">Fast is quicker and cheaper; Strong is for harder questions.</span>
      {available === null && <span className="asst-brain-picker__note">Other brains can&apos;t be checked right now.</span>}
      {error && <span className="asst-brain-picker__error" role="alert">{error}</span>}
    </div>
  );
}
