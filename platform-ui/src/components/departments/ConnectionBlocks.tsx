import type { ReactNode } from "react";
import { isPlanned, type ConnectionKind, type Workspace } from "@/lib/workspaces";

// DW-6c: the Connections half of the Tools & connections page (plan §4.1). One block per
// non-ticketed kind of the workspace, in registry order. A kind with a ticket is not built and is not
// drawn. The page supplies each kind's content; a kind it has no content for is skipped rather than
// drawn empty.

/** The workspace's connection kinds that are built, in registry order. */
export function visibleConnections(ws: Pick<Workspace, "connections">): ConnectionKind[] {
  return ws.connections.filter((k) => !isPlanned(k));
}

export function ConnectionBlocks({ workspace, blocks }: { workspace: Pick<Workspace, "connections">; blocks: Readonly<Record<string, ReactNode>> }) {
  const kinds = visibleConnections(workspace).filter((k) => blocks[k.key] !== undefined && blocks[k.key] !== null);
  return (
    <>
      {kinds.map((k) => (
        <section key={k.key} className="dept-conn-block" data-connection-kind={k.key} aria-labelledby={`dept-conn-${k.key}`}>
          <h4 id={`dept-conn-${k.key}`} className="dept-conn-block__title">{k.label}</h4>
          {blocks[k.key]}
        </section>
      ))}
    </>
  );
}
