"use client";
// SCP-5 W5-C5 (BFF §63.30.1, §63.28.1) — the Audit scorecard section of the company rules: the dimensions (1 to 20, each with a weight 0 to 10, where its score comes from, and the advice shown when it scores low),
// the bands (2 to 5, highest first, the last from 0), and the benchmark an engagement rate is read against. The automatic computations are code: a dimension can pick one of the six, each by one dimension at most.
// An audit already started keeps the scorecard it was made with; the next ones take these. The preview scores a chosen client under the unsaved scorecard and saves nothing.
import { useState } from "react";
import { Group, NumberField, SelectField, TextField } from "@/components/social/RulesFields";
import { ItemButtons } from "@/components/social/RulesList";
import { RulesPanel } from "@/components/social/RulesPanel";
import { RulesPreviewBox, type ClientChoice } from "@/components/social/RulesPreview";
import {
  AUDIT_AUTO_SOURCES, AUDIT_SOURCE_LABEL, moveItem, newBand, newDimension, type AuditBand, type AuditDimension, type AuditRules, type AuditSource, type RulesAnswer,
} from "@/lib/socialRules";

const SOURCES: AuditSource[] = ["typed", ...AUDIT_AUTO_SOURCES];

function DimensionEditor({ i, d, def, count, takenSources, onChange, onMove, onRemove }: {
  i: number; d: AuditDimension; def: AuditDimension | undefined; count: number; takenSources: AuditSource[]; onChange: (d: AuditDimension) => void; onMove: (x: -1 | 1) => void; onRemove: () => void;
}) {
  const p = `audit.dimensions.${i}`;
  return (
    <li className="rules__item" aria-label={`Dimension ${i + 1}: ${d.label}`}>
      <div className="rules__item-head">
        <h5 className="rules__item-title">Dimension {i + 1}</h5>
        <ItemButtons label={`dimension ${i + 1}, ${d.label}`} index={i} count={count} onMove={onMove} onRemove={onRemove} removeDisabled={count <= 1} removeHint="A scorecard keeps at least one dimension." />
      </div>
      <div className="rules__row">
        <TextField path={`${p}.label`} label="Name" value={d.label} maxLength={80} wide onChange={(label) => onChange({ ...d, label })} def={def?.label} />
        <NumberField path={`${p}.weight`} label="Weight" value={d.weight} min={0} max={10} step={0.01} onChange={(weight) => onChange({ ...d, weight })} def={def ? String(def.weight) : undefined}
          hint="0 to 10, at most two decimals. 0 leaves it out of the score." />
        <SelectField
          path={`${p}.source`} label="Where its score comes from" value={d.source} wide
          options={SOURCES.map((s) => ({ value: s, label: `${AUDIT_SOURCE_LABEL[s]}${s !== "typed" && s !== d.source && takenSources.includes(s) ? " (used by another dimension)" : ""}` }))}
          onChange={(s) => onChange({ ...d, source: s as AuditSource })} def={def ? AUDIT_SOURCE_LABEL[def.source] : undefined}
          hint="An automatic source can be used by one dimension only."
        />
      </div>
      <TextField path={`${p}.advice`} label="Advice shown when it scores low" value={d.advice} multiline maxLength={300} wide onChange={(advice) => onChange({ ...d, advice })} def={def?.advice} />
      {!def && <span className="rules__hint">A dimension of your own: there is no default for it.</span>}
    </li>
  );
}

function BandEditor({ i, b, def, count, onChange, onMove, onRemove }: {
  i: number; b: AuditBand; def: AuditBand | undefined; count: number; onChange: (b: AuditBand) => void; onMove: (x: -1 | 1) => void; onRemove: () => void;
}) {
  const p = `audit.bands.${i}`;
  return (
    <li className="rules__item" aria-label={`Band ${i + 1}: ${b.label}`}>
      <div className="rules__item-head">
        <h5 className="rules__item-title">Band {i + 1}</h5>
        <ItemButtons label={`band ${i + 1}, ${b.label}`} index={i} count={count} onMove={onMove} onRemove={onRemove} removeDisabled={count <= 2} removeHint="A scorecard keeps at least two bands." />
      </div>
      <div className="rules__row">
        <TextField path={`${p}.label`} label="Name" value={b.label} maxLength={60} wide onChange={(label) => onChange({ ...b, label })} def={def?.label} />
        <NumberField path={`${p}.from`} label="From a score of" value={b.from} min={0} max={100} onChange={(from) => onChange({ ...b, from })} def={def ? String(def.from) : undefined} hint="0 to 100 out of 100." />
      </div>
    </li>
  );
}

