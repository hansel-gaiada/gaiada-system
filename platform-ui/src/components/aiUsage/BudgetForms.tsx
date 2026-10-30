"use client";
import { useId, useState, type FormEvent } from "react";
import { liftStopAction, setAllowanceAction, setCompanyBudgetAction, setUnitBudgetAction, type BudgetActionResult } from "@/lib/aiBudgetActions";
import {
  BUDGET_MODE_HELP, LIFT_BUTTON, LIFT_WARNING, budgetModeLabel, checkDailyReplies, checkMonthlyUsd,
  type BudgetMode, type UnitBudgetLine,
} from "@/lib/aiBudget";
import { formatCount } from "@/lib/aiUsage";
import "@/components/forms/forms.css";
import "./aiUsage.css";

// AIP-17b and AIP-18 (BFF §66.9, §66.11): the owner's edit forms and the lift button. They are only RENDERED for a person the answer says may use them
// (`capabilities.canManage`, `capabilities.canLiftStop`: a mirror, advisory); the server decides every write, and its refusal is said in words
// next to the control that produced it. The money is checked the way the server checks it before the round trip, and the server's answer always counts.
// A field is never reset by a refusal: what was typed stays until a write succeeds. After a write the action revalidates the page, so every line on it
// is the server's own new figure, never one composed here.

/** One write at a time: `pending`, the refusal in words, and a short status said politely once a write has gone through. */
function useWrite() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const run = async (write: () => Promise<BudgetActionResult>, done: string): Promise<boolean> => {
    setError(null);
    setStatus("");
    setPending(true);
    try {
      const r = await write();
      if (r.ok) {
        setStatus(r.changed ? done : "Nothing changed.");
        return true;
      }
      setError(r.error);
      return false;
    } catch {
      setError("That could not be saved just now. Try again.");
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, status, run, setError };
}

function Result({ error, status, id }: { error: string | null; status: string; id: string }) {
  return (
    <>
      {error && <span id={id} role="alert" className="aiu-msg aiu-msg--bad">{error}</span>}
      <span role="status" aria-live="polite" className="aiu-msg aiu-msg--ok">{status}</span>
    </>
  );
}

function ModeSelect({ value, onChange, disabled, id }: { value: BudgetMode; onChange: (m: BudgetMode) => void; disabled: boolean; id: string }) {
  return (
    <div className="lux-field">
      <label className="lux-field__label" htmlFor={id}>When it reaches the figure</label>
      <span className="lux-field__selectwrap">
        <select id={id} className="lux-field__control" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as BudgetMode)} aria-describedby={`${id}-help`}>
          <option value="report">{budgetModeLabel("report")}</option>
          <option value="soft_stop">{budgetModeLabel("soft_stop")}</option>
        </select>
      </span>
      <span id={`${id}-help`} className="lux-field__hint">{BUDGET_MODE_HELP[value]}</span>
    </div>
  );
}

function FigureField({ value, onChange, disabled, id, label, error, errId }: {
  value: string; onChange: (v: string) => void; disabled: boolean; id: string; label: string; error: string | null; errId: string;
}) {
  return (
    <label className="lux-field" htmlFor={id}>
      <span className="lux-field__label">{label}</span>
      <input
        id={id} name="monthlyUsd" type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined}
        className={`lux-field__control${error ? " lux-field__control--error" : ""}`}
      />
    </label>
  );
}

/** The company's alert figure (AIP-D8): set, change or remove. No mode: the company figure only ever tells. */
export function CompanyBudgetForm({ line }: { line: { monthlyUsd: string } | null }) {
  const uid = useId();
  const [figure, setFigure] = useState(line?.monthlyUsd ?? "");
  const w = useWrite();
  const checked = checkMonthlyUsd(figure);
  const figureError = figure.trim() !== "" && !checked.ok ? checked.error : null;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!checked.ok || w.pending) return;
    void w.run(() => setCompanyBudgetAction(checked.value), "Saved.");
  };
  return (
    <form onSubmit={onSubmit} className="aiu-form" aria-label="Company alert figure">
      <FigureField id={`${uid}-f`} errId={`${uid}-fe`} label="Monthly alert figure (US dollars)" value={figure} onChange={setFigure} disabled={w.pending} error={figureError} />
      {figureError && <span id={`${uid}-fe`} className="lux-field__error">{figureError}</span>}
      <div className="aiu-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={w.pending || !checked.ok}>{w.pending ? "Saving…" : line ? "Change" : "Set the figure"}</button>
        {line && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={w.pending}
            onClick={() => void w.run(() => setCompanyBudgetAction(null), "Removed.").then((ok) => { if (ok) setFigure(""); })}>
            Remove
          </button>
        )}
        <Result id={`${uid}-err`} error={w.error} status={w.status} />
      </div>
    </form>
  );
}

