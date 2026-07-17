"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import type { OrgNode, OrgKind } from "@/lib/org";
import "./org.css";

const KINDS: OrgKind[] = ["holding", "company", "department", "division", "role", "person"];
const ASSIGNABLE = new Set<OrgKind>(["division", "role", "person"]);
// The sensible child kind one level below a given kind — keeps added units on
// the canonical ladder (holding → company → department → division → role →
// person). Defined here (not in the server-only lib/org) so this client
// component doesn't pull server modules into the browser bundle.
const CHILD_KIND: Partial<Record<OrgKind, OrgKind>> = {
  holding: "company",
  company: "department",
  department: "division",
  division: "role",
  role: "person",
};
const childKindFor = (kind: OrgKind): OrgKind => CHILD_KIND[kind] ?? "person";
// Default names for a freshly-added child of each kind.
const NEW_LABEL: Record<OrgKind, string> = {
  holding: "New company",
  company: "New department",
  department: "New division",
  division: "New role",
  role: "New person",
  person: "New person",
};

type SaveResult = { ok: boolean; error?: string; source?: "backend" | "local"; savedAt?: string };
interface Props {
  companyId: string;
  initial: OrgNode;
  canEdit: boolean;
  members: { id: string; name: string }[];
  source: "backend" | "local" | "default";
  updatedAt: string | null;
  save: (companyId: string, treeJson: string) => Promise<SaveResult>;
}

// ---- pure tree ops (return a new root) ----
const uid = () => "n-" + Math.random().toString(36).slice(2, 9);
function findNode(n: OrgNode, id: string): OrgNode | null {
  if (n.id === id) return n;
  for (const c of n.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
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

export function OrgBuilder({ companyId, initial, canEdit, members, source, updatedAt, save }: Props) {
  const [root, setRoot] = useState<OrgNode>(initial);
  const [dirty, setDirty] = useState(false);
  const [dropId, setDropId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dragId = useRef<string | null>(null);

  const mutate = (next: OrgNode) => {
    setRoot(next);
    setDirty(true);
    setMsg(null);
  };

  const onSave = () => {
    startTransition(async () => {
      const res = await save(companyId, JSON.stringify({ root }));
      if (res.ok) {
        setDirty(false);
        setMsg(res.source === "local" ? "Saved locally — will sync when the backend is connected." : "Saved.");
      } else {
        setMsg(res.error ?? "Couldn't save.");
      }
    });
  };

  const savedNote = useMemo(() => {
    if (source === "backend") return "Loaded from the platform.";
    if (source === "local") return "Loaded from your saved local copy (backend pending).";
    return "Showing the seeded default — not yet saved.";
  }, [source]);

  const preview = <OrgChart node={root} />;

  if (!canEdit) {
    return (
      <div className="org-readonly">
        <p className="org-note">{savedNote}{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString("en-GB")}` : ""}</p>
        <div className="org-preview erp-scroll">{preview}</div>
      </div>
    );
  }

  return (
    <div>
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

      <div className="org-wrap">
        <section className="org-editor erp-scroll" aria-label="Org structure editor">
          <ul className="org-tree">
            <EditorNode
              node={root}
              rootId={root.id}
              depth={0}
              members={members}
              dropId={dropId}
              onDragStart={(id) => { dragId.current = id; }}
              onDropOver={(id) => setDropId(id)}
              onDropClear={() => setDropId(null)}
              onDrop={(targetId) => {
                if (dragId.current) mutate(moveNode(root, dragId.current, targetId));
                dragId.current = null;
                setDropId(null);
              }}
              onRename={(id, name) => mutate(patchNode(root, id, { name }))}
              onKind={(id, kind) => mutate(patchNode(root, id, { kind }))}
              onAssign={(id, assigneeId) => {
                const m = members.find((x) => x.id === assigneeId);
                mutate(patchNode(root, id, { assigneeId: assigneeId || null, assigneeName: m?.name ?? null }));
              }}
              onAdd={(parentId) => {
                const parent = findNode(root, parentId);
                const kind = childKindFor(parent?.kind ?? "division");
                mutate(addChildTo(root, parentId, { id: uid(), name: NEW_LABEL[kind], kind, children: [] }));
              }}
              onRemove={(id) => mutate(removeNode(root, id))}
            />
          </ul>
        </section>

        <section className="org-preview erp-scroll" aria-label="Org chart preview">
          {preview}
        </section>
      </div>
    </div>
  );
}

// ---- editor (nested indented list; grip is the drag handle) ----
interface EditorNodeProps {
  node: OrgNode;
  rootId: string;
  depth: number;
  members: { id: string; name: string }[];
  dropId: string | null;
  onDragStart: (id: string) => void;
  onDropOver: (id: string) => void;
  onDropClear: () => void;
  onDrop: (targetId: string) => void;
  onRename: (id: string, name: string) => void;
  onKind: (id: string, kind: OrgKind) => void;
  onAssign: (id: string, assigneeId: string) => void;
  onAdd: (parentId: string) => void;
  onRemove: (id: string) => void;
}
function EditorNode(props: EditorNodeProps) {
  const { node, rootId, members, dropId } = props;
  const isRoot = node.id === rootId;
  return (
    <li>
      <div
        className={`org-erow${dropId === node.id ? " org-erow--drop" : ""}`}
        onDragOver={(e) => { e.preventDefault(); props.onDropOver(node.id); }}
        onDragLeave={() => props.onDropClear()}
        onDrop={(e) => { e.preventDefault(); props.onDrop(node.id); }}
      >
        {!isRoot ? (
          <span
            className="org-grip"
            draggable
            role="button"
            aria-label={`Drag ${node.name} to re-parent`}
            title="Drag onto another unit to re-parent"
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", node.id); props.onDragStart(node.id); }}
          />
        ) : (
          <span className="org-grip org-grip--locked" aria-hidden="true" />
        )}

        <input
          className="org-name"
          value={node.name}
          aria-label="Unit name"
          onChange={(e) => props.onRename(node.id, e.target.value)}
        />

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
        <ul>
          {node.children.map((c) => <EditorNode key={c.id} {...props} node={c} depth={props.depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

// ---- read-only chart preview (pure-CSS org tree) ----
function OrgChart({ node }: { node: OrgNode }) {
  return (
    <ul className="org-chart">
      <ChartNode node={node} />
    </ul>
  );
}
function ChartNode({ node }: { node: OrgNode }) {
  return (
    <li>
      <div className={`org-box org-box--${node.kind}`}>
        <span className="org-box__name">{node.name}</span>
        <span className="org-box__meta">
          {node.kind}
          {node.assigneeName ? ` · ${node.assigneeName}` : ""}
        </span>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => <ChartNode key={c.id} node={c} />)}
        </ul>
      )}
    </li>
  );
}
