"use client";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  defaultValueFor, fieldLabel, fieldPointer, hasNeutralDescendant, isNeutral, issuesAt, issuesUnder, moveItem,
  type FieldDef, type Issue,
} from "@/lib/webdeskContentModel";
import type { PlaceholderSyntax } from "@/lib/markdownCodec";
import { MarkdownField } from "./MarkdownField";
import "./content.css";

// The form generated from a collection's FieldDef[] (§2.2–§2.5). Nothing here is specific to a
// collection: the 17 gaiada.com compositions (pages, globals with nested groups, lists of objects
// keyed by `itemKey`, read-only derived columns) all render through this one tree.
//
// LOCKS. A control is locked for exactly three reasons and says which:
//   • `ui.readOnly`            — a derived/imported column ("Source path", token occurrence counts)
//   • locale-neutral (`localized:false`) on a NON-default locale — the default-locale item's value is
//     authoritative (§2.5 rule 2); the form shows that value, read-only, and the save writes it through
//   • the whole form is read-only (no `update`, a deleted item, a historic version)
//
// POINTERS. Every control carries `data-pointer="/blocks/0/props/faq/2/answer"` — the same RFC 6901
// pointer a 422 `composition-violation` issue is located by (§2.2 `ItemIssue.path`), so an inline
// error is found by string equality and the e2e/unit tests can address a control by its pointer.

export interface FormCtx {
  issues: Issue[];
  /** Whole form read-only (no `update`, deleted, …). */
  readOnly: boolean;
  /** Non-default locale: locale-neutral members are read-only. */
  neutralLock: boolean;
  /** Name of the authoritative locale, for the lock hint. */
  neutralLocale: string | null;
  /** The collection's declared placeholder syntaxes (`lint.placeholders`): the visual markdown editor keeps them verbatim. */
  placeholders?: PlaceholderSyntax[];
}

type Lock = null | "readonly" | "neutral";

function lockFor(def: FieldDef, ctx: FormCtx, inherited: Lock): Lock {
  if (ctx.readOnly) return "readonly";
  if (def.ui?.readOnly) return "readonly";
  if (inherited) return inherited;
  if (ctx.neutralLock && isNeutral(def)) return "neutral";
  return null;
}

