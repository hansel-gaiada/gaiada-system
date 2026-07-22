"use client";
import { useState, useRef, useTransition } from "react";
import type { OrgNode, OrgKind } from "@/lib/org";
import type { AssignmentSummary } from "@/lib/serviceAssignments";
import { ConnectServicePanel, type ConnectServiceActions } from "./ConnectServicePanel";
import "./org.css";

const KINDS: OrgKind[] = ["holding", "company", "department", "division", "role", "person"];
const ASSIGNABLE = new Set<OrgKind>(["division", "role", "person"]);
// ORG-13 (A9): only a department or division can be turned into a
// shared-service provider — matches the plan's "Connect service button on
// department cards" framing, extended to division since a division is
// equally a valid org_units anchor.
const CONNECTABLE = new Set<OrgKind>(["department", "division"]);
// Sensible child kind one level below a given kind (server-only lib not imported here).
const CHILD_KIND: Partial<Record<OrgKind, OrgKind>> = {
  holding: "company", company: "department", department: "division", division: "role", role: "person",
};
const childKindFor = (kind: OrgKind): OrgKind => CHILD_KIND[kind] ?? "person";
const NEW_LABEL: Record<OrgKind, string> = {
  holding: "New company", company: "New department", department: "New division",
  division: "New role", role: "New person", person: "New person",
};

type SaveResult = { ok: boolean; error?: string; source?: "backend" | "local"; savedAt?: string };
// ORG-13 — everything Connect-service related, bundled into one prop so the
// common (flag-off) case is a single `enabled: false` check rather than a
// handful of optional props threaded through. Fully absent behind
// SERVICE_ASSIGNMENTS_ENABLED (default off): no button renders, nothing is
// fetched, OrgBuilder behaves byte-for-byte as it did before ORG-13.
export interface ServiceProps {
  enabled: boolean;
  companies: { id: string; name: string }[]; // candidate targets (self already excluded by the caller)
  modules: readonly string[];
  actions: ConnectServiceActions;
}
interface Props {
  companyId: string;
  initial: OrgNode;
  canEdit: boolean;
  members: { id: string; name: string }[];
  source: "backend" | "local" | "default";
  updatedAt: string | null;
  save: (companyId: string, treeJson: string) => Promise<SaveResult>;
  service: ServiceProps;
}

// ---- pure tree ops (return a new root) ----
const uid = () => "n-" + Math.random().toString(36).slice(2, 9);
function findNode(n: OrgNode, id: string): OrgNode | null {
  if (n.id === id) return n;
  for (const c of n.children) { const f = findNode(c, id); if (f) return f; }
  return null;
}
function isWithin(node: OrgNode, id: string): boolean {
  return node.id === id || node.children.some((c) => isWithin(c, id));
}
function patchNode(n: OrgNode, id: string, patch: Partial<OrgNode>): OrgNode {
  if (n.id === id) return { ...n, ...patch, children: n.children };
  return { ...n, children: n.children.map((c) => patchNode(c, id, patch)) };
}
function addChildTo(n: OrgNode, parentId: string, child: OrgNode): OrgNode {
  if (n.id === parentId) return { ...n, children: [...n.children, child] };
  return { ...n, children: n.children.map((c) => addChildTo(c, parentId, child)) };
}
function removeNode(n: OrgNode, id: string): OrgNode {
  return { ...n, children: n.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)) };
}
function moveNode(root: OrgNode, dragId: string, targetId: string): OrgNode {
  if (dragId === targetId || dragId === root.id) return root;
  const dragNode = findNode(root, dragId);
  if (!dragNode || isWithin(dragNode, targetId)) return root; // no cycles
  return addChildTo(removeNode(root, dragId), targetId, dragNode);
}

