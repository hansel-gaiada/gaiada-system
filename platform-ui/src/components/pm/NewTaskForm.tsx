"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignable, Milestone, Priority, Template } from "@/lib/pm";
import { RECURRENCE_FREQS, RECURRENCE_LABEL, type RecurrenceFreq } from "@/lib/pmRecurrence";
import { listTaskTemplates, createTaskTemplate, updateTaskTemplate, deleteTaskTemplate } from "@/lib/pmActions";
import type { FieldDef } from "@/lib/entities";
import { Field } from "@/components/forms/Field";
import { CustomFields } from "@/components/forms/CustomFields";
import { Card, Eyebrow } from "@/components/ui";
import { AssigneePicker } from "./AssigneePicker";
import { TemplateManager } from "./TemplateManager";
import "@/components/forms/forms.css";

const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

interface Props {
  assignable: Assignable;
  milestones: Milestone[];
  customFieldDefs?: FieldDef[];
  create: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}

// A picked-value snapshot the uncontrolled `Field`s below reset to — bumping
// `formKey` forces those inputs to remount with fresh `defaultValue`s (the
// same "external reset of an uncontrolled form" trick used nowhere else yet
// in this file, since nothing here previously needed to reprogram the form
// from outside a user's own keystrokes).
interface Prefill { title: string; description: string; priority: Priority; estimateMinutes: number | null }

export function NewTaskForm({ assignable, milestones, customFieldDefs = [], create }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // P2-06 (design spec §8): "Repeats" reveals "Ends" only when a real frequency
  // is picked — same conditional-reveal pattern as AssigneePicker's kind-dependent fields.
  const [repeats, setRepeats] = useState<"" | RecurrenceFreq>("");

  // P3-03: task templates. Fetched client-side via the server action directly
  // (Gantt.tsx already imports pmActions the same way) rather than threaded
  // through as a page prop, so this component works unmodified wherever it's
  // mounted.
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [subtaskInput, setSubtaskInput] = useState("");
  const [tagLabels, setTagLabels] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  function refetchTemplates() {
    listTaskTemplates().then((r) => { if (r.ok) setTemplates(r.templates); });
  }
  useEffect(() => { if (open) refetchTemplates(); }, [open]);

  if (!open) {
    return <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>New task</button>;
  }

  function applyTemplate(id: string) {
    setSelectedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) {
      setPrefill(null);
      setSubtasks([]);
      setTagLabels([]);
    } else {
      setPrefill({
        title: tpl.title,
        description: tpl.description ?? "",
        priority: tpl.priority ?? "normal",
        estimateMinutes: tpl.estimateMinutes ?? null,
      });
      setSubtasks(tpl.subtasks ?? []);
      setTagLabels(tpl.tagLabels ?? []);
    }
    setFormKey((k) => k + 1);
  }

  function addSubtaskChip() {
    const v = subtaskInput.trim();
    if (!v) return;
    setSubtasks((s) => [...s, v]);
    setSubtaskInput("");
  }
  function addTagChip() {
    const v = tagInput.trim();
    if (!v) return;
    setTagLabels((t) => [...t, v]);
    setTagInput("");
  }

  return (
    <Card title="New task" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <label className="lux-field" style={{ minWidth: 220 }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Template</Eyebrow>
          <select className="lux-field__control" value={selectedTemplateId} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">None</option>
            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.title}</option>)}
          </select>
        </label>
        <TemplateManager
          templates={templates}
          update={updateTaskTemplate}
          remove={deleteTaskTemplate}
          onChange={refetchTemplates}
        />
      </div>

      <form
        action={(fd) => startTransition(async () => {
          const r = await create(fd);
          if (r.ok) {
            setMsg(null);
            setOpen(false);
            setSelectedTemplateId("");
            setPrefill(null);
            setSubtasks([]);
            setTagLabels([]);
            router.refresh();
          } else setMsg(r.error ?? "Couldn't create task.");
        })}
        className="lux-form-grid"
      >
        <Field key={`title-${formKey}`} name="title" label="Title" required defaultValue={prefill?.title} />
        <Field key={`priority-${formKey}`} name="priority" label="Priority" type="select" options={PRIORITIES} defaultValue={prefill?.priority} />
        <Field key={`estimate-${formKey}`} name="estimateMinutes" label="Estimate (minutes)" type="number" defaultValue={prefill?.estimateMinutes ?? undefined} />
        <Field name="dueDate" label="Due date" type="date" />
        <label className="lux-field">
          <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.6 }}>Milestone</span>
          <select name="milestoneId" className="lux-field__control" defaultValue="">
            <option value="">None</option>
            {milestones.map((mst) => <option key={mst.id} value={mst.id}>{mst.name}</option>)}
          </select>
        </label>
        <label className="lux-field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Repeats</Eyebrow>
          <select
            name="repeats"
            className="lux-field__control"
            value={repeats}
            onChange={(e) => setRepeats(e.target.value as "" | RecurrenceFreq)}
          >
            <option value="">None</option>
            {RECURRENCE_FREQS.map((f) => <option key={f} value={f}>{RECURRENCE_LABEL[f]}</option>)}
          </select>
        </label>
        {repeats !== "" && (
          <label className="lux-field">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Ends</Eyebrow>
            <input type="date" name="repeatsUntil" className="lux-field__control" />
          </label>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <AssigneePicker assignable={assignable} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field key={`desc-${formKey}`} name="description" label="Description" type="textarea" defaultValue={prefill?.description} />
        </div>

        <div className="lux-field" style={{ gridColumn: "1 / -1" }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Subtasks</Eyebrow>
          {subtasks.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0 8px" }}>
              {subtasks.map((s, i) => (
                <span key={`${s}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "0.5px solid var(--erp-hairline)", padding: "2px 8px", font: "400 12px var(--font-body)" }}>
                  {s}
                  <input type="hidden" name="subtasks" value={s} />
                  <button
                    type="button"
                    aria-label={`Remove subtask ${s}`}
                    onClick={() => setSubtasks((cur) => cur.filter((_, idx) => idx !== i))}
                    style={{ border: 0, background: "none", cursor: "pointer", font: "400 13px var(--font-body)", lineHeight: 1, padding: 0 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="lux-field__control"
              placeholder="Add subtask…"
              aria-label="Add subtask"
              value={subtaskInput}
              onChange={(e) => setSubtaskInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSubtaskChip(); } }}
            />
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={addSubtaskChip}>Add</button>
          </div>
        </div>

        <div className="lux-field" style={{ gridColumn: "1 / -1" }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Tags</Eyebrow>
          {tagLabels.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0 8px" }}>
              {tagLabels.map((t, i) => (
                <span key={`${t}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "0.5px solid var(--erp-hairline)", padding: "2px 8px", font: "400 12px var(--font-body)" }}>
                  {t}
                  <input type="hidden" name="tagLabels" value={t} />
                  <button
                    type="button"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => setTagLabels((cur) => cur.filter((_, idx) => idx !== i))}
                    style={{ border: 0, background: "none", cursor: "pointer", font: "400 13px var(--font-body)", lineHeight: 1, padding: 0 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="lux-field__control"
              placeholder="Add tag…"
              aria-label="Add tag"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTagChip(); } }}
            />
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={addTagChip}>Add</button>
          </div>
        </div>

        <CustomFields defs={customFieldDefs} />
        {msg && <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Creating…" : "Create task"}</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
