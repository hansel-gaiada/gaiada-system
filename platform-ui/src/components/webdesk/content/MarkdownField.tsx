"use client";
import { useId, useMemo, useState } from "react";
import { diagnose, roundTrips, type PlaceholderSyntax } from "@/lib/markdownCodec";
import { MarkdownPreview } from "./MarkdownPreview";
import { WysiwygEditor } from "./WysiwygEditor";

export { MarkdownPreview };

// A markdown field (WSK-45, owner ruling WSK-D49: rich text stays the `markdown` primitive, edited visually).
//
// THREE VIEWS of one string:
//   Visual   the TipTap editor (WysiwygEditor). Offered ONLY for a text that survives parse -> serialise byte-for-byte
//            (`roundTrips`); an unchanged body is never re-serialised, so it saves exactly as it was loaded.
//   Source   the Markdown textarea: the text is edited and stored VERBATIM (CommonMark + GFM), never normalised (§2.2).
//   Preview  a read-only structural rendering built from React elements (no HTML string is ever assembled from content).
//
// A text the visual editor cannot keep exactly (a table padded by hand, a numbered list that skips, indentation …) OPENS in
// Source with a short notice naming the first construct, and the Visual tab stays off until the text round-trips. Nothing is
// ever "fixed" to make it fit. Read-only and locked states disable every view the same way FieldEditor always has.

type Tab = "visual" | "source" | "preview";
const NO_PLACEHOLDERS: PlaceholderSyntax[] = [];

/** A textarea always reports LF, whatever the stored text used. A body written with CRLF keeps CRLF while it is edited as source
 *  (otherwise the first keystroke would rewrite every line ending, and every save would be a whole-document diff). */
function keepLineEndings(previous: string, typed: string): string {
  return previous.includes("\r\n") && !typed.includes("\r") ? typed.replace(/\n/g, "\r\n") : typed;
}

function humanise(construct: string): string {
  return construct.replace(/:/g, " — ").replace(/-/g, " ");
}

export function MarkdownField({
  value, onChange, readOnly, describedBy, invalid, pointer, label, placeholders = NO_PLACEHOLDERS,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  describedBy?: string;
  invalid: boolean;
  pointer: string;
  label: string;
  /** The collection's declared placeholder syntaxes (`lint.placeholders`), kept verbatim by the visual editor. */
  placeholders?: PlaceholderSyntax[];
}) {
  const [tab, setTab] = useState<Tab>(() => (roundTrips(value, placeholders) ? "visual" : "source"));
  const id = useId();
  const noticeId = `${id}-notice`;

  // Can the visual editor hold this text exactly? While the Visual tab is up it is (the tab is only entered that way, and an
  // outside change that breaks it hands back to Source), so the check is skipped per keystroke there.
  const gate = useMemo(() => {
    if (tab === "visual") return { eligible: true, why: null as string | null };
    const eligible = roundTrips(value, placeholders);
    if (eligible) return { eligible, why: null };
    const d = diagnose(value, placeholders);
    return { eligible, why: d ? `${humanise(d.construct)}${d.line ? `, line ${d.line}` : ""}` : null };
  }, [tab, value, placeholders]);

  const tabBtn = (t: Tab, text: string, extra?: { disabled?: boolean; title?: string }) => (
    <button
      type="button"
      role="tab"
      id={`${id}-${t}`}
      aria-selected={tab === t}
      aria-controls={`${id}-${t}-panel`}
      aria-disabled={extra?.disabled || undefined}
      aria-describedby={extra?.disabled ? noticeId : undefined}
      disabled={extra?.disabled}
      title={extra?.title}
      className={`wc-md__tab${tab === t ? " wc-md__tab--on" : ""}`}
      onClick={() => setTab(t)}
    >{text}</button>
  );

  return (
    <div className="wc-md">
      <div role="tablist" aria-label={`${label} view`} className="wc-md__tabs">
        {tabBtn("visual", "Visual", gate.eligible ? undefined : { disabled: true, title: "This text uses Markdown the visual editor cannot keep exactly." })}
        {tabBtn("source", "Source")}
        {tabBtn("preview", "Preview")}
      </div>
      {!gate.eligible && (
        <p id={noticeId} className="wc-md__notice" role="note" data-testid="markdown-source-notice">
          This text uses Markdown the visual editor cannot keep exactly, so it opens as source.
          {gate.why ? <span className="wc-md__why"> First difference: {gate.why}.</span> : null}
          {" "}Edit it here; the Visual tab returns once the text can be shown without changing a character.
        </p>
      )}
      {tab === "visual" && (
        <div role="tabpanel" id={`${id}-visual-panel`} aria-labelledby={`${id}-visual`}>
          <WysiwygEditor
            value={value}
            onChange={onChange}
            readOnly={readOnly}
            label={label}
            describedBy={describedBy}
            invalid={invalid}
            pointer={pointer}
            placeholders={placeholders}
            onLossy={() => setTab("source")}
          />
        </div>
      )}
      {tab === "source" && (
        <div role="tabpanel" id={`${id}-source-panel`} aria-labelledby={`${id}-source`}>
          <textarea
            className={`lux-field__control lux-field__control--textarea wc-md__source${invalid ? " lux-field__control--error" : ""}`}
            value={value}
            readOnly={readOnly}
            aria-readonly={readOnly || undefined}
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            data-pointer={pointer}
            rows={14}
            spellCheck
            onChange={(e) => onChange(keepLineEndings(value, e.target.value))}
          />
        </div>
      )}
      {tab === "preview" && (
        <div role="tabpanel" id={`${id}-preview-panel`} aria-labelledby={`${id}-preview`}>
          <MarkdownPreview source={value} />
        </div>
      )}
    </div>
  );
}