/** One department's budget: figure and mode, change or remove. A new budget is Report only (AIP-D7). */
export function UnitBudgetForm({ unitNodeId, line, label }: { unitNodeId: string; line: Pick<UnitBudgetLine, "monthlyUsd" | "mode"> | null; label: string }) {
  const uid = useId();
  const [figure, setFigure] = useState(line?.monthlyUsd ?? "");
  const [mode, setMode] = useState<BudgetMode>(line?.mode ?? "report");
  const w = useWrite();
  const checked = checkMonthlyUsd(figure);
  const figureError = figure.trim() !== "" && !checked.ok ? checked.error : null;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!checked.ok || w.pending) return;
    void w.run(() => setUnitBudgetAction(unitNodeId, checked.value, mode), "Saved.");
  };
  return (
    <form onSubmit={onSubmit} className="aiu-form" aria-label={`${label} budget`}>
      <div className="aiu-form__row">
        <FigureField id={`${uid}-f`} errId={`${uid}-fe`} label="Monthly figure (US dollars)" value={figure} onChange={setFigure} disabled={w.pending} error={figureError} />
        <ModeSelect id={`${uid}-m`} value={mode} onChange={setMode} disabled={w.pending} />
      </div>
      {figureError && <span id={`${uid}-fe`} className="lux-field__error">{figureError}</span>}
      <div className="aiu-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={w.pending || !checked.ok}>{w.pending ? "Saving…" : line ? "Change" : "Set the budget"}</button>
        {line && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={w.pending}
            onClick={() => void w.run(() => setUnitBudgetAction(unitNodeId, null), "Removed.").then((ok) => { if (ok) { setFigure(""); setMode("report"); } })}>
            Remove
          </button>
        )}
        <Result id={`${uid}-err`} error={w.error} status={w.status} />
      </div>
    </form>
  );
}

/** From the company view: a budget for a department that has none yet. */
export function AddUnitBudgetForm({ options }: { options: readonly { value: string; label: string }[] }) {
  const uid = useId();
  const [unit, setUnit] = useState("");
  const [figure, setFigure] = useState("");
  const [mode, setMode] = useState<BudgetMode>("report");
  const w = useWrite();
  const checked = checkMonthlyUsd(figure);
  const figureError = figure.trim() !== "" && !checked.ok ? checked.error : null;
  const ready = unit !== "" && checked.ok;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready || !checked.ok || w.pending) return;
    void w.run(() => setUnitBudgetAction(unit, checked.value, mode), "Saved.").then((ok) => { if (ok) { setUnit(""); setFigure(""); setMode("report"); } });
  };
  if (options.length === 0) return null;
  return (
    <form onSubmit={onSubmit} className="aiu-form" aria-label="Add a department budget">
      <div className="aiu-form__row">
        <div className="lux-field">
          <label className="lux-field__label" htmlFor={`${uid}-u`}>Department</label>
          <span className="lux-field__selectwrap">
            <select id={`${uid}-u`} className="lux-field__control" value={unit} disabled={w.pending} onChange={(e) => setUnit(e.target.value)}>
              <option value="">Choose a department</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </span>
        </div>
        <FigureField id={`${uid}-f`} errId={`${uid}-fe`} label="Monthly figure (US dollars)" value={figure} onChange={setFigure} disabled={w.pending} error={figureError} />
        <ModeSelect id={`${uid}-m`} value={mode} onChange={setMode} disabled={w.pending} />
      </div>
      {figureError && <span id={`${uid}-fe`} className="lux-field__error">{figureError}</span>}
      <div className="aiu-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={w.pending || !ready}>{w.pending ? "Saving…" : "Set the budget"}</button>
        <Result id={`${uid}-err`} error={w.error} status={w.status} />
      </div>
    </form>
  );
}

