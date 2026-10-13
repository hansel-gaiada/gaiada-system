"use client";
import { useState } from "react";
import { maskAccountNo } from "@/lib/billingView";
import "./billing-screens.css";

// PV5-09 — a bank account number, masked until someone asks for it (PV-D26: these details redirect real money).
//
// Masking is a courtesy against shoulder-surfing and screenshots, not a security control: the number is in the page's
// data, and an invoice prints it in full for the client. The server decides who may read it. `aria-pressed` carries the
// state for a screen reader, and the visible value is what a reader hears, so the masked form is never read as digits.
export function MaskedAccount({ value, label = "Account number" }: { value: string | null | undefined; label?: string }) {
  const [shown, setShown] = useState(false);
  if (!value) return <span>—</span>;
  return (
    <span className="bs-masked">
      <span className="bs-masked__value">{shown ? value : maskAccountNo(value)}</span>
      <button
        type="button"
        className="bs-chipbtn"
        aria-pressed={shown}
        aria-label={`${shown ? "Hide" : "Show"} ${label.toLowerCase()}`}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? "Hide" : "Show"}
      </button>
    </span>
  );
}
