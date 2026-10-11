"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { markdownExtensions, parseMarkdown, roundTrips, serializeDoc, type Envelope, type PlaceholderSyntax } from "@/lib/markdownCodec";
import { MarkdownPreview } from "./MarkdownPreview";

// The visual (WYSIWYG) editor for one `markdown` field (WSK-45, ruling WSK-D49).
//
// THE RULE THIS FILE EXISTS TO KEEP: an unchanged body saves byte-identical. So the field's value is the ORIGINAL string until
// the document genuinely differs from the one that was loaded. "Differs" is decided on ProseMirror documents (`doc.eq`), never
// on strings, so typing a character and deleting it again hands the original bytes back. Only a real change is serialised,
// and the serialiser (lib/markdownCodec.ts) writes every placeholder (`{{token}}`, `[CONFIRM: …]`) verbatim.
//
// WHEN IT IS MOUNTED. The parent (MarkdownField) mounts this only for a text that round-trips (`roundTrips(value)`). If the
// value is replaced from OUTSIDE later (Load theirs, restore, a refresh) and the new text does not round-trip, this component
// does not touch the document and calls `onLossy`, and the parent flips to the source view.
//
// LOCKS. `readOnly` is the same lock FieldEditor gives every other control (no update right, a deleted item, a historic
// version, a stale page does not reach here: the form is disabled around it): the document is not editable, the toolbar is
// disabled, and nothing is ever emitted.

const HEADINGS = [1, 2, 3, 4] as const;

function safeHref(raw: string): boolean {
  const v = raw.trim();
  if (v === "") return false;
  if (/^(https?:|mailto:|tel:)/i.test(v)) return true;
  // No scheme at all: a site-relative or relative address ("/about", "#top", "../x", "page").
  return !/^[a-z][a-z0-9+.-]*:/i.test(v);
}

interface Flags { bold: boolean; italic: boolean; code: boolean; link: boolean; bullet: boolean; ordered: boolean; quote: boolean; block: string; canUndo: boolean; canRedo: boolean }

function flagsOf(editor: Editor): Flags {
  const heading = HEADINGS.find((l) => editor.isActive("heading", { level: l }));
  return {
    bold: editor.isActive("bold"), italic: editor.isActive("italic"), code: editor.isActive("code"), link: editor.isActive("link"),
    bullet: editor.isActive("bulletList"), ordered: editor.isActive("orderedList"), quote: editor.isActive("blockquote"),
    block: editor.isActive("codeBlock") ? "code" : heading ? `h${heading}` : editor.isActive("heading") ? "other" : "p",
    canUndo: editor.can().undo(), canRedo: editor.can().redo(),
  };
}