function BenchmarkEditor({ value, def, onChange }: { value: AuditRules["benchmark"]; def: AuditRules["benchmark"]; onChange: (b: AuditRules["benchmark"]) => void }) {
  const typed = value.source === "typed";
  return (
    <Group path="audit.benchmark" legend="The benchmark an engagement rate is read against">
      <SelectField
        path="audit.benchmark.source" label="Benchmark" value={value.source}
        options={[{ value: "own_clients_median", label: "The median of our own clients" }, { value: "typed", label: "Rates I type for each business type" }]}
        onChange={(s) => onChange(s === "typed" ? { source: "typed", rates: { General: 0.03 } } : { source: "own_clients_median" })}
        def={def.source === "typed" ? "Typed rates" : "The median of our own clients"}
      />
      {value.source === "typed" && (
        <>
          <ul className="rules__items">
            {Object.entries(value.rates).map(([type, rate]) => (
              <li key={type} className="rules__item" aria-label={`Rate for ${type}`}>
                <div className="rules__row">
                  <NumberField path={`audit.benchmark.rates.${type}`} label={`${type}: engagement rate`} value={rate} min={0} max={1} step={0.001}
                    onChange={(n) => onChange({ source: "typed", rates: { ...value.rates, [type]: n } })} hint="A fraction from 0 to 1, such as 0.03 for 3 percent." />
                  <div className="rules__buttons">
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={Object.keys(value.rates).length <= 1} aria-label={`Remove the rate for ${type}`}
                      onClick={() => onChange({ source: "typed", rates: Object.fromEntries(Object.entries(value.rates).filter(([t]) => t !== type)) })}>Remove</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <AddType taken={Object.keys(value.rates)} onAdd={(t) => onChange({ source: "typed", rates: { ...value.rates, [t]: 0.03 } })} />
        </>
      )}
      {!typed && <span className="rules__hint">Each client is compared with the median engagement rate of the company&rsquo;s own clients of the same business type.</span>}
    </Group>
  );
}

function AddType({ taken, onAdd }: { taken: string[]; onAdd: (t: string) => void }) {
  const [name, setName] = useState("");
  const t = name.trim();
  const dupe = taken.includes(t);
  return (
    <div className="rules__row">
      <div className="rules__field">
        <label htmlFor="rules-add-type">Add a business type</label>
        <input id="rules-add-type" className="scp-input" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-describedby="rules-add-type-hint" />
        <span className="rules__hint" id="rules-add-type-hint">{dupe ? "That business type already has a rate." : "Named as it is on the client, such as Restaurant. The rate starts at 0.03."}</span>
      </div>
      <div className="rules__buttons">
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={t === "" || dupe} onClick={() => { onAdd(t); setName(""); }}>Add the business type</button>
      </div>
    </div>
  );
}

export function RulesAudit({ answer, clients }: { answer: RulesAnswer; clients: ClientChoice[] | null }) {
  return (
    <section aria-labelledby="rules-group-audit" className="scp-slot" data-slot="rules-audit">
      <h3 className="scp-slot__title" id="rules-group-audit">Audit scorecard</h3>
      <p className="scp-note" style={{ marginTop: 0, marginBottom: 12 }}>
        How a client&rsquo;s social audit is scored: the dimensions and their weights, the bands, and the benchmark. An audit already started keeps the scorecard it was made with; the next ones take these. The six automatic
        computations are fixed in code; a dimension picks one of them or is typed by the person scoring.
      </p>
      <div className="rules">
        <RulesPanel
          section="audit" title="Scorecard" answer={answer}
          intro="Each dimension is scored 0 to 5; the overall score is out of 100 and falls in one band."
          preview={({ draft }) => (
            <RulesPreviewBox
              section="audit" value={draft} clients={clients} clientRequired title="A client's score under this scorecard" button="Preview a client's score"
              render={(p) => (p.audit ? (
                <>
                  <p className="scp-msg scp-msg--ok" style={{ margin: 0 }} role="status">
                    {p.audit.overall === null
                      ? `Nothing is scored yet under this scorecard (${p.audit.scored} of ${p.audit.total} dimensions have a score).`
                      : `Score ${p.audit.overall} out of 100${p.audit.bandLabel ? `, band: ${p.audit.bandLabel}` : ""}. ${p.audit.scored} of ${p.audit.total} dimensions are scored.`}
                  </p>
                  <table className="rules__table">
                    <caption className="rules__sr">Each dimension&rsquo;s score under the unsaved scorecard</caption>
                    <thead><tr><th scope="col">Dimension</th><th scope="col">Weight</th><th scope="col">Score (of 5)</th></tr></thead>
                    <tbody>
                      {p.audit.dimensions.map((d) => <tr key={d.key}><th scope="row">{d.label}</th><td>{d.weight}</td><td>{d.used === null ? "Not scored" : d.used}</td></tr>)}
                    </tbody>
                  </table>
                  <p className="scp-note" style={{ margin: 0 }}>Typed scores come from the client&rsquo;s open draft audit, if it has one; the automatic ones from the last full month{p.audit.month ? ` (${p.audit.month})` : ""}.</p>
                </>
              ) : (
                <p className="scp-note" role="status" style={{ margin: 0 }}>A score cannot be previewed for this client right now.</p>
              ))}
            />
          )}
        >
          {({ draft, setDraft, defaults }) => {
            const dims = draft.dimensions;
            const bands = draft.bands;
            const setDims = (dimensions: AuditDimension[]) => setDraft({ ...draft, dimensions });
            const setBands = (b: AuditBand[]) => setDraft({ ...draft, bands: b });
            return (
              <>
                <Group path="audit.dimensions" legend={`Dimensions (${dims.length} of 20)`}>
                  <ol className="rules__items">
                    {dims.map((d, i) => (
                      <DimensionEditor
                        key={d.key} i={i} d={d} def={defaults.dimensions.find((x) => x.key === d.key)} count={dims.length} takenSources={dims.filter((_, j) => j !== i).map((x) => x.source)}
                        onChange={(next) => setDims(dims.map((x, j) => (j === i ? next : x)))} onMove={(x) => setDims(moveItem(dims, i, x))} onRemove={() => setDims(dims.filter((_, j) => j !== i))}
                      />
                    ))}
                  </ol>
                  <div className="rules__buttons">
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={dims.length >= 20} onClick={() => setDims([...dims, newDimension(dims.map((x) => x.key))])}>Add a dimension</button>
                  </div>
                </Group>
                <Group path="audit.bands" legend={`Bands (${bands.length} of 5)`} hint="Highest first. Each band starts lower than the one above it, and the last one starts at 0, so every score has exactly one band.">
                  <ol className="rules__items">
                    {bands.map((b, i) => (
                      <BandEditor
                        key={b.key} i={i} b={b} def={defaults.bands.find((x) => x.key === b.key)} count={bands.length}
                        onChange={(next) => setBands(bands.map((x, j) => (j === i ? next : x)))} onMove={(x) => setBands(moveItem(bands, i, x))} onRemove={() => setBands(bands.filter((_, j) => j !== i))}
                      />
                    ))}
                  </ol>
                  <div className="rules__buttons">
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={bands.length >= 5} onClick={() => setBands([...bands, newBand(bands.map((x) => x.key))])}>Add a band</button>
                  </div>
                </Group>
                <BenchmarkEditor value={draft.benchmark} def={defaults.benchmark} onChange={(benchmark) => setDraft({ ...draft, benchmark })} />
              </>
            );
          }}
        </RulesPanel>
      </div>
    </section>
  );
}
