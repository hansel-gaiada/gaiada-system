"use client";
// SMM-11 — edits ONE existing per-network variant's body/first-comment/settings, renders its
// validation result inline (errors block, warnings never do — ValidationList.tsx's own contract),
// and offers delete. SMM-20 (AMENDED by D-17: generation removed) adds the media panel below:
// attach from the asset library (files / Drive-mirrored files / Studio-graded `creative_assets`)
// and detach — attach-ONLY, never a generate control that actually calls anything, per the
// inert `ai.imageGen` affordance rendered at the bottom of the panel.
//
// Refusal tokens the update/delete/attach calls can answer with (`variant_native_import_immutable`,
// `variant_not_editable`, `variant_is_live`, `asset_not_found`, `unsupported_asset_source`) are
// rendered via `describeRefusal`, never re-worded inline — same "the token is the contract" rule
// the validation issues follow.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui";
import {
  updateVariant, deleteVariant, checkPublishPreconditions, requestClientReview, withdrawClientReview,
  attachVariantMedia,
} from "@/lib/socialActions";
import {
  describeRefusal, describeQuota, evaluateClientReviewState, type SocialPostVariant,
  type SocialAccount, type PublishPreconditionResult, type ClientReviewState,
  type AssetLibrary, type MediaDescriptor,
} from "@/lib/socialShared";
import { ValidationList } from "./ValidationList";

