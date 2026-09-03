"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { PROBE_CONSENT_ATTESTATION, CONSENT_BASIS_MAX, basisError } from "@/lib/probeConsent";
import "./webdesk.css";

// The consent REQUEST form. Owner rulings: docs/plans/2026-09-03-probe-consent-rulings.md.
//
// ── WHY THIS IS A FORM AND NOT A BUTTON ────────────────────────────────────────────────────────
// `search_properties.verified_at` is what the monitoring sweep builds its probe allowlist from, so
// granting it is the record that we may reach out and touch a client's website. Ruling §1 put the
// grant in someone else's hands; ruling §2 made a reference note mandatory; ruling §3 fixed the
// sentence being agreed to. All three exist to stop this being a toggle, so the UI must not
// re-flatten it into one:
//   · the attestation is stated ABOVE the control, in full, not in a tooltip or a help link;
//   · the note is required before the button does anything;
//   · the copy says what happens next, because nothing is granted by pressing this.
//
// The attestation text is also stored on the approval row server-side, so the record carries the
// words that were actually agreed to rather than whatever this file says today.

export function ProbeConsentRequest({
  domain,
  propertyId,
  onRequest,
}: {
  domain: string;
  propertyId: string;
  onRequest: (propertyId: string, basis: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <p className="wd-consent__done">
        Requested. It is waiting for someone who can grant it, and nothing probes{" "}
        <strong>{domain}</strong> until they do.
      </p>
    );
  }

  if (!open) {
    return (
      <p style={{ margin: 0 }}>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Request probe consent
        </Button>
      </p>
    );
  }

  const submit = () => {
    const bad = basisError(basis);
    if (bad) { setError(bad); return; }
    setError(null);
    startTransition(async () => {
      const res = await onRequest(propertyId, basis);
      if (!res.ok) setError(res.error ?? "That didn't work.");
      else setDone(true);
    });
  };

  return (
    <div className="wd-consent">
      {/* The attestation, in full, immediately above the field. This sentence is the compliance
          artefact — it is what the requester is asserting, and it is stored with the record. */}
      <p className="wd-consent__attest">{PROBE_CONSENT_ATTESTATION}</p>

      <label className="wd-consent__field">
        <span className="type-eyebrow wd-pf__label">What covers it</span>
        <input
          className="lux-field__control"
          value={basis}
          maxLength={CONSENT_BASIS_MAX}
          onChange={(e) => { setBasis(e.target.value); if (error) setError(null); }}
          placeholder="e.g. MSA clause 7.2, or the client email of 2026-08-14, or GDA-412"
          aria-label="The contract clause, email or ticket that covers monitoring this domain"
          aria-invalid={error ? true : undefined}
        />
        {/* Says WHY it is required rather than merely that it is: the note is what makes the
            assertion defensible later, and the person filling it in is the only one who knows. */}
        <span className="wd-consent__hint">
          Required. Whoever reviews this needs to know what entitles us to probe {domain}, and you
          are the one holding it.
        </span>
      </label>

      <div className="wd-consent__actions">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? "Filing…" : "Request consent"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setOpen(false); setBasis(""); setError(null); }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>

      {/* Stated before they press it, not after: pressing this grants nothing. */}
      <p className="wd-consent__hint">
        This files a request. Someone with the authority to record consent decides it, and only then
        may monitoring probe this domain.
      </p>

      {error && <p className="wd-consent__error" role="alert">{error}</p>}
    </div>
  );
}
