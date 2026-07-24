"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  projectId: string;
  projectName: string;
  canManage: boolean;
}

export function DuplicateProject({ projectId, projectName, canManage }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${projectName} (copy)`);
  const [pending, startTransition] = useTransition();

  if (!canManage) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="lux-btn lux-btn--ghost lux-btn--sm"
        onClick={() => setOpen(true)}
      >
        Duplicate
      </button>
    );
  }

  async function handleDuplicate() {
    const { duplicateProjectAction } = await import("@/lib/pmActions");
    startTransition(async () => {
      await duplicateProjectAction(projectId, name);
    });
  }

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        style={{
          padding: "6px 10px",
          border: "1px solid var(--border-primary)",
          borderRadius: "4px",
          font: "400 14px var(--font-body)",
          color: "var(--text-primary)",
          backgroundColor: "var(--bg-secondary)",
        }}
        disabled={pending}
      />
      <button
        type="button"
        className="lux-btn lux-btn--solid lux-btn--sm"
        onClick={handleDuplicate}
        disabled={pending || !name.trim()}
      >
        {pending ? "Duplicating…" : "Confirm"}
      </button>
      <button
        type="button"
        className="lux-btn lux-btn--ghost lux-btn--sm"
        onClick={() => setOpen(false)}
        disabled={pending}
      >
        Cancel
      </button>
    </div>
  );
}
