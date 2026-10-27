"use client";
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { portalSocialApproveAll, portalSocialDecide, portalSocialReloadPost } from "@/lib/portalSocialActions";
import { bulkSummary, describeDecideError, type PortalSocialPost } from "@/lib/portalSocial";
import type { CommentAnchor } from "@/lib/pm";
import { undoDeadline, useSocialToasts } from "./PortalSocialToasts";

// SCP-2 (BFF §63.9) — the client's decisions on ONE post, shared by the card, the post page and the story viewer so every place says the same words and
// does the same thing: approve (button or double-tap), ask for changes (the dialog), and what to do when the server refuses.
//
//   content_changed       the post changed while the client looked: re-read it, hand the new version (and its new hash) to the page, and say so.
//   post_not_with_client  it is no longer waiting (our team recorded a decision, or it was undone elsewhere): refresh the list, say so.
//   anything else         shown in words, in place.
// A decision in flight blocks a second one (a double-tap must not send two).
export interface ChangeInput { changeKind: "copy" | "design"; note: string; anchor?: CommentAnchor }
export type ChangeResult =
  | { ok: true }
  | { ok: false; error: string; field?: string; /** The post was re-read: the dialog closes and the page shows the new version. */ reloaded?: boolean };

export function usePostDecision(post: PortalSocialPost, onReloaded: (post: PortalSocialPost) => void, onDecided?: () => void) {
  const router = useRouter();
  const toasts = useSocialToasts();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const r = await portalSocialReloadPost(post.id);
      if (r.ok && r.data?.post) { onReloaded(r.data.post); return true; }
    } catch {
      // the new version could not be read: the page is refreshed below and shows what the server has
    }
    router.refresh();
    return false;
  }, [post.id, onReloaded, router]);

  /** What every decision does once the server has refused. Returns the words and whether the post was re-read. */
  const refused = useCallback(async (code: string | undefined, words: string): Promise<{ words: string; reloaded: boolean }> => {
    if (code === "content_changed") {
      const reloaded = await reload();
      setNotice(describeDecideError("content_changed"));
      setError(null);
      return { words: describeDecideError("content_changed"), reloaded };
    }
    if (code === "post_not_with_client") router.refresh();
    return { words, reloaded: false };
  }, [reload, router]);

  const approve = useCallback(async (): Promise<void> => {
    if (post.state !== "to_review" || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await portalSocialDecide({ postId: post.id, decision: "approve", seenHash: post.reviewHash });
      if (r.ok) {
        const d = r.data;
        if (d?.alreadyDecided) toasts.push({ message: `"${post.title}" was already approved.` });
        else {
          toasts.push({
            message: `Approved "${post.title}".`,
            ...(d?.decisionId ? { undo: { decisionIds: [d.decisionId], postIds: [post.id], until: undoDeadline(d.undoUntil, Date.now()) } } : {}),
          });
          onDecided?.();
        }
      } else {
        const x = await refused(r.code, r.error ?? "That did not work. Try again.");
        if (r.code !== "content_changed") setError(x.words);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [post, toasts, refused, onDecided]);

  const askChanges = useCallback(async (input: ChangeInput): Promise<ChangeResult> => {
    if (post.state !== "to_review" || inFlight.current) return { ok: false, error: "This post is no longer waiting for you." };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await portalSocialDecide({
        postId: post.id, decision: "change", seenHash: post.reviewHash, changeKind: input.changeKind, note: input.note.trim(),
        ...(input.anchor ? { anchor: input.anchor } : {}),
      });
      if (r.ok) {
        const d = r.data;
        toasts.push({
          message: d?.alreadyDecided ? `You already asked for changes to "${post.title}".` : `Asked for changes to "${post.title}".`,
          ...(d?.decisionId && !d.alreadyDecided ? { undo: { decisionIds: [d.decisionId], postIds: [post.id], until: undoDeadline(d.undoUntil, Date.now()) } } : {}),
        });
        if (!d?.alreadyDecided) onDecided?.();
        return { ok: true };
      }
      const x = await refused(r.code, r.error ?? "That did not work. Try again.");
      return { ok: false, error: x.words, field: r.field, reloaded: x.reloaded || r.code === "content_changed" };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [post, toasts, refused, onDecided]);

  return { busy, error, notice, approve, askChanges };
}

/** "Approve all": exactly the listed posts. What was skipped is said in plain words, and a skipped post is never an error. */
export function useApproveAll(titleOf: (postId: string) => string) {
  const router = useRouter();
  const toasts = useSocialToasts();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (items: Array<{ postId: string; seenHash: string }>): Promise<boolean> => {
    if (inFlight.current || items.length === 0) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await portalSocialApproveAll(items);
      if (!r.ok || !r.data) { setError(r.error ?? "That did not work. Try again."); return false; }
      const s = bulkSummary(r.data.results, titleOf);
      const ids = r.data.results.filter((x) => x.outcome === "approved" && x.decisionId);
      toasts.push({
        message: s.text,
        ...(ids.length > 0
          ? { undo: { decisionIds: ids.map((x) => x.decisionId as string), postIds: ids.map((x) => x.postId), until: undoDeadline(r.data.undoUntil, Date.now()) } }
          : {}),
      });
      // a skipped post means the list is not what the client was looking at: show the truth
      if (s.skipped.length > 0) router.refresh();
      return true;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [titleOf, toasts, router]);

  return { busy, error, run };
}
