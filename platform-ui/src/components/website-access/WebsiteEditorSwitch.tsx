"use client";
import "./websiteAccess.css";

// One on/off control for "this person may edit the website". A real checkbox with role="switch", so it
// is focusable, toggles on Space, and is announced as "switch, on/off" with no custom key handling.
//
// `accessibleName` ALWAYS names the person ("Website editor: Dana Whitfield"), because a page of rows
// that each say only "Website editor" gives a screen-reader user nothing to tell them apart. It starts
// with the visible `label`, so the visible text is contained in the name (WCAG 2.5.3).
//
// It is CONTROLLED and shows server truth: it flips only after the write answers (the parent passes the
// new `checked`), and while a write is in flight it is `aria-disabled` + `aria-busy` and ignores input.
// It is NOT the `disabled` attribute on purpose: a disabled control drops keyboard focus, so a keyboard
// user who toggled it would find focus thrown to the page. No optimistic flip, so a refused or
// unchanged write can never leave a switch lying about what is stored.
export function WebsiteEditorSwitch({
  checked,
  pending,
  label,
  accessibleName,
  onChange,
}: {
  checked: boolean;
  pending: boolean;
  /** Visible text beside the switch. */
  label: string;
  accessibleName: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="wa-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        aria-label={accessibleName}
        onChange={(e) => {
          if (pending) return;
          onChange(e.currentTarget.checked);
        }}
      />
      <span className="wa-switch__track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
