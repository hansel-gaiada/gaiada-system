"use client";
import { useRef, useState } from "react";

// PV2-07 - an email shown as selectable text with a copy button. The clipboard call sits inside the click
// handler (a user gesture); if it rejects, the text is selected so the person can press Ctrl+C.
export function PortalCopyEmail({ email }: { email: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "select">("idle");

  const selectText = () => {
    const el = ref.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      setState("copied");
    } catch {
      selectText();
      setState("select");
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span ref={ref} style={{ userSelect: "all", overflowWrap: "anywhere" }}>{email}</span>
      <button type="button" className="btn" style={{ fontSize: 12, padding: "2px 8px" }} onClick={copy}
              aria-label={`Copy ${email}`}>
        Copy
      </button>
      <span role="status" style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
        {state === "copied" ? "Copied" : state === "select" ? "Selected, press Ctrl+C" : ""}
      </span>
    </span>
  );
}
