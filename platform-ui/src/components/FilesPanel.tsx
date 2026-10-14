"use client";
// DW-8h (contract §45.3, §45.4): the files of a request, a campaign, a campaign part or a client, from an HONEST read.
// A refusal, a missing item and an unreachable platform each say so; none of them is drawn as "No attachments".
import type { FileMeta } from "@/lib/entities";
import type { ReadResult } from "@/lib/readResult";
import { attachFileAction, deleteFileAction, uploadFileAction } from "@/lib/collabActions";
import { readFailureText } from "@/lib/fileUpload";
import { Attachments } from "@/components/Attachments";

export interface FilesPanelProps {
  /** The platform's target kind: `work_request`, `agency_campaign`, `agency_campaign_part` or `client`. */
  entityType: string;
  entityId: string;
  /** The page path to refresh after an add or a remove. */
  revalidate: string;
  /** Cosmetic: the server decides, and says why in a sentence. */
  canEdit?: boolean;
  result: ReadResult<FileMeta[]>;
  /** A quiet line under the files, such as "Only staff see these files." */
  note?: string;
}

export function FilesPanel({ entityType, entityId, revalidate, canEdit = true, result, note }: FilesPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {note && <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{note}</p>}
      {result.kind !== "ok" ? (
        <p role="status" style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
          {readFailureText(result.kind, result.kind === "unavailable" ? result.reason : undefined)}
        </p>
      ) : (
        <Attachments
          files={result.data}
          canEdit={canEdit}
          attach={(fd) => attachFileAction(entityType, entityId, fd, revalidate)}
          remove={(id) => deleteFileAction(entityType, entityId, id, revalidate)}
          upload={(fd) => uploadFileAction(entityType, entityId, revalidate, fd)}
        />
      )}
    </div>
  );
}
