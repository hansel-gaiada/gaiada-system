"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { BoardColumn, PmTask, TaskStatus } from "@/lib/pm";
import { ProgressBar } from "./ProgressBar";
import "./pm.css";

interface Props {
  columns: BoardColumn[];
  move: (taskId: string, status: TaskStatus) => Promise<{ ok: boolean; error?: string }>;
}

export function Board({ columns, move }: Props) {
  const router = useRouter();
  const [dropCol, setDropCol] = useState<TaskStatus | null>(null);
  const [, startTransition] = useTransition();
  const dragId = useRef<string | null>(null);

  const onDrop = (status: TaskStatus) => {
    const id = dragId.current;
    dragId.current = null;
    setDropCol(null);
    if (!id) return;
    startTransition(async () => {
      await move(id, status);
      router.refresh();
    });
  };

  return (
    <div className="pm-board">
      {columns.map((col) => (
        <section
          key={col.status}
          className="pm-col"
          aria-label={col.label}
          onDragOver={(e) => { e.preventDefault(); setDropCol(col.status); }}
          onDragLeave={() => setDropCol((s) => (s === col.status ? null : s))}
          onDrop={(e) => { e.preventDefault(); onDrop(col.status); }}
        >
          <div className="pm-col__head">
            <span className="pm-col__title">{col.label}</span>
            <span className="pm-col__count">{col.tasks.length}</span>
          </div>
          <div className={`pm-col__body${dropCol === col.status ? " pm-col__body--drop" : ""}`}>
            {col.tasks.map((t) => <Card key={t.id} task={t} onDragStart={(id) => { dragId.current = id; }} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Card({ task, onDragStart }: { task: PmTask; onDragStart: (id: string) => void }) {
  const who = task.assignee ? (task.assignee.responsibleName || task.assignee.refName) : "Unassigned";
  const unitTag = task.assignee && task.assignee.kind !== "person" ? task.assignee.refName : null;
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={`pm-card pm-card--p-${task.priority}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", task.id); onDragStart(task.id); }}
    >
      <span className="pm-card__title">{task.title}</span>
      <ProgressBar value={task.progress} />
      <div className="pm-card__meta">
        <span className="pm-who">{who}</span>
        {unitTag ? <span className="pm-chip">{unitTag}</span> : <span className="pm-chip">{task.priority}</span>}
      </div>
    </Link>
  );
}