function lockHint(lock: Lock, ctx: FormCtx): string | null {
  if (lock === "neutral") return `Shared across locales — edit it in ${ctx.neutralLocale ?? "the default locale"}.`;
  if (lock === "readonly") return ctx.readOnly ? null : "Read-only.";
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function setKey(obj: Record<string, unknown>, k: string, v: unknown): Record<string, unknown> {
  const next = { ...obj };
  if (v === undefined) delete next[k];
  else next[k] = v;
  return next;
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function Errors({ id, issues }: { id: string; issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul id={id} className="wc-errors">
      {issues.map((i, n) => <li key={n} className="lux-field__error">{i.message}{i.expected ? ` (expected ${i.expected})` : ""}</li>)}
    </ul>
  );
}

// ── The recursive form ───────────────────────────────────────────────────────────────────────────

export function FieldEditor({
  defs, value, onChange, ctx, segments = [], inheritedLock = null,
}: {
  defs: FieldDef[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  ctx: FormCtx;
  segments?: (string | number)[];
  inheritedLock?: Lock;
}) {
  return (
    <div className="wc-fields">
      {defs.map((def) => (
        <FieldRow
          key={def.name}
          def={def}
          value={value[def.name]}
          onValue={(v) => onChange(setKey(value, def.name, v))}
          ctx={ctx}
          segments={[...segments, def.name]}
          inheritedLock={inheritedLock}
        />
      ))}
    </div>
  );
}

function FieldRow({ def, value, onValue, ctx, segments, inheritedLock }: {
  def: FieldDef; value: unknown; onValue: (v: unknown) => void; ctx: FormCtx; segments: (string | number)[]; inheritedLock: Lock;
}) {
  const lock = lockFor(def, ctx, inheritedLock) ?? (isNeutral(def) && ctx.neutralLock ? "neutral" : null);
  if (def.multiple) return <ListField def={def} value={value} onValue={onValue} ctx={ctx} segments={segments} lock={lock} inheritedLock={inheritedLock} />;
  if (def.primitive === "group") {
    const pointer = fieldPointer(...segments);
    const nested = issuesUnder(ctx.issues, pointer);
    const childLock: Lock = lock; // a locked group locks everything beneath it
    return (
      <fieldset className="wc-group" data-pointer={pointer} aria-invalid={nested.length > 0 || undefined}>
        <legend>
          {fieldLabel(def)}
          {nested.length > 0 && <span className="wc-group__count"> · {nested.length} problem{nested.length === 1 ? "" : "s"}</span>}
        </legend>
        {def.ui?.help && <p className="lux-field__hint">{def.ui.help}</p>}
        {lockHint(lock, ctx) && <p className="lux-field__hint">{lockHint(lock, ctx)}</p>}
        <FieldEditor defs={def.fields ?? []} value={asRecord(value)} onChange={(next) => onValue(next)} ctx={ctx} segments={segments} inheritedLock={childLock} />
      </fieldset>
    );
  }
  return <ScalarField def={def} value={value} onValue={onValue} ctx={ctx} segments={segments} lock={lock} />;
}

function ScalarField({ def, value, onValue, ctx, segments, lock }: {
  def: FieldDef; value: unknown; onValue: (v: unknown) => void; ctx: FormCtx; segments: (string | number)[]; lock: Lock;
}) {
  const id = useId();
  const pointer = fieldPointer(...segments);
  const errs = issuesAt(ctx.issues, pointer);
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const hint = def.ui?.help ?? lockHint(lock, ctx) ?? undefined;
  const describedBy = [errs.length ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const label = fieldLabel(def);
  const isCheckbox = def.primitive === "boolean";
  return (
    <div className={`lux-field wc-field${lock ? " wc-field--locked" : ""}`} data-locked={lock ?? undefined}>
      {isCheckbox ? null : (
        <label className={`lux-field__label${def.required ? " lux-field__label--req" : ""}`} htmlFor={id}>{label}</label>
      )}
      <ScalarControl id={id} def={def} value={value} onValue={onValue} locked={lock !== null} pointer={pointer} describedBy={describedBy} invalid={errs.length > 0} label={label} placeholders={ctx.placeholders} />
      {hint && <span id={hintId} className="lux-field__hint">{hint}</span>}
      <Errors id={errId} issues={errs} />
    </div>
  );
}

/** One value of one primitive. Used by scalar fields AND by the elements of a scalar list. */
export function ScalarControl({ id, def, value, onValue, locked, pointer, describedBy, invalid, label, placeholders }: {
  id: string; def: FieldDef; value: unknown; onValue: (v: unknown) => void; locked: boolean; pointer: string;
  describedBy?: string; invalid: boolean; label: string; placeholders?: PlaceholderSyntax[];
}) {
  const common = {
    id, "data-pointer": pointer, "aria-invalid": invalid || undefined, "aria-describedby": describedBy,
  } as const;
  const cls = `lux-field__control${invalid ? " lux-field__control--error" : ""}`;
  const str = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

  switch (def.primitive) {
    case "markdown":
      return <MarkdownField value={str} onChange={(v) => onValue(v)} readOnly={locked} describedBy={describedBy} invalid={invalid} pointer={pointer} label={label} placeholders={placeholders} />;

    case "text": {
      const widget = def.ui?.widget;
      if (widget === "textarea" || widget === "code") {
        return (
          <textarea
            {...common}
            className={`${cls} lux-field__control--textarea${widget === "code" ? " wc-code" : ""}`}
            rows={widget === "code" ? 10 : 4}
            spellCheck={widget === "code" ? false : undefined}
            value={str}
            readOnly={locked}
            aria-readonly={locked || undefined}
            onChange={(e) => onValue(e.target.value)}
          />
        );
      }
      return <input {...common} className={cls} type="text" value={str} readOnly={locked} aria-readonly={locked || undefined} onChange={(e) => onValue(e.target.value)} />;
    }

    case "richtext": {
      if (typeof value === "string" || value === undefined || value === null) {
        return <textarea {...common} className={`${cls} lux-field__control--textarea`} rows={6} value={str} readOnly={locked} aria-readonly={locked || undefined} onChange={(e) => onValue(e.target.value)} />;
      }
      // A Lexical document: shown, never edited here (the WYSIWYG editor is WSK-45).
      return <textarea {...common} className={`${cls} lux-field__control--textarea wc-code`} rows={8} readOnly aria-readonly="true" value={JSON.stringify(value, null, 2)} />;
    }

    case "number":
      return (
        <input
          {...common} className={cls} type="number" value={typeof value === "number" ? value : ""}
          readOnly={locked} aria-readonly={locked || undefined}
          onChange={(e) => onValue(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );

    case "date":
      return (
        <input
          {...common} className={cls} type="text" inputMode="text" placeholder="ISO-8601, e.g. 2026-10-20" value={str}
          readOnly={locked} aria-readonly={locked || undefined}
          onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value)}
        />
      );

    case "boolean":
      return (
        <label className="wc-check" htmlFor={id}>
          <input {...common} type="checkbox" checked={value === true} disabled={locked} onChange={(e) => onValue(e.target.checked)} />
          <span className={`lux-field__label${def.required ? " lux-field__label--req" : ""}`}>{label}</span>
        </label>
      );

    case "select": {
      const options = def.options ?? [];
      const known = typeof value !== "string" || value === "" || options.includes(value);
      return (
        <span className="lux-field__selectwrap">
          <select {...common} className={cls} value={str} disabled={locked} onChange={(e) => onValue(e.target.value === "" ? undefined : e.target.value)}>
            <option value="">{def.required ? "Select…" : "— none —"}</option>
            {/* A stored value this composition does not list must stay visible, not vanish. */}
            {!known && <option value={str}>{str} (not an allowed value)</option>}
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </span>
      );
    }

    case "media": {
      const m = asRecord(value);
      const set = (k: string, v: string) => onValue(setKey(m, k, v === "" ? undefined : v));
      return (
        <div className="wc-compound" data-pointer={pointer}>
          <input id={id} className={cls} type="text" placeholder="Image URL" aria-label={`${label} URL`} aria-invalid={invalid || undefined} aria-describedby={describedBy} data-pointer={`${pointer}/url`} value={typeof m.url === "string" ? m.url : ""} readOnly={locked} onChange={(e) => set("url", e.target.value)} />
          <input className={cls} type="text" placeholder="Alt text" aria-label={`${label} alt text`} data-pointer={`${pointer}/alt`} value={typeof m.alt === "string" ? m.alt : ""} readOnly={locked} onChange={(e) => set("alt", e.target.value)} />
        </div>
      );
    }

    case "relation": {
      const r = asRecord(value);
      return (
        <div className="wc-compound" data-pointer={pointer}>
          <input id={id} className={cls} type="text" placeholder="Collection" aria-label={`${label} collection`} aria-invalid={invalid || undefined} aria-describedby={describedBy} data-pointer={`${pointer}/collection`} value={typeof r.collection === "string" ? r.collection : (def.relationTo ?? "")} readOnly={locked} onChange={(e) => onValue({ ...r, collection: e.target.value })} />
          <input className={cls} type="text" placeholder="Slug" aria-label={`${label} slug`} data-pointer={`${pointer}/slug`} value={typeof r.slug === "string" ? r.slug : ""} readOnly={locked} onChange={(e) => onValue({ ...r, slug: e.target.value })} />
        </div>
      );
    }

    case "geo": {
      const g = asRecord(value);
      const num = (v: string) => (v === "" ? undefined : Number(v));
      return (
        <div className="wc-compound" data-pointer={pointer}>
          <input id={id} className={cls} type="number" step="any" placeholder="Latitude" aria-label={`${label} latitude`} aria-invalid={invalid || undefined} aria-describedby={describedBy} data-pointer={`${pointer}/lat`} value={typeof g.lat === "number" ? g.lat : ""} readOnly={locked} onChange={(e) => onValue({ ...g, lat: num(e.target.value) })} />
          <input className={cls} type="number" step="any" placeholder="Longitude" aria-label={`${label} longitude`} data-pointer={`${pointer}/lng`} value={typeof g.lng === "number" ? g.lng : ""} readOnly={locked} onChange={(e) => onValue({ ...g, lng: num(e.target.value) })} />
        </div>
      );
    }

    case "group":
      // A group is rendered by FieldRow/ListField; reaching here means a list-of-groups element
      // asked for a scalar control, which is a programming error — fail visibly, never blank.
      return <p className="lux-field__error" role="alert">Internal: group rendered as a scalar ({pointer}).</p>;
  }
}

// ── Lists: add · remove · reorder by drag AND keyboard ───────────────────────────────────────────

function useStableIds(length: number): [string[], (next: string[]) => void] {
  const counter = useRef(0);
  const mint = () => `r${++counter.current}`;
  const [ids, setIds] = useState<string[]>(() => Array.from({ length }, mint));
  // The list can change length from the OUTSIDE (Load theirs, restore, a refresh). Keep existing ids
  // for the surviving prefix so inputs keep their identity; mint for new tail rows.
  if (ids.length !== length) {
    const next = ids.slice(0, length);
    while (next.length < length) next.push(mint());
    setIds(next);
    return [next, setIds];
  }
  return [ids, setIds];
}

function ListField({ def, value, onValue, ctx, segments, lock, inheritedLock }: {
  def: FieldDef; value: unknown; onValue: (v: unknown) => void; ctx: FormCtx; segments: (string | number)[]; lock: Lock; inheritedLock: Lock;
}) {
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const [ids, setIds] = useStableIds(items.length);
  const pointer = fieldPointer(...segments);
  const nested = issuesUnder(ctx.issues, pointer);
  const label = fieldLabel(def);
  const listId = useId();
  const helpId = `${listId}-help`;

  // Locks. Fully locked (readonly or the whole list is neutral): no add/remove/reorder.
  // Partly neutral rows in a non-default locale: identity members are read-only, so adding or
  // removing a row would create one nobody can complete — structure is the default locale's call;
  // reordering is allowed (order is per locale, §2.5 rule 3).
  const fullyLocked = lock !== null;
  const structureLocked = fullyLocked || (ctx.neutralLock && def.primitive === "group" && hasNeutralDescendant(def));
  const reorderLocked = fullyLocked;

  const [grabbed, setGrabbed] = useState<{ id: string; originValue: unknown[]; originIds: string[] } | null>(null);
  // The drag SOURCE is a ref, not state: re-rendering the dragged element inside `dragstart` makes
  // Chromium cancel the drag. Only the drop-target highlight is state.
  const dragFromRef = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const handleRefs = useRef(new Map<string, HTMLElement | null>());
  const focusAfter = useRef<string | null>(null);
  const addedRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());

  useLayoutEffect(() => {
    if (focusAfter.current) {
      handleRefs.current.get(focusAfter.current)?.focus();
      focusAfter.current = null;
    }
    if (addedRef.current) {
      const li = rowRefs.current.get(addedRef.current);
      li?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select")?.focus();
      addedRef.current = null;
    }
  });

  const rowTitle = (row: unknown, i: number): string => {
    if (def.primitive === "group" && def.itemKey) {
      const k = asRecord(row)[def.itemKey];
      if (typeof k === "string" && k) return k;
    }
    if (def.primitive === "group") {
      const first = (def.fields ?? [])[0];
      const v = first ? asRecord(row)[first.name] : undefined;
      if (typeof v === "string" && v) return v;
    } else if (typeof row === "string" && row) {
      return row.length > 40 ? `${row.slice(0, 40)}…` : row;
    }
    return `${label} ${i + 1}`;
  };

  const commit = (nextItems: unknown[], nextIds: string[]) => { setIds(nextIds); onValue(nextItems); };

  const move = (from: number, to: number, focusId?: string) => {
    if (reorderLocked || to < 0 || to >= items.length || from === to) return;
    if (focusId) focusAfter.current = focusId;
    commit(moveItem(items, from, to), moveItem(ids, from, to));
    setAnnounce(`${rowTitle(items[from], from)} moved to position ${to + 1} of ${items.length}.`);
  };

  const remove = (i: number) => {
    if (structureLocked) return;
    const next = items.slice(); next.splice(i, 1);
    const nextIds = ids.slice(); nextIds.splice(i, 1);
    commit(next, nextIds);
    setAnnounce(`Removed ${rowTitle(items[i], i)}. ${next.length} remaining.`);
  };

  const add = () => {
    if (structureLocked) return;
    const fresh = defaultValueFor({ ...def, multiple: false });
    const nextIds = [...ids, `n${Date.now()}${ids.length}`];
    addedRef.current = nextIds[nextIds.length - 1];
    commit([...items, fresh ?? (def.primitive === "boolean" ? false : "")], nextIds);
    setAnnounce(`Added a new ${label} row. ${items.length + 1} in total.`);
  };

  const onHandleKey = (e: React.KeyboardEvent<HTMLElement>, i: number, id: string) => {
    if (reorderLocked) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (grabbed?.id === id) { setGrabbed(null); setAnnounce(`${rowTitle(items[i], i)} dropped at position ${i + 1} of ${items.length}.`); }
      else { setGrabbed({ id, originValue: items, originIds: ids }); setAnnounce(`${rowTitle(items[i], i)} grabbed at position ${i + 1} of ${items.length}. Use the arrow keys to move it, Space to drop, Escape to cancel.`); }
      return;
    }
    if (e.key === "Escape" && grabbed?.id === id) {
      e.preventDefault();
      focusAfter.current = id;
      commit(grabbed.originValue, grabbed.originIds);
      setGrabbed(null);
      setAnnounce("Move cancelled.");
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (grabbed?.id === id || e.altKey)) {
      e.preventDefault();
      move(i, i + (e.key === "ArrowUp" ? -1 : 1), id);
    }
  };

  return (
    <fieldset className="wc-group wc-list" data-pointer={pointer} aria-invalid={nested.length > 0 || undefined}>
      <legend>
        {label}
        <span className="wc-group__count"> · {items.length} {items.length === 1 ? "item" : "items"}</span>
        {nested.length > 0 && <span className="wc-group__count"> · {nested.length} problem{nested.length === 1 ? "" : "s"}</span>}
      </legend>
      {(def.ui?.help || lockHint(lock, ctx)) && <p className="lux-field__hint">{def.ui?.help ?? lockHint(lock, ctx)}</p>}
      {!fullyLocked && items.length > 1 && (
        <p id={helpId} className="lux-field__hint">
          Reorder: drag the handle, or focus it and press Space, then the arrow keys, then Space to drop (Escape cancels).
          {structureLocked && !fullyLocked ? ` Rows are added and removed in ${ctx.neutralLocale ?? "the default locale"}.` : ""}
        </p>
      )}
      <ol className="wc-list__rows">
        {items.map((row, i) => {
          const id = ids[i];
          const isGrabbed = grabbed?.id === id;
          return (
            <li
              key={id}
              ref={(el) => { rowRefs.current.set(id, el); }}
              className={`wc-list__row${isGrabbed ? " wc-list__row--grabbed" : ""}${dragOver === i && dragFromRef.current !== null && dragFromRef.current !== i ? " wc-list__row--over" : ""}`}
              data-row-pointer={fieldPointer(...segments, i)}
              onDragOver={(e) => { if (dragFromRef.current !== null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOver !== i) setDragOver(i); } }}
              onDrop={(e) => { const from = dragFromRef.current; if (from !== null) { e.preventDefault(); dragFromRef.current = null; setDragOver(null); move(from, i, id); } }}
            >
              <div className="wc-list__bar">
                {!reorderLocked && (
                  // A <span role="button">, not a <button>: Chromium will not start an HTML5 drag from a
                  // <button> (mousedown lands on its child and no `dragstart` ever fires — measured).
                  <span
                    role="button"
                    tabIndex={0}
                    ref={(el) => { handleRefs.current.set(id, el); }}
                    className="wc-list__handle"
                    draggable
                    aria-label={`Reorder ${rowTitle(row, i)}, position ${i + 1} of ${items.length}`}
                    aria-describedby={helpId}
                    aria-pressed={isGrabbed}
                    onKeyDown={(e) => onHandleKey(e, i, id)}
                    onBlur={() => { if (isGrabbed) setGrabbed(null); }}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                      const li = rowRefs.current.get(id);
                      if (li) e.dataTransfer.setDragImage(li, 16, 16);
                      dragFromRef.current = i;
                    }}
                    onDragEnd={() => { dragFromRef.current = null; setDragOver(null); }}
                  >
                    <span aria-hidden="true">⠿</span>
                  </span>
                )}
                <span className="wc-list__title">{rowTitle(row, i)}</span>
                {!structureLocked && (
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Remove ${rowTitle(row, i)}`} onClick={() => remove(i)}>Remove</button>
                )}
              </div>
              <div className="wc-list__body">
                {def.primitive === "group" ? (
                  <FieldEditor
                    defs={def.fields ?? []}
                    value={asRecord(row)}
                    onChange={(next) => { const n = items.slice(); n[i] = next; onValue(n); }}
                    ctx={ctx}
                    segments={[...segments, i]}
                    inheritedLock={lock ?? inheritedLock}
                  />
                ) : (
                  <ScalarItem def={def} value={row} onValue={(v) => { const n = items.slice(); n[i] = v; onValue(n); }} locked={lock !== null} pointer={fieldPointer(...segments, i)} label={`${label} ${i + 1}`} issues={ctx.issues} placeholders={ctx.placeholders} />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {items.length === 0 && <p className="lux-field__hint">No items yet.</p>}
      {!structureLocked && (
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm wc-list__add" onClick={add}>Add {def.primitive === "group" ? "item" : label.toLowerCase()}</button>
      )}
      <div className="wc-sr" role="status" aria-live="polite">{announce}</div>
    </fieldset>
  );
}

function ScalarItem({ def, value, onValue, locked, pointer, label, issues, placeholders }: {
  def: FieldDef; value: unknown; onValue: (v: unknown) => void; locked: boolean; pointer: string; label: string; issues: Issue[]; placeholders?: PlaceholderSyntax[];
}): ReactNode {
  const id = useId();
  const errs = issuesAt(issues, pointer);
  const errId = `${id}-err`;
  return (
    <div className="wc-field">
      <ScalarControl id={id} def={def} value={value} onValue={onValue} locked={locked} pointer={pointer} describedBy={errs.length ? errId : undefined} invalid={errs.length > 0} label={label} placeholders={placeholders} />
      <Errors id={errId} issues={errs} />
    </div>
  );
}
