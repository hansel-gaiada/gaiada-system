"use client";
// SMM-11 — edits ONE existing per-network variant's body/first-comment/settings, renders its
// validation result inline (errors block, warnings never do — ValidationList.tsx's own contract),
// and offers delete. Does NOT offer media attach/upload — that is SMM-20's job ("Asset attach
// only", still unbuilt per the addendum's own ticket table); an existing variant's attached media
// is shown read-only here.
//
// Refusal tokens the update/delete calls can answer with (`variant_native_import_immutable`,
// `variant_not_editable`, `variant_is_live`) are rendered via `describeRefusal`, never re-worded
// inline — same "the token is the contract" rule the validation issues follow.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui";
import { updateVariant, deleteVariant } from "@/lib/socialActions";
import { describeRefusal, type SocialPostVariant } from "@/lib/socialShared";
import { ValidationList } from "./ValidationList";

export function VariantCard({
  tenantId, variant, canDelete,
}: {
  tenantId: string;
  variant: SocialPostVariant;
  /** `social.post.delete` — Cerbos denies module_staff this action even though staff hold
   *  `social.manage` (create/update). UI hint only; the backend re-checks regardless. */
  canDelete: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState(variant.body);
  const [firstComment, setFirstComment] = useState(variant.firstComment ?? "");
  const [settingsText, setSettingsText] = useState(JSON.stringify(variant.settings ?? {}, null, 2));
  const [validation, setValidation] = useState(variant.validation);
  const [approvalInvalidated, setApprovalInvalidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const locked = variant.nativeImport || !["draft", "in_review", "approved"].includes(variant.status);

  function save() {
    setError(null);
    let settings: Record<string, unknown>;
    try {
      settings = settingsText.trim() ? JSON.parse(settingsText) : {};
    } catch {
      setError("Settings must be valid JSON.");
      return;
    }
    startTransition(async () => {
      const res = await updateVariant(tenantId, variant.id, {
        body, firstComment: firstComment.trim() || null, settings,
      });
      if (!res.ok) { setError(describeRefusal(res.error)); return; }
      setValidation(res.validation);
      setApprovalInvalidated(res.approvalInvalidated);
      router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete the ${variant.network} variant?`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteVariant(tenantId, variant.id);
      if (!res.ok) { setError(describeRefusal(res.error)); return; }
      router.refresh();
    });
  }

  return (
    <div style={{ border: "0.5px solid var(--erp-hairline)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span style={{ font: "700 13px var(--font-body)", color: "var(--text-primary)" }}>
          {variant.network} · @{variant.handle}
        </span>
        <StatusBadge label={variant.status} />
      </div>

      {variant.nativeImport && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          Recorded from a hand-published post — bookkeeping only, not editable.
        </p>
      )}

      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Body
        <textarea
          value={body} onChange={(e) => setBody(e.target.value)} disabled={pending || locked} rows={4}
          style={{ display: "block", marginTop: 6, width: "100%", font: "400 13px var(--font-body)", padding: "6px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        First comment
        <input
          value={firstComment} onChange={(e) => setFirstComment(e.target.value)} disabled={pending || locked}
          style={{ display: "block", marginTop: 6, width: "100%", font: "400 13px var(--font-body)", padding: "6px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Network settings (JSON — e.g. {"{"}"igType":"reel"{"}"}, {"{"}"tiktokMode":"inbox"{"}"})
        <textarea
          value={settingsText} onChange={(e) => setSettingsText(e.target.value)} disabled={pending || locked} rows={3}
          style={{ display: "block", marginTop: 6, width: "100%", font: "400 12px var(--font-mono, monospace)", padding: "6px 8px" }}
        />
      </label>

      {variant.media.length > 0 && (
        <div>
          <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>Attached media (read-only — SMM-20)</span>
          <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {variant.media.map((m, i) => (
              <li key={i} style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", border: "0.5px solid var(--erp-hairline-soft)", padding: "2px 6px" }}>
                {m.kind ?? "file"}: {m.fileId ?? "?"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>Validation</span>
        <div style={{ marginTop: 6 }}>
          <ValidationList errors={validation.errors} warnings={validation.warnings} />
        </div>
      </div>

      {variant.estimatedCostUsd > 0 && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
          Estimated metered cost: ${variant.estimatedCostUsd.toFixed(3)}
        </p>
      )}

      {locked && !variant.nativeImport && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          This variant is {variant.status} — no longer editable from the composer.
        </p>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {!locked && (
          <Button variant="solid" size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save variant"}</Button>
        )}
        {canDelete && !["queued", "publishing", "published"].includes(variant.status) && (
          <Button variant="ghost" size="sm" onClick={remove} disabled={pending}>Delete variant</Button>
        )}
        {approvalInvalidated && (
          <span style={{ font: "600 12px var(--font-body)", color: "var(--status-caution-fg, #9a6700)" }}>
            This edit dropped the variant back to draft — its approval no longer applies.
          </span>
        )}
        {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{error}</span>}
      </div>
    </div>
  );
}