/** The by-person table's allowance cell: the number with "(default)" when there is no override, and a small form to set or clear one. */
export function AllowanceCell({ userId, name, dailyReplies, isDefault }: { userId: string; name: string; dailyReplies: number; isDefault: boolean }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(dailyReplies));
  const w = useWrite();
  const checked = checkDailyReplies(value);
  const fieldError = value.trim() !== "" && !checked.ok ? checked.error : null;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!checked.ok || w.pending) return;
    void w.run(() => setAllowanceAction(userId, checked.value), "Saved.").then((ok) => { if (ok) setOpen(false); });
  };
  return (
    <span className="aiu-allow">
      <span className="aiu-allow__now">{formatCount(dailyReplies)} a day{isDefault ? <span className="aiu-mark"> (default)</span> : null}</span>
      {!open ? (
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-expanded={false} onClick={() => { setValue(String(dailyReplies)); setOpen(true); }}>
          Change<span className="aiu-sr"> the allowance of {name}</span>
        </button>
      ) : (
        <form onSubmit={onSubmit} className="aiu-allow__form" aria-label={`Daily reply allowance of ${name}`}>
          <label htmlFor={`${uid}-n`} className="aiu-sr">Replies a day for {name}</label>
          <input
            id={`${uid}-n`} type="text" inputMode="numeric" autoComplete="off" value={value} disabled={w.pending} onChange={(e) => setValue(e.target.value)}
            aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? `${uid}-e` : undefined}
            className={`lux-field__control aiu-allow__input${fieldError ? " lux-field__control--error" : ""}`}
          />
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={w.pending || !checked.ok}>{w.pending ? "Saving…" : "Save"}</button>
          {!isDefault && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={w.pending}
              onClick={() => void w.run(() => setAllowanceAction(userId, null), "Back to the default.").then((ok) => { if (ok) setOpen(false); })}>
              Use the default
            </button>
          )}
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={w.pending} onClick={() => { setOpen(false); w.setError(null); }}>Cancel</button>
          {fieldError && <span id={`${uid}-e`} className="lux-field__error">{fieldError}</span>}
        </form>
      )}
      <Result id={`${uid}-err`} error={w.error} status={w.status} />
    </span>
  );
}

/** The company view's override list: clear one (back to the default). */
export function ClearAllowanceButton({ userId, name }: { userId: string; name: string }) {
  const uid = useId();
  const w = useWrite();
  return (
    <span className="aiu-allow">
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={w.pending} onClick={() => void w.run(() => setAllowanceAction(userId, null), "Back to the default.")}>
        {w.pending ? "Clearing…" : "Use the default"}<span className="aiu-sr"> for {name}</span>
      </button>
      <Result id={`${uid}-err`} error={w.error} status={w.status} />
    </span>
  );
}

/** AIP-18: lift a department's soft stop for the rest of the month, behind a confirm step that says what lifting does. */
export function LiftStopButton({ unitNodeId, monthName }: { unitNodeId: string; monthName: string }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const w = useWrite();
  if (!open) {
    return (
      <div className="aiu-actions">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" aria-expanded={false} onClick={() => setOpen(true)}>{LIFT_BUTTON}</button>
        <Result id={`${uid}-err`} error={w.error} status={w.status} />
      </div>
    );
  }
  return (
    <div className="aiu-lift" role="group" aria-labelledby={`${uid}-h`}>
      <p id={`${uid}-h`} className="aiu-note">{LIFT_WARNING} The stop is lifted until the end of {monthName}.</p>
      <div className="aiu-actions">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={w.pending}
          onClick={() => void w.run(() => liftStopAction(unitNodeId), "The stop is lifted for this month.").then((ok) => { if (ok) setOpen(false); })}>
          {w.pending ? "Lifting…" : "Confirm: lift the stop"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={w.pending} onClick={() => { setOpen(false); w.setError(null); }}>Cancel</button>
        <Result id={`${uid}-err`} error={w.error} status={w.status} />
      </div>
    </div>
  );
}
