"use client";
import { useState } from "react";
import { BRAIN_OPTIONS, type AssistantThread } from "@/lib/assistant";
import { setThreadBrainAction } from "@/lib/assistantActions";

// ASST-16 — the per-thread brain picker (blueprint Phase-2 gate). Reuses ASST-05's existing thread
// PATCH endpoint (no new route) via `setThreadBrainAction`. Picking a value sends it as
// ai-gateway-go's `provider` HINT on every subsequent generation in this thread (ASST-15) — never a
// hard requirement: a down/unavailable provider silently falls over to the chain (OQ-6), and the
// "served by" badge on each reply (`Message.tsx`, ASST-12) always names the ACTUAL server, which
// may legitimately differ from what's picked here. That divergence is deliberate, not a bug — this
// picker states intent, the badge states truth.
//
// Disabled while a generation is in flight: switching mid-stream would race the in-flight relay's
// already-captured `provider`/`providerSession` inputs (assistant.controller.ts's `stream()` reads
// `thread.brainProvider`/`hermesSessionId` once, at the moment `relayGeneration` is called) —
// nothing breaks, but the picker would silently apply to only the NEXT turn while looking like it
// changed the current one, which is confusing enough to just prevent.
export function BrainPicker({ thread, disabled, onChanged }: {
  thread: AssistantThread | null;
  disabled: boolean;
  onChanged: (patch: Partial<AssistantThread>) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!thread) return null;

  async function handleChange(raw: string) {
    const value = raw === "" ? null : raw;
    if (value === thread!.brainProvider) return;
    setSaving(true);
    setError(null);
    // Optimistic — mirrors ThreadRail's rename/pin/archive pattern. The backend clears
    // `hermesSessionId` server-side on an actual change (patchThread's header); reflect that here
    // too so the UI never shows a stale "resuming" session id for a brain that's no longer active.
    onChanged({ brainProvider: value, hermesSessionId: null });
    const r = await setThreadBrainAction(thread!.id, value);
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      onChanged({ brainProvider: thread!.brainProvider, hermesSessionId: thread!.hermesSessionId });
    }
  }

  return (
    <div className="asst-brain-picker">
      <label htmlFor="asst-brain-select" className="asst-brain-picker__label">Brain</label>
      <select
        id="asst-brain-select"
        className="asst-brain-picker__select"
        value={thread.brainProvider ?? ""}
        disabled={disabled || saving}
        onChange={(e) => void handleChange(e.target.value)}
      >
        {BRAIN_OPTIONS.map((o) => (
          <option key={o.value ?? "auto"} value={o.value ?? ""}>{o.label}</option>
        ))}
      </select>
      {error && <span className="asst-brain-picker__error" role="alert">{error}</span>}
    </div>
  );
}