export function OrgBuilder({ companyId, initial, canEdit, members, source, updatedAt, save, service }: Props) {
  const [root, setRoot] = useState<OrgNode>(initial);
  const [dirty, setDirty] = useState(false);
  const [dropId, setDropId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dragId = useRef<string | null>(null);

  // ORG-13 Connect-service panel state — kept separate from the tree-edit
  // `pending`/`msg` state above so opening the panel never blocks or is
  // blocked by an in-flight structure save.
  const [connectNodeId, setConnectNodeId] = useState<string | null>(null);
  const [existingAssignments, setExistingAssignments] = useState<AssignmentSummary[]>([]);
  const [, startAssignTransition] = useTransition();
  const openConnectService = (nodeId: string) => {
    setConnectNodeId(nodeId);
    setExistingAssignments([]);
    startAssignTransition(async () => {
      const rows = await service.actions.listForUnit(nodeId);
      setExistingAssignments(rows);
    });
  };
  const closeConnectService = () => { setConnectNodeId(null); setExistingAssignments([]); };

  const mutate = (next: OrgNode) => { setRoot(next); setDirty(true); setMsg(null); };
  const rename = (id: string, name: string) => mutate(patchNode(root, id, { name }));
  const setKind = (id: string, kind: OrgKind) => mutate(patchNode(root, id, { kind }));
  const assign = (id: string, assigneeId: string) => {
    const m = members.find((x) => x.id === assigneeId);
    mutate(patchNode(root, id, { assigneeId: assigneeId || null, assigneeName: m?.name ?? null }));
  };
  const addChild = (parentId: string) => {
    const parent = findNode(root, parentId);
    const kind = childKindFor(parent?.kind ?? "division");
    const id = uid();
    mutate(addChildTo(root, parentId, { id, name: NEW_LABEL[kind], kind, children: [] }));
    setSelectedId(id); // select the new unit so it can be edited immediately
  };
  const remove = (id: string) => { mutate(removeNode(root, id)); if (selectedId === id) setSelectedId(null); };
  const onDropTo = (targetId: string) => {
    if (dragId.current) mutate(moveNode(root, dragId.current, targetId));
    dragId.current = null; setDropId(null);
  };

  const onSave = () => {
    startTransition(async () => {
      const res = await save(companyId, JSON.stringify({ root }));
      if (res.ok) { setDirty(false); setMsg(res.source === "local" ? "Saved locally — will sync when connected." : "Saved."); }
      else setMsg(res.error ?? "Couldn't save.");
    });
  };

  const savedNote =
    source === "backend" ? "Loaded from the platform." :
    source === "local" ? "Loaded from your saved local copy (backend pending)." :
    "Showing the seeded default — not yet saved.";

  const selected = selectedId ? findNode(root, selectedId) : null;

  // Read-only viewers get the chart only.
  if (!canEdit) {
    return (
      <div className="org-readonly">
        <p className="org-note">{savedNote}{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString("en-GB")}` : ""}</p>
        <div className="org-chartscroll erp-scroll"><OrgChart node={root} /></div>
      </div>
    );
  }

  return (
    <div className="org-stack">
      <div className="org-bar">
        <span className="org-note">
          {savedNote}
          {dirty && <span className="org-dirty"> · unsaved changes</span>}
          {msg && <span className="org-msg"> · {msg}</span>}
        </span>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onSave} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save structure"}
        </button>
      </div>

      {/* TOP — interactive chart (drag to re-parent, click to edit) */}
      <section className="org-canvas" aria-label="Org chart">
        <div className="org-inspector">
          {selected ? (
            <NodeInspector
              node={selected}
              isRoot={selected.id === root.id}
              members={members}
              onRename={rename}
              onKind={setKind}
              onAssign={assign}
              onAdd={addChild}
              onRemove={remove}
              onClose={() => setSelectedId(null)}
              canConnectService={service.enabled && CONNECTABLE.has(selected.kind)}
              onConnectService={() => openConnectService(selected.id)}
            />
          ) : (
            <span className="org-hint">Click a unit to edit it · drag a unit onto another to re-parent · use ＋ to add below.</span>
          )}
        </div>
        <div className="org-chartscroll erp-scroll">
          <OrgChart
            node={root}
            edit={{
              selectedId, dropId,
              onSelect: setSelectedId,
              onDragStart: (id) => { dragId.current = id; },
              onDropOver: setDropId,
              onDropClear: () => setDropId(null),
              onDrop: onDropTo,
              onAdd: addChild,
            }}
          />
        </div>
      </section>

      {/* ORG-13 — Connect-service confirm-sheet, opened from the inspector's
          "Connect service…" button on an eligible (department/division) node. */}
      {service.enabled && connectNodeId && selected && selected.id === connectNodeId && (
        <ConnectServicePanel
          node={selected}
          companies={service.companies}
          modules={service.modules}
          members={members}
          actions={service.actions}
          existing={existingAssignments}
          onClose={closeConnectService}
        />
      )}

      {/* BOTTOM — detailed list editor */}
      <section className="org-listwrap" aria-label="Detailed editor">
        <div className="org-listwrap__head">Detailed editor</div>
        <div className="org-editor erp-scroll">
          <ul className="org-tree">
            <EditorNode
              node={root} rootId={root.id} depth={0} members={members} dropId={dropId} selectedId={selectedId}
              onSelect={setSelectedId}
              onDragStart={(id) => { dragId.current = id; }}
              onDropOver={setDropId}
              onDropClear={() => setDropId(null)}
              onDrop={onDropTo}
              onRename={rename} onKind={setKind} onAssign={assign} onAdd={addChild} onRemove={remove}
            />
          </ul>
        </div>
      </section>
    </div>
  );
}

// ---- Inspector: click-to-edit panel for the selected node ----
function NodeInspector({ node, isRoot, members, onRename, onKind, onAssign, onAdd, onRemove, onClose, canConnectService, onConnectService }: {
  node: OrgNode; isRoot: boolean; members: { id: string; name: string }[];
  onRename: (id: string, name: string) => void; onKind: (id: string, kind: OrgKind) => void;
  onAssign: (id: string, assigneeId: string) => void; onAdd: (id: string) => void; onRemove: (id: string) => void; onClose: () => void;
  canConnectService: boolean; onConnectService: () => void;
}) {
  return (
    <div className="org-insp">
      <input className="org-insp__name" value={node.name} aria-label="Unit name" autoFocus
        onChange={(e) => onRename(node.id, e.target.value)} />
      <select className="org-insp__sel" value={node.kind} aria-label="Unit type" disabled={isRoot}
        onChange={(e) => onKind(node.id, e.target.value as OrgKind)}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {ASSIGNABLE.has(node.kind) && (
        <select className="org-insp__sel" value={node.assigneeId ?? ""} aria-label="Assign person"
          onChange={(e) => onAssign(node.id, e.target.value)}>
          <option value="">— unassigned —</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onAdd(node.id)}>＋ Add unit</button>
      {!isRoot && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onRemove(node.id)}>Remove</button>}
      {canConnectService && (
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onConnectService}>Connect service…</button>
      )}
      <button type="button" className="org-insp__close" aria-label="Close" onClick={onClose}>×</button>
    </div>
  );
}

// ---- interactive chart ----
interface EditProps {
  selectedId: string | null;
  dropId: string | null;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
  onDropOver: (id: string) => void;
  onDropClear: () => void;
  onDrop: (targetId: string) => void;
  onAdd: (parentId: string) => void;
}
function OrgChart({ node, edit }: { node: OrgNode; edit?: EditProps }) {
  return <ul className="org-chart"><ChartNode node={node} edit={edit} isRoot /></ul>;
}
function ChartNode({ node, edit, isRoot }: { node: OrgNode; edit?: EditProps; isRoot?: boolean }) {
  const selected = edit?.selectedId === node.id;
  const drop = edit?.dropId === node.id;
  return (
    <li>
      <div
        className={`org-box org-box--${node.kind}${selected ? " org-box--sel" : ""}${drop ? " org-box--drop" : ""}${edit ? " org-box--live" : ""}`}
        draggable={!!edit && !isRoot}
        role={edit ? "button" : undefined}
        tabIndex={edit ? 0 : undefined}
        onClick={edit ? () => edit.onSelect(node.id) : undefined}
        onKeyDown={edit ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit.onSelect(node.id); } } : undefined}
        onDragStart={edit ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", node.id); edit.onDragStart(node.id); } : undefined}
        onDragOver={edit ? (e) => { e.preventDefault(); edit.onDropOver(node.id); } : undefined}
        onDragLeave={edit ? () => edit.onDropClear() : undefined}
        onDrop={edit ? (e) => { e.preventDefault(); edit.onDrop(node.id); } : undefined}
      >
        <span className="org-box__name">{node.name}</span>
        <span className="org-box__meta">{node.kind}{node.assigneeName ? ` · ${node.assigneeName}` : ""}</span>
        {edit && <button type="button" className="org-box__add" title="Add unit below" aria-label={`Add unit under ${node.name}`}
          onClick={(e) => { e.stopPropagation(); edit.onAdd(node.id); }}>＋</button>}
      </div>
      {node.children.length > 0 && (
        <ul>{node.children.map((c) => <ChartNode key={c.id} node={c} edit={edit} />)}</ul>
      )}
    </li>
  );
}

// ---- detailed list editor (nested indented list; grip is the drag handle) ----
interface EditorNodeProps {
  node: OrgNode; rootId: string; depth: number; members: { id: string; name: string }[];
  dropId: string | null; selectedId: string | null; onSelect: (id: string) => void;
  onDragStart: (id: string) => void; onDropOver: (id: string) => void; onDropClear: () => void; onDrop: (targetId: string) => void;
  onRename: (id: string, name: string) => void; onKind: (id: string, kind: OrgKind) => void;
  onAssign: (id: string, assigneeId: string) => void; onAdd: (parentId: string) => void; onRemove: (id: string) => void;
}
function EditorNode(props: EditorNodeProps) {
  const { node, rootId, members, dropId, selectedId } = props;
  const isRoot = node.id === rootId;
  return (
    <li>
      <div
        className={`org-erow${dropId === node.id ? " org-erow--drop" : ""}${selectedId === node.id ? " org-erow--sel" : ""}`}
        onDragOver={(e) => { e.preventDefault(); props.onDropOver(node.id); }}
        onDragLeave={() => props.onDropClear()}
        onDrop={(e) => { e.preventDefault(); props.onDrop(node.id); }}
      >
        {!isRoot ? (
          <span className="org-grip" draggable role="button" aria-label={`Drag ${node.name} to re-parent`} title="Drag onto another unit to re-parent"
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", node.id); props.onDragStart(node.id); }} />
        ) : <span className="org-grip org-grip--locked" aria-hidden="true" />}
        <input className="org-name" value={node.name} aria-label="Unit name"
          onFocus={() => props.onSelect(node.id)} onChange={(e) => props.onRename(node.id, e.target.value)} />
        <select className="org-kind" value={node.kind} aria-label="Unit type" disabled={isRoot} onChange={(e) => props.onKind(node.id, e.target.value as OrgKind)}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        {ASSIGNABLE.has(node.kind) && (
          <select className="org-assignee" value={node.assigneeId ?? ""} aria-label="Assign person" onChange={(e) => props.onAssign(node.id, e.target.value)}>
            <option value="">— unassigned —</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <button type="button" className="org-iconbtn" title="Add unit below" aria-label="Add child unit" onClick={() => props.onAdd(node.id)}>+</button>
        {!isRoot && <button type="button" className="org-iconbtn org-iconbtn--danger" title="Remove" aria-label="Remove unit" onClick={() => props.onRemove(node.id)}>×</button>}
      </div>
      {node.children.length > 0 && (
        <ul>{node.children.map((c) => <EditorNode key={c.id} {...props} node={c} depth={props.depth + 1} />)}</ul>
      )}
    </li>
  );
}
