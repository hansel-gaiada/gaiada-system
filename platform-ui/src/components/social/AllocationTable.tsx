"use client";
// SCP-1a — the Allocation list (BFF §63.4): every client with its officer, creative source, target, report format and day, delivery batch,
// platforms, formats, default time, and this cycle's counts against the target; and the way into the client's brand book.
//
// WHO EDITS. Editing is `social_engagement` · `plan`, the four Social approvers' alone (the HoD and GM seats, the owner, the superadmin). The server
// says so per row (`canPlan`); everyone else reads the same list with every control DISABLED and the reason in words under the table
// (`aria-describedby`) and as the save button's `title`. The server's 403 `not_a_social_approver` is the boundary; this is the hint.
//
// SAVING is per client and sends only what changed (`PATCH engagements/:engagementId/allocation`); the answer is the row as the server now holds it
// (this cycle's counts included), so what is drawn after a save is what was stored. The officer picker lists the company's members; the server
// refuses anyone who is not an active employee member (409 `officer_not_member`) and the refusal is shown in words.
import { useId, useMemo, useState, useTransition } from "react";
import { saveAllocation } from "@/lib/socialAllocationActions";
import {
  ALLOCATION_FORMATS, ALLOCATION_NETWORKS, CREATIVE_SOURCE_LABEL, FORMAT_LABEL, NETWORK_LABEL, REPORT_FORMAT_LABEL, cycleCountsText,
  type AllocationPatch, type AllocationRow, type CreativeSource, type ReportFormat,
} from "@/lib/socialAllocation";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import { Drawer } from "@/components/overlay/Drawer";
import { BrandBookForm } from "./BrandBookForm";
import "./cycles.css";
import "./allocation.css";

export interface OfficerOption { id: string; name: string }

export interface AllocationDraft {
  officer: string;
  target: string;
  source: CreativeSource;
  batch: "" | "A" | "B";
  reportFormat: "" | ReportFormat;
  reportDay: string;
  platforms: string[];
  formats: string[];
  time: string;
}

const draftOf = (r: AllocationRow): AllocationDraft => ({
  officer: r.officer?.id ?? "",
  target: r.postsPerCycle === null ? "" : String(r.postsPerCycle),
  source: r.creativeSource,
  batch: r.deliveryBatch ?? "",
  reportFormat: r.reportFormat ?? "",
  reportDay: r.reportDueDay === null ? "" : String(r.reportDueDay),
  platforms: [...r.platforms],
  formats: [...r.formats],
  time: r.defaultPostTime ?? "",
});

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** A whole number from `lo` to `hi`, or null for an empty box; `undefined` when the text is not one. */
function intOrNull(text: string, lo: number, hi: number): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
}

/** The patch that turns `row` into `draft`, or the field and words of the first value outside its rule. */
export function buildAllocationPatch(row: AllocationRow, d: AllocationDraft): { ok: true; patch: AllocationPatch } | { ok: false; message: string } {
  const patch: AllocationPatch = {};
  if (d.officer !== (row.officer?.id ?? "")) patch.officerId = d.officer === "" ? null : d.officer;
  const target = intOrNull(d.target, 0, 200);
  if (target === undefined) return { ok: false, message: "The target is a whole number of posts from 0 to 200." };
  if (target !== row.postsPerCycle) patch.postsPerCycle = target;
  if (d.source !== row.creativeSource) patch.creativeSource = d.source;
  if ((d.batch || null) !== row.deliveryBatch) patch.deliveryBatch = d.batch || null;
  if ((d.reportFormat || null) !== row.reportFormat) patch.reportFormat = d.reportFormat || null;
  const day = intOrNull(d.reportDay, 1, 31);
  if (day === undefined) return { ok: false, message: "The report day is a day of the month from 1 to 31." };
  if (day !== row.reportDueDay) patch.reportDueDay = day;
  if (!sameSet(d.platforms, row.platforms)) patch.platforms = d.platforms;
  if (!sameSet(d.formats, row.formats)) patch.formats = d.formats;
  if (d.time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) return { ok: false, message: "The default time is a time of day, such as 09:30." };
  if ((d.time || null) !== row.defaultPostTime) patch.defaultPostTime = d.time || null;
  return { ok: true, patch };
}