export function WysiwygEditor({
  value, onChange, readOnly, label, describedBy, invalid, pointer, placeholders, onLossy,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  label: string;
  describedBy?: string;
  invalid: boolean;
  pointer: string;
  placeholders: PlaceholderSyntax[];
  /** The value was replaced from outside with text the visual editor cannot hold exactly. */
  onLossy: () => void;
}) {
  const uid = useId();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [rove, setRove] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  // What was loaded, and what to hand back while nothing differs from it.
  const baseline = useRef<{ doc: PMNode | null; text: string; env: Envelope }>({ doc: null, text: value, env: { eol: "\n", lead: "", tail: "" } });
  /** The last value this component put out (or loaded). A different `value` prop is an outside change. */
  const last = useRef<string>(value);
  const phRef = useRef(placeholders);
  phRef.current = placeholders;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLossyRef = useRef(onLossy);
  onLossyRef.current = onLossy;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  const initial = useMemo(() => {
    try {
      const p = parseMarkdown(value);
      baseline.current.env = p.env;
      return p.doc.toJSON();
    } catch {
      return null;
    }
    // Parsed once, at mount. Later outside changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [unverified, setUnverified] = useState(false);
  const hintId = `${uid}-hint`;

  /** One place for the surface's attributes and keys, used at creation and whenever a prop that shows in them changes. */
  const surfaceProps = () => ({
    attributes: {
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": label,
      class: `wc-md__surface${invalid ? " wc-md__surface--error" : ""}`,
      "data-pointer": pointer,
      "aria-describedby": [describedBy, hintId].filter(Boolean).join(" "),
      ...(invalid ? { "aria-invalid": "true" } : {}),
      ...(readOnly ? { "aria-readonly": "true" } : {}),
    },
    // Escape leaves the editor for the toolbar: a table or a list would otherwise keep Tab to itself.
    handleKeyDown: (_view: unknown, e: KeyboardEvent) => {
      if (e.key !== "Escape") return false;
      const bar = toolbarRef.current;
      (bar?.querySelector<HTMLElement>('[data-tb][tabindex="0"]:not(:disabled)') ?? bar?.querySelector<HTMLElement>("[data-tb]:not(:disabled)"))?.focus();
      return true;
    },
  });

  const editor = useEditor({
    extensions: markdownExtensions,
    content: initial ?? undefined,
    editable: !readOnly && initial !== null,
    immediatelyRender: false,
    editorProps: surfaceProps(),
    onCreate: ({ editor: e }) => { baseline.current.doc = e.state.doc; },
    onUpdate: ({ editor: e }) => {
      if (readOnlyRef.current) return; // a locked field never emits, whatever drives the document
      const doc = e.state.doc;
      const b = baseline.current;
      let next: string;
      if (b.doc && doc.eq(b.doc)) {
        next = b.text;
        setUnverified(false);
      } else {
        const out = serializeDoc(doc, b.env, phRef.current);
        next = out.text;
        setUnverified(!out.verified);
      }
      if (next === last.current) return;
      last.current = next;
      onChangeRef.current(next);
    },
  });

  // Props that show in the surface's attributes stay current.
  useEffect(() => { editor?.setOptions({ editorProps: surfaceProps() }); }, [editor, label, describedBy, invalid, pointer, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // A body the codec cannot parse must never open in an empty editor (an edit would then save only what was typed).
  useEffect(() => { if (initial === null) onLossyRef.current(); }, [initial]);

  // A value that arrives from OUTSIDE (not the one we last emitted): adopt it as the new baseline, or hand over to source.
  useEffect(() => {
    if (!editor || value === last.current) return;
    if (!roundTrips(value, phRef.current)) { onLossyRef.current(); return; }
    const p = parseMarkdown(value);
    editor.chain().setMeta("addToHistory", false).setContent(p.doc.toJSON(), { emitUpdate: false }).run();
    baseline.current = { doc: editor.state.doc, text: value, env: p.env };
    last.current = value;
    setUnverified(false);
  }, [editor, value]);

  useEffect(() => { if (editor && baseline.current.doc === null) baseline.current.doc = editor.state.doc; }, [editor]);
  useEffect(() => { if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly); }, [editor, readOnly]);

  const flags = useEditorState({ editor, selector: ({ editor: e }) => (e ? flagsOf(e) : null) });

  // ── toolbar ──────────────────────────────────────────────────────────────────────────────────────
  const focusables = (): HTMLElement[] => Array.from(toolbarRef.current?.querySelectorAll<HTMLElement>("[data-tb]") ?? []).filter((el) => !(el as HTMLButtonElement).disabled);
  const onToolbarKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const items = focusables();
    const at = items.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    items[to].focus();
    setRove(Number(items[to].dataset.tb));
  };

  const run = (fn: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (!editor || readOnly) return;
    fn(editor.chain().focus()).run();
  };

  const openLink = () => {
    if (!editor || readOnly) return;
    setLinkValue(String(editor.getAttributes("link").href ?? ""));
    setLinkError(null);
    setLinkOpen(true);
  };
  const closeLink = () => { setLinkOpen(false); editor?.commands.focus(); };
  const applyLink = () => {
    if (!editor || readOnly) return;
    const href = linkValue.trim();
    if (href === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); return; }
    if (!safeHref(href)) { setLinkError("Use an http(s), mailto or tel address, or a relative one such as /about."); return; }
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
  };
  const removeLink = () => { if (editor && !readOnly) editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); };

  const tb = (i: number) => ({ "data-tb": i, tabIndex: rove === i ? 0 : -1, onFocus: () => setRove(i), disabled: readOnly || !editor } as const);
  const f = flags ?? ({} as Partial<Flags>);

  if (!editor) {
    // Server render and the first client render: the editor mounts after hydration. Show the text, not an empty box.
    return (
      <div className="wc-md__visual" data-testid="markdown-visual-loading" aria-busy="true">
        <MarkdownPreview source={value} />
      </div>
    );
  }

  return (
    <div className="wc-md__visual" data-testid="markdown-visual" data-readonly={readOnly || undefined}>
      <div ref={toolbarRef} role="toolbar" aria-label={`${label} formatting`} aria-controls={`${uid}-surface`} className="wc-md__toolbar" onKeyDown={onToolbarKey}>
        <button type="button" className="wc-md__tb" aria-label="Bold" title="Bold (Ctrl+B)" aria-pressed={f.bold ?? false} {...tb(0)} onClick={() => run((c) => c.toggleBold())}><strong aria-hidden="true">B</strong></button>
        <button type="button" className="wc-md__tb" aria-label="Italic" title="Italic (Ctrl+I)" aria-pressed={f.italic ?? false} {...tb(1)} onClick={() => run((c) => c.toggleItalic())}><em aria-hidden="true">I</em></button>
        <button type="button" className="wc-md__tb" aria-label="Link" title="Link" aria-pressed={f.link ?? false} aria-expanded={linkOpen} {...tb(2)} onClick={() => (linkOpen ? closeLink() : openLink())}><span aria-hidden="true">Link</span></button>
        <span className="wc-md__tbsel">
          <select
            aria-label="Block style"
            className="wc-md__select"
            data-tb={3}
            tabIndex={rove === 3 ? 0 : -1}
            onFocus={() => setRove(3)}
            disabled={readOnly}
            value={f.block ?? "p"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "p") run((c) => c.setParagraph());
              else if (v === "code") run((c) => c.setCodeBlock());
              else if (v.startsWith("h")) run((c) => c.setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 | 4 }));
            }}
          >
            <option value="p">Paragraph</option>
            {HEADINGS.map((l) => <option key={l} value={`h${l}`}>Heading {l}</option>)}
            <option value="code">Code block</option>
            {f.block === "other" && <option value="other" disabled>Heading 5 or 6</option>}
          </select>
        </span>
        <button type="button" className="wc-md__tb" aria-label="Bulleted list" title="Bulleted list" aria-pressed={f.bullet ?? false} {...tb(4)} onClick={() => run((c) => c.toggleBulletList())}><span aria-hidden="true">&bull; List</span></button>
        <button type="button" className="wc-md__tb" aria-label="Numbered list" title="Numbered list" aria-pressed={f.ordered ?? false} {...tb(5)} onClick={() => run((c) => c.toggleOrderedList())}><span aria-hidden="true">1. List</span></button>
        <button type="button" className="wc-md__tb" aria-label="Quote" title="Quote" aria-pressed={f.quote ?? false} {...tb(6)} onClick={() => run((c) => c.toggleBlockquote())}><span aria-hidden="true">Quote</span></button>
        <button type="button" className="wc-md__tb" aria-label="Inline code" title="Inline code (Ctrl+E)" aria-pressed={f.code ?? false} {...tb(7)} onClick={() => run((c) => c.toggleCode())}><code aria-hidden="true">{"</>"}</code></button>
        <button type="button" className="wc-md__tb" aria-label="Undo" title="Undo (Ctrl+Z)" {...tb(8)} disabled={readOnly || !editor || f.canUndo === false} onClick={() => run((c) => c.undo())}><span aria-hidden="true">Undo</span></button>
        <button type="button" className="wc-md__tb" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" {...tb(9)} disabled={readOnly || !editor || f.canRedo === false} onClick={() => run((c) => c.redo())}><span aria-hidden="true">Redo</span></button>
      </div>
      {linkOpen && !readOnly && (
        <div className="wc-md__linkbar" role="group" aria-label="Edit link">
          <label htmlFor={`${uid}-href`} className="wc-md__linklabel">Link address</label>
          <input
            id={`${uid}-href`}
            className="lux-field__control wc-md__linkinput"
            type="text"
            autoFocus
            value={linkValue}
            aria-invalid={linkError ? true : undefined}
            aria-describedby={linkError ? `${uid}-linkerr` : undefined}
            onChange={(e) => { setLinkValue(e.target.value); setLinkError(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); applyLink(); }
              if (e.key === "Escape") { e.preventDefault(); closeLink(); }
            }}
          />
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={applyLink}>Apply</button>
          {f.link && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={removeLink}>Remove link</button>}
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={closeLink}>Cancel</button>
          {linkError && <span id={`${uid}-linkerr`} className="lux-field__error" role="alert">{linkError}</span>}
        </div>
      )}
      {unverified && !readOnly && (
        <p className="wc-md__notice" role="status" data-testid="markdown-unverified">
          Part of this text may not save exactly as it looks here. Check it in the Source tab before you save.
        </p>
      )}
      <div id={`${uid}-surface`}>
        <EditorContent editor={editor} />
      </div>
      <span id={hintId} className="wc-sr">Press Escape to move to the formatting toolbar. Inside a table or a list, Tab moves between cells and items.</span>
    </div>
  );
}
