"use client";
// SCP-5 W5-C5 (BFF §63.30.1, §63.26) — the Saved section of the company rules: the categories of each client's content bank. A company may add up to 12 of its own (each holds files, links or text), rename, reorder
// or hide any, and remove its own. Photos, posts and hashtags are read from elsewhere: they can be renamed, moved or hidden, never removed, and what they hold is fixed. A hidden category leaves the menu and keeps
// its items; the items of a removed one show under "Other". There is no preview: nothing here changes a date or a score.
import { Group, TextField, ToggleField } from "@/components/social/RulesFields";
import { ItemButtons } from "@/components/social/RulesList";
import { RulesPanel } from "@/components/social/RulesPanel";
import { DERIVED_SAVED_CATEGORIES, SAVED_HOLDS, SAVED_HOLDS_LABEL, moveItem, newCategory, type RulesAnswer, type SavedCategory, type SavedHolds } from "@/lib/socialRules";

const holdsWords = (h: SavedHolds[]): string => (h.length === 0 ? "what it reads from elsewhere" : h.map((x) => SAVED_HOLDS_LABEL[x].toLowerCase()).join(" and "));
const onOff = (b: boolean): string => (b ? "shown" : "hidden");

function CategoryEditor({ i, c, def, count, onChange, onMove, onRemove }: {
  i: number; c: SavedCategory; def: SavedCategory | undefined; count: number; onChange: (c: SavedCategory) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  const p = `saved.categories.${i}`;
  const derived = DERIVED_SAVED_CATEGORIES[c.key];
  return (
    <li className="rules__item" aria-label={`Category ${i + 1}: ${c.label}`}>
      <div className="rules__item-head">
        <h5 className="rules__item-title">Category {i + 1}</h5>
        <ItemButtons label={`category ${i + 1}, ${c.label}`} index={i} count={count} onMove={onMove} onRemove={onRemove} removeDisabled={!!derived} removeHint="This category is read from elsewhere, so it can be hidden but not removed." />
      </div>
      <TextField path={`${p}.label`} label="Name" value={c.label} maxLength={60} wide onChange={(label) => onChange({ ...c, label })} def={def?.label} />
      {derived
        ? <span className="rules__hint">Holds {holdsWords(c.holds)}, and that is fixed. {derived} It can be renamed, moved or hidden, not removed.</span>
        : (
          <Group path={`${p}.holds`} legend="What it holds" hint="A category must hold something.">
            {SAVED_HOLDS.map((h) => (
              <ToggleField
                key={h} path={`${p}.holds.${h}`} label={SAVED_HOLDS_LABEL[h]} checked={c.holds.includes(h)}
                onChange={(b) => onChange({ ...c, holds: SAVED_HOLDS.filter((x) => (x === h ? b : c.holds.includes(x))) })}
              />
            ))}
            {def && <span className="rules__hint">Default: {holdsWords(def.holds)}.</span>}
          </Group>
        )}
      <ToggleField path={`${p}.enabled`} label="Show this category in the menu" checked={c.enabled} onChange={(enabled) => onChange({ ...c, enabled })} def={def ? onOff(def.enabled) : undefined}
        hint="Hidden, it leaves the menu and keeps its items." />
      {!def && <span className="rules__hint">A category of your own: there is no default for it.</span>}
    </li>
  );
}

export function RulesSaved({ answer }: { answer: RulesAnswer }) {
  return (
    <section aria-labelledby="rules-group-saved" className="scp-slot" data-slot="rules-saved">
      <h3 className="scp-slot__title" id="rules-group-saved">Saved</h3>
      <p className="scp-note" style={{ marginTop: 0, marginBottom: 12 }}>
        The categories of each client&rsquo;s content bank. A hidden category leaves the menu and keeps its items; the items of a category you remove show under &ldquo;Other&rdquo;.
      </p>
      <div className="rules">
        <RulesPanel section="saved" title="Saved categories" answer={answer} intro="Up to 12 categories of your own, besides photos, posts and hashtags, which are read from elsewhere.">
          {({ draft, setDraft, defaults }) => {
            const cats = draft.categories;
            const own = cats.filter((c) => !DERIVED_SAVED_CATEGORIES[c.key]).length;
            const set = (categories: SavedCategory[]) => setDraft({ categories });
            return (
              <Group path="saved.categories" legend={`Categories (${own} of your own, up to 12)`}>
                <ol className="rules__items">
                  {cats.map((c, i) => (
                    <CategoryEditor
                      key={c.key} i={i} c={c} def={defaults.categories.find((d) => d.key === c.key)} count={cats.length}
                      onChange={(next) => set(cats.map((x, j) => (j === i ? next : x)))} onMove={(d) => set(moveItem(cats, i, d))} onRemove={() => set(cats.filter((_, j) => j !== i))}
                    />
                  ))}
                </ol>
                <div className="rules__buttons">
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={own >= 12} onClick={() => set([...cats, newCategory(cats.map((x) => x.key))])}>Add a category</button>
                </div>
              </Group>
            );
          }}
        </RulesPanel>
      </div>
    </section>
  );
}
