"use client";
import { useActionState, useState } from "react";
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

        <KindAndDetail pending={pending} noProjectToPick={noProjectToPick} />

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

// Kind + the fields whose VISIBILITY depends on it.
//
// ── WHY THIS IS A SEPARATE COMPONENT AND NOT `useState` IN THE PARENT ─────────────────────────────
// The parent keys the <form> on the last successful submission id so an uncontrolled form remounts
// with cleared fields. Component state does NOT reset that way — state lives in the component, not
// the DOM node — so a `kind` held in the PARENT would survive a successful submit while the <select>
// itself reset to "feature", leaving the two disagreeing: the bug fields would stay on screen for a
// form that now says "Feature request". Holding it in a child of the keyed <form> makes the key
// change unmount this component too, so the state and the DOM reset together.
function KindAndDetail({ pending, noProjectToPick }: { pending: boolean; noProjectToPick: boolean }) {
  const [kind, setKind] = useState("feature");
  const disabled = pending || noProjectToPick;

  return (
    <>
      <div className="cp-field">
        <label className="cp-field__label" htmlFor="cr-kind">What kind of request is this?</label>
        <select
          id="cr-kind" className="cp-select" name="kind" value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={disabled} required
        >
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="cr-title">In a few words</label>
        <input
          id="cr-title" className="cp-input" name="title" type="text" maxLength={300} required
          disabled={disabled} aria-describedby="cr-title-hint"
        />
        <span className="cp-field__hint" id="cr-title-hint">
          {kind === "bug"
            ? "e.g. “Checkout total is wrong on mobile”"
            : "e.g. “Update the homepage phone number”"}
        </span>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="cr-body">
          {kind === "bug" ? "What went wrong? (optional)" : "Details (optional)"}
        </label>
        <textarea
          id="cr-body" className="cp-textarea" name="body" maxLength={10_000}
          disabled={disabled}
        />
      </div>

      {/* Bug detail — rendered ONLY for `bug`, so for every other kind these names are absent from the
          FormData entirely rather than submitted empty. Asking someone requesting a content edit for
          reproduction steps is how a form teaches people to ignore it.
          maxLength mirrors the server caps exactly (5000/200/100/2000, BFF contract §16f) so the
          browser stops the caller before a silent server-side truncation does.
          There is deliberately NO severity control: severity is set by us at triage, never by the
          reporter. */}
      {kind === "bug" && (
        <>
          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cr-repro">How can we see it happen? (optional)</label>
            <textarea
              id="cr-repro" className="cp-textarea" name="reproSteps" maxLength={5_000}
              disabled={disabled} aria-describedby="cr-repro-hint"
            />
            <span className="cp-field__hint" id="cr-repro-hint">
              Step by step, if you can — the quickest fixes start from steps we can follow.
            </span>
          </div>

          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cr-url">Which page? (optional)</label>
            <input
              id="cr-url" className="cp-input" name="affectedUrl" type="text" maxLength={2_000}
              disabled={disabled} placeholder="https://…"
            />
          </div>

          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cr-env">Where did you see it? (optional)</label>
            <input
              id="cr-env" className="cp-input" name="environment" type="text" maxLength={200}
              disabled={disabled} aria-describedby="cr-env-hint"
            />
            <span className="cp-field__hint" id="cr-env-hint">
              e.g. the live site, or a preview link we sent you.
            </span>
          </div>

          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cr-version">Version, if you know it (optional)</label>
            <input
              id="cr-version" className="cp-input" name="seenOnVersion" type="text" maxLength={100}
              disabled={disabled}
            />
          </div>
        </>
      )}
    </>
  );
}
