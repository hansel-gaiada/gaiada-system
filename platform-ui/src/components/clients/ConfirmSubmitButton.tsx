"use client";

// CC-D10 — a submit button that asks first. Used for the client hub's Delete, which now sits beside
// Archive: one misclick used to delete a client with no prompt at all. Cancelling the prompt stops the
// form submit, so the server action never runs.
export function ConfirmSubmitButton({ label, message }: { label: string; message: string }) {
  return (
    <button
      type="submit"
      className="lux-btn lux-btn--ghost lux-btn--sm"
      onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}
    >
      {label}
    </button>
  );
}
