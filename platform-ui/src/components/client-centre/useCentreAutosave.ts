"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildCentrePatch,
  draftFromProfile,
  type CentreDraft,
  type CentrePatch,
  type CentreProfile,
} from "@/lib/clientCentre";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface CentreActionResult {
  ok: boolean;
  error?: string;
  field?: string;
  profile?: CentreProfile;
}

const DEBOUNCE_MS = 600;
const SAVED_FLASH_MS = 1800;

/** The autosave loop CMC's `persistDebounced` describes: ~600ms after the last edit, diff the draft
 *  against the last-saved baseline (`buildCentrePatch` — only changed keys, deletes on blank) and
 *  PATCH it. A new edit before the timer fires resets it, so a burst of keystrokes sends ONE patch.
 *
 *  Does nothing (no timer, no patch) when `canEdit` is false — a read-only viewer's draft is a local
 *  scratchpad the tree/views may still show but never persists, matching "read-only when canEdit is
 *  false" rather than silently discarding a write the server would refuse anyway. */
export function useCentreAutosave(
  clientId: string,
  profile: CentreProfile,
  patchAction: (clientId: string, patch: CentrePatch) => Promise<CentreActionResult>,
) {
  const [draft, setDraft] = useState<CentreDraft>(() => draftFromProfile(profile));
  const baselineRef = useRef<CentreDraft>(draftFromProfile(profile));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A fresh navigation (new clientId/section) hands this hook a fresh `profile` — reset the whole
  // loop rather than diffing against a stale baseline from the previous client.
  useEffect(() => {
    setDraft(draftFromProfile(profile));
    baselineRef.current = draftFromProfile(profile);
    setSaveState("idle");
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on clientId; profile is the seed
  }, [clientId]);

  const flush = useCallback(
    async (current: CentreDraft) => {
      const patch = buildCentrePatch(baselineRef.current, current);
      if (!patch) return;
      setSaveState("saving");
      const result = await patchAction(clientId, patch);
      if (result.ok) {
        baselineRef.current = result.profile ? draftFromProfile(result.profile) : current;
        setSaveState("saved");
        if (flashRef.current) clearTimeout(flashRef.current);
        flashRef.current = setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), SAVED_FLASH_MS);
      } else {
        // Baseline is left untouched on failure: the offending keys stay in the next diff so a
        // retry (triggered by the caller editing again) re-sends them rather than silently dropping
        // the change the server just refused.
        setSaveState("error");
        setSaveError(result.error ?? "Save failed.");
      }
    },
    [clientId, patchAction],
  );

  const update = useCallback(
    (mutate: (d: CentreDraft) => CentreDraft, canEdit: boolean) => {
      setDraft((prev) => {
        const next = mutate(prev);
        if (canEdit) {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => void flush(next), DEBOUNCE_MS);
        }
        return next;
      });
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (flashRef.current) clearTimeout(flashRef.current);
    },
    [],
  );

  return { draft, update, saveState, saveError };
}