function AllocationRowView({
  row, officers, reasonId, onSaved, onBrandBook,
}: {
  row: AllocationRow; officers: OfficerOption[]; reasonId: string; onSaved: (r: AllocationRow) => void; onBrandBook: (r: AllocationRow) => void;
}) {
  const [draft, setDraft] = useState<AllocationDraft>(() => draftOf(row));
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const locked = !row.canPlan;
  const dis = locked || pending;
  const built = buildAllocationPatch(row, draft);
  const dirty = built.ok ? Object.keys(built.patch).length > 0 : true;
  const name = row.clientName;
  const set = <K extends keyof AllocationDraft>(k: K, v: AllocationDraft[K]) => { setDraft((d) => ({ ...d, [k]: v })); setMsg(null); };
  const toggle = (k: "platforms" | "formats", v: string) =>
    set(k, draft[k].includes(v) ? draft[k].filter((x) => x !== v) : [...draft[k], v]);
  const counts = cycleCountsText(row);

  function save() {
    if (!built.ok) { setMsg({ kind: "error", text: built.message }); return; }
    setMsg(null);
    startTransition(async () => {
      const res = await saveAllocation(row.engagementId, built.patch);
      if (!res.ok) { setMsg({ kind: "error", text: res.message }); return; }
      setDraft(draftOf(res.row));
      setMsg({ kind: "ok", text: "Saved." });
      onSaved(res.row);
    });
  }

  const describedBy = locked ? reasonId : undefined;
  return (
    <tr>
      <td>
        <span className="scp-table__client">{name}</span>
        <span className="scp-alloc__status">{row.status}</span>
      </td>
      <td>
        <select className="scp-input scp-alloc__select" aria-label={`Officer for ${name}`} value={draft.officer} onChange={(e) => set("officer", e.target.value)} disabled={dis} aria-describedby={describedBy}>
          <option value="">No officer</option>
          {officers.map((o) => <option key={o.id} value={o.id}>{o.name || "Unnamed member"}</option>)}
        </select>
      </td>
      <td>
        <select className="scp-input" aria-label={`Creative source for ${name}`} value={draft.source} onChange={(e) => set("source", e.target.value as CreativeSource)} disabled={dis} aria-describedby={describedBy}>
          {(Object.keys(CREATIVE_SOURCE_LABEL) as CreativeSource[]).map((k) => <option key={k} value={k}>{CREATIVE_SOURCE_LABEL[k]}</option>)}
        </select>
      </td>
      <td>
        <input className="scp-input scp-input--narrow" type="number" inputMode="numeric" min={0} max={200} step={1} aria-label={`Posts per cycle for ${name}`} value={draft.target} onChange={(e) => set("target", e.target.value)} disabled={dis} aria-describedby={describedBy} />
      </td>
      <td>
        <span className="scp-alloc__pair">
          <select className="scp-input" aria-label={`Report format for ${name}`} value={draft.reportFormat} onChange={(e) => set("reportFormat", e.target.value as "" | ReportFormat)} disabled={dis} aria-describedby={describedBy}>
            <option value="">Not set</option>
            {(Object.keys(REPORT_FORMAT_LABEL) as ReportFormat[]).map((k) => <option key={k} value={k}>{REPORT_FORMAT_LABEL[k]}</option>)}
          </select>
          <input className="scp-input scp-input--narrow" type="number" inputMode="numeric" min={1} max={31} step={1} aria-label={`Report day of the month for ${name}`} placeholder="Day" value={draft.reportDay} onChange={(e) => set("reportDay", e.target.value)} disabled={dis} aria-describedby={describedBy} />
        </span>
      </td>
      <td>
        <select className="scp-input scp-input--narrow" aria-label={`Delivery batch for ${name}`} value={draft.batch} onChange={(e) => set("batch", e.target.value as "" | "A" | "B")} disabled={dis} aria-describedby={describedBy}>
          <option value="">None</option>
          <option value="A">A</option>
          <option value="B">B</option>
        </select>
      </td>
      <td>
        <fieldset className="scp-alloc__checks" disabled={dis}>
          <legend className="scp-sr-only">Platforms for {name}</legend>
          {ALLOCATION_NETWORKS.map((n) => (
            <label key={n} className="scp-alloc__check">
              <input type="checkbox" checked={draft.platforms.includes(n)} onChange={() => toggle("platforms", n)} aria-describedby={describedBy} />
              {NETWORK_LABEL[n]}
            </label>
          ))}
        </fieldset>
      </td>
      <td>
        <fieldset className="scp-alloc__checks" disabled={dis}>
          <legend className="scp-sr-only">Formats for {name}</legend>
          {ALLOCATION_FORMATS.map((f) => (
            <label key={f} className="scp-alloc__check">
              <input type="checkbox" checked={draft.formats.includes(f)} onChange={() => toggle("formats", f)} aria-describedby={describedBy} />
              {FORMAT_LABEL[f]}
            </label>
          ))}
        </fieldset>
      </td>
      <td>
        <input className="scp-input" type="time" aria-label={`Default posting time for ${name}`} value={draft.time} onChange={(e) => set("time", e.target.value)} disabled={dis} aria-describedby={describedBy} />
      </td>
      <td className="scp-alloc__counts">
        {counts
          ? <>{counts.main}{counts.beside && <span className="scp-table__sub">+ {counts.beside}</span>}</>
          : <span className="scp-table__sub">No cycle this month</span>}
      </td>
      <td>
        <span className="scp-alloc__rowactions">
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={save} disabled={dis || !dirty} title={locked ? PLAN_REFUSAL_REASON : undefined} aria-describedby={describedBy} aria-label={`Save allocation for ${name}`}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button type="button" className="scp-link" onClick={() => onBrandBook(row)} aria-label={`Open the brand book of ${name}`}>Brand book</button>
          {msg && <span className={`scp-alloc__rowmsg scp-msg--${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</span>}
        </span>
      </td>
    </tr>
  );
}

export function AllocationTable({
  rows, officers, canEditBrandBook, month,
}: {
  rows: AllocationRow[];
  /** The company's members, for the officer picker. */
  officers: OfficerOption[];
  /** The page's hint that the caller may change a brand book (the server's `update`). */
  canEditBrandBook: boolean;
  /** `YYYY-MM` the counts belong to. */
  month: string;
}) {
  const reasonId = useId();
  const [current, setCurrent] = useState<AllocationRow[]>(rows);
  const [book, setBook] = useState<AllocationRow | null>(null);
  const anyLocked = current.some((r) => !r.canPlan);

  // The picker also lists an officer who is no longer in the member list, so the current choice is never lost from the box.
  const optionsFor = useMemo(() => (row: AllocationRow): OfficerOption[] => {
    const list = [...officers];
    if (row.officer && !list.some((o) => o.id === row.officer!.id)) list.push({ id: row.officer.id, name: row.officer.name });
    return list;
  }, [officers]);

  if (current.length === 0) return <p className="scp-note">No client has an open engagement yet, so there is nothing to allocate.</p>;

  return (
    <div>
      <div className="scp-tablewrap">
        <table className="scp-table">
          <caption>Each client&rsquo;s allocation. The counts are this cycle ({month}) against the target.</caption>
          <thead>
            <tr>
              <th scope="col">Client</th>
              <th scope="col">Officer</th>
              <th scope="col">Creative source</th>
              <th scope="col">Target</th>
              <th scope="col">Report</th>
              <th scope="col">Batch</th>
              <th scope="col">Platforms</th>
              <th scope="col">Formats</th>
              <th scope="col">Default time</th>
              <th scope="col">This cycle</th>
              <th scope="col"><span className="scp-sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {current.map((r) => (
              <AllocationRowView
                key={r.engagementId}
                row={r} officers={optionsFor(r)} reasonId={reasonId}
                onSaved={(next) => setCurrent((all) => all.map((x) => (x.engagementId === next.engagementId ? next : x)))}
                onBrandBook={setBook}
              />
            ))}
          </tbody>
        </table>
      </div>
      {anyLocked && <p className="scp-note scp-note--reason" id={reasonId}>{PLAN_REFUSAL_REASON}</p>}

      <Drawer open={book !== null} onClose={() => setBook(null)} title={book ? `Brand book: ${book.clientName}` : undefined}>
        {book && <BrandBookForm key={book.clientId} clientId={book.clientId} clientName={book.clientName} canEdit={canEditBrandBook} />}
      </Drawer>
    </div>
  );
}
