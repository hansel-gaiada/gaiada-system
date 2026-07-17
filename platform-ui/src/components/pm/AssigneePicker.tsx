"use client";
import { useMemo, useState } from "react";
import type { Assignable, Assignee, AssigneeKind } from "@/lib/pm";
import { Eyebrow } from "@/components/ui";
import "@/components/forms/forms.css";

// Emits hidden fields (assigneeKind, assigneeRefId, assigneeRefName,
// responsibleId, responsibleName) for the enclosing form's action to parse.
// Target = person | department | division; when a unit is chosen the user MUST
// pick a responsible person (that unit's org-tree people, else all members).
export function AssigneePicker({ assignable, current }: { assignable: Assignable; current?: Assignee | null }) {
  const [kind, setKind] = useState<"" | AssigneeKind>(current?.kind ?? "");
  const [refId, setRefId] = useState<string>(current?.refId ?? "");
  const [responsibleId, setResponsibleId] = useState<string>(current?.responsibleId ?? "");

  const units = useMemo(() => assignable.units.filter((u) => u.kind === kind), [assignable.units, kind]);
  const selectedUnit = units.find((u) => u.id === refId);
  const responsiblePool = kind === "person" ? [] : (selectedUnit?.people.length ? selectedUnit.people : assignable.members);

  // Derived display names for the hidden fields.
  const refName =
    kind === "person" ? (assignable.members.find((m) => m.id === refId)?.name ?? "") : (selectedUnit?.name ?? "");
  const responsibleFinal = kind === "person" ? refId : responsibleId;
  const responsibleName = assignable.members.find((m) => m.id === responsibleFinal)?.name
    ?? responsiblePool.find((m) => m.id === responsibleFinal)?.name ?? "";

  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Assign to</Eyebrow>
        <select className="lux-field__control" value={kind} onChange={(e) => { setKind(e.target.value as AssigneeKind | ""); setRefId(""); setResponsibleId(""); }}>
          <option value="">Unassigned</option>
          <option value="person">Person</option>
          <option value="department">Department</option>
          <option value="division">Division</option>
        </select>
      </label>

      {kind === "person" && (
        <label className="lux-field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Person</Eyebrow>
          <select className="lux-field__control" value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="" disabled hidden />
            {assignable.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}

      {(kind === "department" || kind === "division") && (
        <>
          <label className="lux-field">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{kind === "department" ? "Department" : "Division"}</Eyebrow>
            <select className="lux-field__control" value={refId} onChange={(e) => { setRefId(e.target.value); setResponsibleId(""); }}>
              <option value="" disabled hidden />
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="lux-field">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Responsible person</Eyebrow>
            <select className="lux-field__control" value={responsibleId} onChange={(e) => setResponsibleId(e.target.value)} disabled={!refId}>
              <option value="" disabled hidden />
              {responsiblePool.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </>
      )}

      <input type="hidden" name="assigneeKind" value={kind} />
      <input type="hidden" name="assigneeRefId" value={refId} />
      <input type="hidden" name="assigneeRefName" value={refName} />
      <input type="hidden" name="responsibleId" value={responsibleFinal} />
      <input type="hidden" name="responsibleName" value={responsibleName} />
    </div>
  );
}
