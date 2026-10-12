"use client";
import { useRef, useState } from "react";
import { shortHash } from "@/lib/billingView";
import "./billing-screens.css";

// PV5-09 — a content fingerprint (the SHA-256 fixed when a contract was sent) in short form, with a button that copies the
// FULL value. Staff compare it with the evidence page of a signed copy; the short form is for the eye, the copy is for the
// comparison. The result is announced in a polite live region and never relies on the clipboard existing (an insecure
// origin or a denied permission says so in words instead of pretending).
export function CopyHash({ hash, label = "Content fingerprint" }: { hash: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(hash);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 4000);
  }

  return (
    <span className="bs-fingerprint">
      <span className="bs-fingerprint__label">{label}</span>
      <code title={hash}>{state === "failed" ? hash : shortHash(hash)}</code>
      <button type="button" className="bs-chipbtn" onClick={copy} aria-label={`Copy the full ${label.toLowerCase()}`}>
        Copy
      </button>
      <span className="bs-fingerprint__status" role="status">
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy. The full value is shown so you can select it." : ""}
      </span>
    </span>
  );
}
