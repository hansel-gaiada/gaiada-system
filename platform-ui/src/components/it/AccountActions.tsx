"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

// P2-14 — the per-row action controls, and the display-once password panel.
//
// ⚠ WHY THE PASSWORD LIVES IN CLIENT STATE AND THE PAGE DOES NOT REFRESH UNDER IT.
// The backend generates the initial password, returns it once, and never stores or audits it. There is
// exactly one copy and it is in this component's state. So:
//   * `router.refresh()` is called ONLY after the operator dismisses the panel — refreshing while it is
//     open would re-render the row and drop the only copy that exists;
//   * the panel says plainly that it will not be shown again, because an operator who assumes they can
//     look it up later will be wrong in a way that costs someone their morning;
//   * nothing writes it to the URL, localStorage, or a toast that auto-dismisses on a timer.
//
// The reset flow requires a REASON before it will submit. The backend accepts a null reason; this
// surface does not, because resetting somebody else's password is the action most likely to be
// questioned later and the reason is what answers it.

type ActionResult =
  | { ok: true; message: string; password?: string; email?: string }
  | { ok: false; error: string };

type Action = (formData: FormData) => Promise<ActionResult>;

interface Props {
  userId: string;
  email: string;
  state: "missing" | "enabled" | "disabled" | "leaver_still_enabled" | "unverified_link";
  provision: Action;
  disable: Action;
  enable: Action;
  resetPassword: Action;
}

export function AccountActions({ userId, email, state, provision, disable, enable, resetPassword }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [askReason, setAskReason] = useState(false);
  const [reason, setReason] = useState("");

  const run = (action: Action, extra?: Record<string, string>) => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("userId", userId);
      fd.set("email", email);
      for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(res.message);
      if (res.password) {
        // Hold it. Do NOT refresh — see the header.
        setPassword(res.password);
      } else {
        router.refresh();
      }
    });
  };

  const dismissPassword = () => {
    setPassword(null);
    setNote(null);
    router.refresh();
  };

  if (password) {
    return (
      <div className="acct-password" role="group" aria-label={`Initial password for ${email}`}>
        <div className="acct-password__label">
          Initial password for <strong>{email}</strong> — <em>shown once, not stored anywhere</em>
        </div>
        <code className="acct-password__value">{password}</code>
        <div className="acct-password__hint">
          Give this to the person directly. It is not written to the audit trail and cannot be retrieved;
          if it is lost, reset the password again.
        </div>
        <Button size="sm" onClick={dismissPassword}>I have shared it</Button>
      </div>
    );
  }

  return (
    <div className="acct-actions">
      {state === "missing" ? (
        <Button size="sm" disabled={pending} onClick={() => run(provision)}>
          {pending ? "Provisioning…" : "Provision"}
        </Button>
      ) : null}

      {state === "leaver_still_enabled" || state === "enabled" || state === "unverified_link" ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(disable)}>
          Disable
        </Button>
      ) : null}

      {state === "disabled" ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(enable)}>
          Enable
        </Button>
      ) : null}

      {state !== "missing" ? (
        askReason ? (
          <span className="acct-actions__reason">
            <input
              type="text"
              value={reason}
              placeholder="Reason (recorded in the audit trail)"
              aria-label="Reason for resetting the password"
              onChange={(e) => setReason(e.target.value)}
              // `lux-field__control` is the real control class (forms/Field.tsx); there is no `lux-input`.
              className="lux-field__control acct-actions__reason-input"
            />
            <Button
              size="sm"
              disabled={pending || !reason.trim()}
              onClick={() => {
                run(resetPassword, { reason: reason.trim() });
                setAskReason(false);
                setReason("");
              }}
            >
              Reset
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAskReason(false); setReason(""); }}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAskReason(true)}>
            Reset password
          </Button>
        )
      ) : null}

      {note ? <span className="acct-actions__note">{note}</span> : null}
      {/* role="alert" rather than a live region: an action failure is the one thing here a screen-reader
          user must hear immediately, and there is exactly one at a time. */}
      {error ? <span className="acct-actions__error" role="alert">{error}</span> : null}
    </div>
  );
}
