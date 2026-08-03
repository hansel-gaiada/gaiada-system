import Link from "next/link";

// "This module is switched off for this company." Rendered INSTEAD of a module's page body when
// companies.enabled_modules doesn't include its key.
//
// Deliberately visible rather than a hidden nav entry: the whole reason this component exists is
// that a disabled module used to be indistinguishable from an empty one, and hiding the entry
// would repeat that mistake in the other direction — the surface would vanish with no trace of
// why or how to get it back. Every one of this module's endpoints 404s while it is off
// (platform-nest ModuleEnabledGuard), so there is nothing to show and no partial mode to offer.
export function ModuleDisabled({ module, label }: { module: string; label?: string }) {
  return (
    <div
      role="note"
      style={{
        border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--erp-accent)",
        background: "var(--tint-hover)", padding: "20px 22px", maxWidth: 640,
      }}
    >
      <p style={{ margin: 0, font: "700 11px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-accent)" }}>
        Module disabled
      </p>
      <p style={{ margin: "8px 0 0", font: "400 14px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        <strong style={{ color: "var(--text-primary)" }}>{label ?? module}</strong> is switched off for
        this company, so none of its data is available here. Nothing has been deleted — turning it
        back on restores this section as it was.
      </p>
      <p style={{ margin: "12px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        Enable it in{" "}
        <Link href="/admin/modules" style={{ color: "var(--erp-accent)" }}>
          Settings → Modules &amp; Fields
        </Link>{" "}
        (company administrators only), or ask an administrator to. Module key:{" "}
        <code style={{ font: "600 12px var(--font-mono, monospace)" }}>{module}</code>.
      </p>
    </div>
  );
}
