"use client";
import { useActionState } from "react";
import { portalSubmitChangeRequest, type PortalActionResult } from "@/lib/portalActions";
import type { PortalProjectOption } from "@/lib/portal";

// MI-04 — the client's "ask for something" form (webdev maintenance intake).
//
// ── WHY THIS NEVER CHECKS SIGNING CAPABILITY ──────────────────────────────────────────────────────
// The design doc's §5.1 ruling — test-pinned on the backend in
// webdev-change-requests-portal.controller.ts, and pinned again at this layer by
// `lib/portal.ts`'s `changeRequestFormProps` + its test — is that submitting a change request is a
// VIEWER-permitted act. This component takes no `canSign` prop at all: there is nothing here to gate
// on signing capability, by construction, so a future edit cannot silently narrow a ratified decision
// back to signers-only.
//
// ── THE PROJECT SELECTOR (the design doc's "subtle AC") ───────────────────────────────────────────
// `allowClientWide` is resolved server-side from the caller's OWN portal scope
// (`PortalProfile.access.wholeClient`), never guessed from the project list. A project-scoped contact
// gets no "all projects" option and must name one of `projects` — the backend 4xx's a mismatch, but
// this is the honest UX rather than leaning on that refusal.
const KINDS: Array<{ value: string; label: string }> = [
  { value: "feature", label: "Feature request" },
  { value: "design", label: "Design change" },
  { value: "content", label: "Content edit" },
  { value: "bug", label: "Something isn't working" },
];

export function PortalChangeRequestForm({ allowClientWide, projects }: {
  allowClientWide: boolean;
  projects: PortalProjectOption[];
}) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(
    portalSubmitChangeRequest,
    null,
  );

  // NO `router.refresh()` here, deliberately — and this note exists because I added one first and it
  // was dead code. `portalSubmitChangeRequest` calls `revalidatePath("/portal/requests")`, and a server
  // action that revalidates returns the updated RSC payload with its own response, so the list above
  // this form re-renders without any client-side nudge. Probed: with the refresh removed, the e2e case
  // that asserts the new row appears still passes. The real cause of that row going missing was the
  // demo store being duplicated across module graphs (see `lib/demoPortal.ts`'s CR_STORE_KEY note),
  // which a refresh would only have papered over.

  // A project-scoped contact with no project on their account yet has nothing valid to name — the
  // form must not offer a submit that the backend will only 4xx.
  const noProjectToPick = !allowClientWide && projects.length === 0;

  return (
    <>
      {state?.ok && (
        <div className="cp-form__ok" role="status">
          Thanks — we&apos;ve received your request and will triage it shortly.
        </div>
      )}
      {/* Keyed on the last successful submission's id so a new one remounts the (uncontrolled) form
          with cleared fields — the same clear-on-success behaviour a controlled reset would give,
          without fighting `defaultValue` on every field. */}
      <form action={formAction} className="cp-form" key={state?.id ?? "initial"}>
        {state?.error && (
          <div className="cp-form__error" role="alert">{state.error}</div>
        )}

        <div className="cp-field">
          <label className="cp-field__label" htmlFor="cr-kind">What kind of request is this?</label>
          <select
            id="cr-kind" className="cp-select" name="kind" defaultValue="feature"
            disabled={pending || noProjectToPick} required
          >
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>

        <div className="cp-field">
          <label className="cp-field__label" htmlFor="cr-title">In a few words</label>
          <input
            id="cr-title" className="cp-input" name="title" type="text" maxLength={300} required
            disabled={pending || noProjectToPick} aria-describedby="cr-title-hint"
          />
          <span className="cp-field__hint" id="cr-title-hint">
            e.g. &quot;Update the homepage phone number&quot;
          </span>
        </div>

        <div className="cp-field">
          <label className="cp-field__label" htmlFor="cr-body">Details (optional)</label>
          <textarea
            id="cr-body" className="cp-textarea" name="body" maxLength={10_000}
            disabled={pending || noProjectToPick}
          />
        </div>

        {noProjectToPick ? (
          <p className="cp-field__hint">
            You don&apos;t have a project on your account yet — ask your account manager before
            raising a request.
          </p>
        ) : (
          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cr-project">Which project is this for?</label>
            <select
              id="cr-project" className="cp-select" name="projectId" defaultValue=""
              disabled={pending} required={!allowClientWide}
            >
              {/* Client-wide contacts ONLY: an "all projects" option that submits with no projectId at
                  all. A project-scoped contact never sees this — they must name one of their own
                  projects (§5.1's project rule). */}
              {allowClientWide && <option value="">Your whole account</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <button type="submit" className="btn btn-primary" disabled={pending || noProjectToPick}>
            {pending ? "Sending…" : "Send request"}
          </button>
        </div>
      </form>
    </>
  );
}