export function VariantCard({
  tenantId, variant, canDelete, account, accountsForbidden, clientReview, requiresClientOk,
  canRequestReview, canWithdrawReview, assetLibrary, assetLibraryForbidden,
}: {
  tenantId: string;
  variant: SocialPostVariant;
  /** `social.post.delete` — Cerbos denies module_staff this action even though staff hold
   *  `social.manage` (create/update). UI hint only; the backend re-checks regardless. */
  canDelete: boolean;
  /** The connected account this variant targets (SMM-05 registry, `lib/social.ts`'s
   *  `listAccounts`) — carries the live quota probe the quota strip renders. `undefined` when the
   *  post-detail page's account lookup missed (account deleted since, or the read was denied —
   *  see `accountsForbidden`), in which case the strip must say "unavailable", never fabricate. */
  account?: SocialAccount;
  /** True only on a genuine 403 reading the account registry — rendered distinctly from "no
   *  account" so a denial never reads as "nothing to report" (the same rule `AccessDenied.tsx`
   *  states for a whole-page read). */
  accountsForbidden?: boolean;
  /** SMM-31/32 — this variant's client sign-off row, read server-side (`lib/social.ts`'s
   *  `getClientReview`) so the client component only ever receives a plain, already-resolved
   *  object across the server/client boundary. */
  clientReview: ClientReviewState;
  /** `toolScope.posting.requiresClientOk` on the POST's own engagement — one value shared by every
   *  variant of the same post, so the composer page fetches it once and passes it down rather than
   *  each card re-reading the engagement. Purely informational here: staff may ask for sign-off
   *  regardless of this flag; it only changes whether the note says "required before this can
   *  publish" or "optional — nothing requires it, but you can still ask". */
  requiresClientOk: boolean;
  /** `social.client_review.request` — held by both social_staff and social_manager tiers. */
  canRequestReview: boolean;
  /** `social.client_review.withdraw` — manager-tier only, same split as `canDelete`. */
  canWithdrawReview: boolean;
  /** SMM-20 — files/Drive/Studio assets attachable to THIS post's engagement (one client, shared
   *  by every variant of the post — the composer page reads it once, same pattern as
   *  `requiresClientOk`). */
  assetLibrary: AssetLibrary;
  /** True only on a genuine 403 reading the library — rendered distinctly from "the library is
   *  empty", same honesty rule every other guarded read on this card already follows. */
  assetLibraryForbidden?: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState(variant.body);
  const [firstComment, setFirstComment] = useState(variant.firstComment ?? "");
  const [settingsText, setSettingsText] = useState(JSON.stringify(variant.settings ?? {}, null, 2));
  const [validation, setValidation] = useState(variant.validation);
  const [approvalInvalidated, setApprovalInvalidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<PublishPreconditionResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPending, startPreviewTransition] = useTransition();
  const [review, setReview] = useState(clientReview);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewPending, startReviewTransition] = useTransition();
  const [media, setMedia] = useState<MediaDescriptor[]>(variant.media);
  const [showLibrary, setShowLibrary] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaPending, startMediaTransition] = useTransition();

  function runPreview() {
    setPreviewError(null);
    startPreviewTransition(async () => {
      const res = await checkPublishPreconditions(tenantId, variant.id);
      if (!res.ok) { setPreviewError(res.error); setPreview(null); return; }
      setPreview(res.verdict);
    });
  }

  // SMM-32 — ask / re-ask / withdraw the client's sign-off. `requestClientReview` is the SAME
  // idempotent upsert whether this is the first ask, a re-ask after `changes_requested`/`withdrawn`,
  // or a re-ask after an edit staled a prior `approved` — one row, forever (0105's `UNIQUE(variant_id)`).
  function requestReview() {
    setReviewError(null);
    startReviewTransition(async () => {
      const res = await requestClientReview(tenantId, variant.id);
      if (!res.ok) { setReviewError(res.error); return; }
      setReview({ status: "pending" });
      router.refresh();
    });
  }
  function withdrawReview() {
    setReviewError(null);
    startReviewTransition(async () => {
      const res = await withdrawClientReview(tenantId, variant.id);
      if (!res.ok) { setReviewError(res.error); return; }
      setReview({ status: "withdrawn" });
      router.refresh();
    });
  }

  const locked = variant.nativeImport || !["draft", "in_review", "approved"].includes(variant.status);

  // SMM-20 — attach ONE library asset. Same "edit invalidates approval" contract `save()` carries
  // below: a successful attach against an approved/in-review variant answers `approvalInvalidated`
  // and this renders it immediately, never lets the operator discover it on the next load.
  function attach(source: "file" | "creative_asset", assetId: string) {
    setMediaError(null);
    startMediaTransition(async () => {
      const res = await attachVariantMedia(tenantId, variant.id, { source, assetId });
      if (!res.ok) { setMediaError(describeRefusal(res.error)); return; }
      setMedia(res.media);
      setValidation(res.validation);
      if (res.approvalInvalidated) setApprovalInvalidated(true);
      router.refresh();
    });
  }

  // Detach reuses the SAME general `updateVariant` PATCH the body/settings save below calls —
  // no separate backend endpoint exists (or is needed) for removing an entry: sending the
  // filtered `media` array is itself a legal edit, and the backend's own edit-invalidates-approval
  // law applies identically either way.
  function detach(fileId: string | undefined, index: number) {
    setMediaError(null);
    const next = media.filter((_, i) => i !== index);
    startMediaTransition(async () => {
      const res = await updateVariant(tenantId, variant.id, { media: next });
      if (!res.ok) { setMediaError(describeRefusal(res.error)); return; }
      setMedia(next);
      setValidation(res.validation);
      if (res.approvalInvalidated) setApprovalInvalidated(true);
      router.refresh();
    });
  }

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

      <QuotaStrip network={variant.network} account={account} accountsForbidden={accountsForbidden} />

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

      <MediaPanel
        media={media} locked={locked} pending={mediaPending} error={mediaError}
        showLibrary={showLibrary} onToggleLibrary={() => setShowLibrary((s) => !s)}
        assetLibrary={assetLibrary} assetLibraryForbidden={assetLibraryForbidden}
        onAttach={attach} onDetach={detach}
      />

      <div>
        <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>Validation</span>
        <div style={{ marginTop: 6 }}>
          <ValidationList errors={validation.errors} warnings={validation.warnings} />
        </div>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
            Publish readiness
          </span>
          <Button variant="ghost" size="sm" onClick={runPreview} disabled={previewPending}>
            {previewPending ? "Checking…" : "Check now"}
          </Button>
        </div>
        {/* Submit-with-preview: a DRY RUN of the exact D14 execution precondition
            (`GET .../publish-preconditions`), not a re-derived guess — same evaluator, same
            typed vocabulary the executor itself reports. The verdict is DATA, not an error: a
            refusal here is a legitimate, informative answer and is rendered as the token it is,
            never folded into "something went wrong" (criterion 5). */}
        <div style={{ marginTop: 6 }}>
          {previewError && (
            <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{previewError}</p>
          )}
          {!previewError && preview === null && (
            <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
              Not checked yet — this asks the same gate the publish approval will run at dispatch time.
            </p>
          )}
          {!previewError && preview?.ok && (
            <p style={{ margin: 0, font: "600 12px var(--font-body)", color: "var(--status-positive-fg, #1a7f37)" }}>
              Publishable right now — every gate (scope, quota, hash, single-use, budget, creator-info) passes.
            </p>
          )}
          {!previewError && preview && !preview.ok && (
            <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>
              <code style={{ font: "700 10px var(--font-mono, monospace)", background: "var(--tint-hover)", border: "0.5px solid var(--status-critical-fg, #b3261e)", padding: "1px 5px", marginRight: 6 }}>
                {preview.stage}
              </code>
              {describeRefusal(preview.reason ?? "")}
            </p>
          )}
        </div>
      </div>

      <ClientReviewPanel
        review={review} liveArgsSha256={variant.argsSha256} requiresClientOk={requiresClientOk}
        canRequest={canRequestReview} canWithdraw={canWithdrawReview} pending={reviewPending}
        error={reviewError} onRequest={requestReview} onWithdraw={withdrawReview}
      />

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

/** The quota strip (SMM-12) — three visibly different states, never collapsed into one another:
 *  a KNOWN live count (bar + numbers), UNKNOWN (registry hasn't synced — never rendered as "0
 *  used"), and NOT MODELED (this network has no live counter at all, a different fact from
 *  "unsynced"). `describeQuota` (socialShared.ts) picks the state; this only draws it. */
function QuotaStrip({
  network, account, accountsForbidden,
}: {
  network: SocialPostVariant["network"];
  account?: SocialAccount;
  accountsForbidden?: boolean;
}) {
  if (accountsForbidden) {
    return (
      <p style={{ margin: 0, font: "400 11px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>
        Quota: access denied reading the account registry (403) — not the same as unknown.
      </p>
    );
  }
  if (!account) {
    return (
      <p style={{ margin: 0, font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>
        Quota: no connected-account record found for this variant.
      </p>
    );
  }
  const info = describeQuota(network, account.quota);
  const pct = info.status === "known" && info.cap && info.cap > 0 ? Math.min(100, (info.used! / info.cap) * 100) : 0;
  const color = info.status === "known"
    ? (pct >= 100 ? "var(--status-critical-fg, #b3261e)" : pct >= (100 - (2 / (info.cap || 1)) * 100) ? "var(--status-caution-fg, #9a6700)" : "var(--erp-ink-60)")
    : "var(--erp-ink-50)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {info.status === "known" && (
        <div style={{ width: 72, height: 6, background: "var(--tint-hover)", border: "0.5px solid var(--erp-hairline)", flex: "0 0 auto" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: color }} />
        </div>
      )}
      <span style={{ font: "400 11px var(--font-body)", color }}>{info.label}</span>
    </div>
  );
}

/** SMM-31/32 — the client sign-off panel. `evaluateClientReviewState` mirrors the backend's
 *  `evaluateClientReviewPrecondition` exactly (same five-way branch plus the "approved but the
 *  content changed since" stale check against the variant's LIVE `argsSha256`), so this renders the
 *  IDENTICAL verdict the D14 executor/dispatch would reach right now — the same "same evaluator, not
 *  a re-derived guess" property the publish-preconditions preview above already carries.
 *
 *  Once a review is resolved (`approved`/`changes_requested`/`withdrawn`), no decide control renders
 *  here at all — that control lives on the CLIENT's own portal page, never here (this is the staff
 *  ask/read/withdraw half only) — so there is no second-decision affordance for THIS panel to guard
 *  against; what it does guard is offering "ask again" only where re-asking is the correct next
 *  action, and never a stale "waiting" message once the client has actually decided. */
function ClientReviewPanel({
  review, liveArgsSha256, requiresClientOk, canRequest, canWithdraw, pending, error, onRequest, onWithdraw,
}: {
  review: ClientReviewState;
  liveArgsSha256: string;
  requiresClientOk: boolean;
  canRequest: boolean;
  canWithdraw: boolean;
  pending: boolean;
  error: string | null;
  onRequest: () => void;
  onWithdraw: () => void;
}) {
  const verdict = evaluateClientReviewState(review, liveArgsSha256);
  return (
    <div style={{ borderTop: "0.5px solid var(--erp-hairline-soft)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Client sign-off
        </span>
        <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>
          {requiresClientOk ? "Required before this can publish" : "Optional — not required by this engagement, but you can still ask"}
        </span>
      </div>

      <div style={{ marginTop: 6 }}>
        {verdict.ok ? (
          <p style={{ margin: 0, font: "600 12px var(--font-body)", color: "var(--status-positive-fg, #1a7f37)" }}>
            The client approved this exact content{review.decidedAt ? ` on ${new Date(review.decidedAt).toLocaleDateString()}` : ""}.
          </p>
        ) : (
          <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: review.status === "pending" ? "var(--status-caution-fg, #9a6700)" : "var(--status-critical-fg, #b3261e)" }}>
            <code style={{ font: "700 10px var(--font-mono, monospace)", background: "var(--tint-hover)", border: `0.5px solid ${review.status === "pending" ? "var(--status-caution-fg, #9a6700)" : "var(--status-critical-fg, #b3261e)"}`, padding: "1px 5px", marginRight: 6 }}>
              client_review
            </code>
            {describeRefusal(verdict.reason)}
          </p>
        )}
        {review.comment && review.status === "changes_requested" && (
          <p style={{ margin: "4px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
            &ldquo;{review.comment}&rdquo;
          </p>
        )}
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        {/* not_requested / changes_requested / withdrawn / stale all resolve to the SAME next
            action — ask (or re-ask), which is always the idempotent upsert onto the one row. */}
        {(review.status === "not_requested" || review.status === "changes_requested" || review.status === "withdrawn" || (review.status === "approved" && !verdict.ok)) && canRequest && (
          <Button variant="ghost" size="sm" onClick={onRequest} disabled={pending}>
            {pending ? "Asking…" : review.status === "not_requested" ? "Ask client to review" : "Ask again"}
          </Button>
        )}
        {review.status === "pending" && canWithdraw && (
          <Button variant="ghost" size="sm" onClick={onWithdraw} disabled={pending}>
            {pending ? "Withdrawing…" : "Withdraw request"}
          </Button>
        )}
        {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{error}</span>}
      </div>
    </div>
  );
}

/** SMM-20 (AMENDED by D-17 — generation removed). The variant's media, editable: attach from the
 *  library (files / Drive-mirrored files / Studio-graded `creative_assets`) or detach one entry.
 *  Never uploads anything to the publisher — that is SMM-39's dispatch-time job, entirely
 *  untouched by this panel, which only ever writes the composer-side descriptor.
 *
 *  The inert "Generate with AI" row at the bottom is the D-17 requirement rendered literally: no
 *  generative-image backend exists anywhere in the estate (`ai-gateway-go` exposes `/complete`,
 *  `/complete/stream`, `/media` (vision) and `/embed` — nothing generative; the Creative render
 *  gateway is `0.0.0 PLANNED`). This is NOT conditioned on the engagement's own `ai.imageGen`
 *  scope toggle — flipping that toggle changes nothing here or on the backend beyond a named
 *  warning at scope-patch time (`social.controller.ts`'s `validateScopePatch`), because there is
 *  no generation capability to turn on regardless of the flag's value. A disabled control that
 *  explains itself, always, is the same pattern this module already ships for TikTok/YouTube/X at
 *  the deployment level — never a control that silently does nothing. */
function MediaPanel({
  media, locked, pending, error, showLibrary, onToggleLibrary, assetLibrary, assetLibraryForbidden,
  onAttach, onDetach,
}: {
  media: MediaDescriptor[];
  locked: boolean;
  pending: boolean;
  error: string | null;
  showLibrary: boolean;
  onToggleLibrary: () => void;
  assetLibrary: AssetLibrary;
  assetLibraryForbidden?: boolean;
  onAttach: (source: "file" | "creative_asset", assetId: string) => void;
  onDetach: (fileId: string | undefined, index: number) => void;
}) {
  return (
    <div style={{ borderTop: "0.5px solid var(--erp-hairline-soft)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Attached media
        </span>
        {!locked && (
          <Button variant="ghost" size="sm" onClick={onToggleLibrary} disabled={pending}>
            {showLibrary ? "Close library" : "Attach from library"}
          </Button>
        )}
      </div>

      {media.length === 0 ? (
        <p style={{ margin: "6px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          No attachments yet.
        </p>
      ) : (
        <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: 6 }}>
          {media.map((m, i) => (
            <li key={i} style={{
              font: "400 11px var(--font-body)", color: "var(--erp-ink-50)",
              border: "0.5px solid var(--erp-hairline-soft)", padding: "2px 6px",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <span>{m.kind ?? "file"}{m.format ? ` (${m.format})` : ""}: {m.fileId ?? "?"}</span>
              {!locked && (
                <button
                  type="button" onClick={() => onDetach(m.fileId, i)} disabled={pending}
                  aria-label={`Remove ${m.fileId ?? "attachment"}`}
                  style={{ border: "none", background: "none", color: "var(--status-critical-fg, #b3261e)", font: "700 11px var(--font-body)", cursor: "pointer", padding: 0 }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p style={{ margin: "6px 0 0", font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{error}</p>
      )}

      {showLibrary && !locked && (
        <div style={{ marginTop: 8, border: "0.5px solid var(--erp-hairline-soft)", padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {assetLibraryForbidden && (
            <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>
              Access denied reading the asset library (403) — not the same as an empty one.
            </p>
          )}
          {!assetLibraryForbidden && assetLibrary.files.length === 0 && assetLibrary.studioAssets.length === 0 && (
            <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
              Nothing in the library yet for this client — attach a file to the client record, or grade one in the Creative Studio.
            </p>
          )}
          {assetLibrary.files.length > 0 && (
            <div>
              <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>Files &amp; Drive</span>
              <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                {assetLibrary.files.map((f) => (
                  <li key={f.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, font: "400 12px var(--font-body)" }}>
                    <span>
                      {f.filename}
                      <span style={{ marginLeft: 6, font: "400 10px var(--font-body)", color: "var(--erp-ink-50)" }}>
                        {f.source === "drive" ? "drive reference — no bytes of ours" : "uploaded"}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => onAttach("file", f.id)} disabled={pending}>Attach</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {assetLibrary.studioAssets.length > 0 && (
            <div>
              <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>Studio-graded</span>
              <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                {assetLibrary.studioAssets.map((a) => (
                  <li key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, font: "400 12px var(--font-body)" }}>
                    <span>{a.name}{a.presetId ? ` (${a.presetId})` : ""}</span>
                    <Button variant="ghost" size="sm" onClick={() => onAttach("creative_asset", a.id)} disabled={pending}>Attach</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── D-17: the inert AI-generate affordance ──────────────────────────────────────────
              Deliberately un-clickable — no `onClick`, no server call. Naming why is the point:
              a control that silently does nothing is worse than an absent one. */}
          <div style={{ borderTop: "0.5px dashed var(--erp-hairline-soft)", paddingTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <Button variant="ghost" size="sm" disabled>Generate with AI</Button>
            <span style={{ font: "400 11px/1.4 var(--font-body)", color: "var(--erp-ink-50)" }}>
              Unavailable — no generative-image backend exists in the estate yet (the Creative
              render gateway is still 0.0.0 PLANNED). Attach an existing asset above instead.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
