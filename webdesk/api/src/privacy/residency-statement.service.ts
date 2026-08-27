// WSK-38 — design §11's "(d) A residency statement per tenant says where content, media, and
// backups physically sit." Under WSK-D23 (fully self-hosted storage — MinIO primary, no
// Cloudflare, no R2), this is answerable in ONE real sentence per environment, not an abstract
// policy doc — so that is exactly what this returns: a plain-language statement plus the concrete
// facts it is built from (`STORAGE_ENDPOINT`/`STORAGE_PUBLIC_BASE_URL`, this Postgres connection's
// own host, and §11's own backup-target description for whichever phase the box is in), so a
// client-facing answer during procurement is generated from the SAME config the system actually
// runs on, never hand-typed and left to drift.
//
// NOT wired to any HTTP route in this ticket (no design text asks for one, and the "console card"
// this ticket's own report describes for WSK-24 is a DIFFERENT surface — the DSR find/export/erase
// actions). This is a plain injectable a future control-plane read endpoint, or WSK-24's console
// card, can call directly.
import { Injectable } from "@nestjs/common";
import { storageConfig } from "../storage/storage.config";
import { config } from "../config";

export type BackupPhase = "now" | "staging" | "target-state";

export type ResidencyStatement = {
  sentence: string;
  facts: {
    contentAndSubmissionsDatabase: string;
    mediaAndAttachmentsStorage: string;
    backupPhase: BackupPhase;
    backupTarget: string;
    selfHostedOnly: true;
  };
};

/** design §11a: "MinIO / R2 / Cloudflare split needs one real answer" — under WSK-D23 the answer
 *  is that there IS no split: everything is self-hosted. */
const BACKUP_TARGET_BY_PHASE: Record<BackupPhase, string> = {
  now: "a nightly pull-model backup to a second estate-owned box (Zone B holds no credential for the destination and cannot reach, overwrite, or delete it)",
  staging: "a nightly pull-model backup to the company's own Google Workspace (Drive/Shared Drive via a dedicated service account) — encrypted before upload",
  "target-state": "a local server + NAS with RAID for redundancy, plus the same offsite pull-model copy (RAID alone is never treated as a backup)",
};

@Injectable()
export class ResidencyStatementService {
  buildFor(tenantSlug: string, backupPhase: BackupPhase = "now"): ResidencyStatement {
    const dbHost = safeHost(config.appDatabaseUrl) ?? "the Zone B Postgres instance (self-hosted)";
    const storageHost = safeHost(storageConfig.publicObjectBaseUrl || storageConfig.endpoint) ?? "the Zone B MinIO instance (self-hosted)";
    const backupTarget = BACKUP_TARGET_BY_PHASE[backupPhase];

    const sentence =
      `All of tenant '${tenantSlug}''s content, form submissions and uploaded media are stored on ` +
      `self-hosted infrastructure we operate — Postgres at ${dbHost} and MinIO (S3-API, self-hosted, ` +
      `never Cloudflare R2 or any third-party object store) at ${storageHost} — with backups going to ${backupTarget}.`;

    return {
      sentence,
      facts: {
        contentAndSubmissionsDatabase: dbHost,
        mediaAndAttachmentsStorage: storageHost,
        backupPhase,
        backupTarget,
        selfHostedOnly: true,
      },
    };
  }
}

function safeHost(urlLike: string): string | null {
  if (!urlLike) return null;
  try {
    return new URL(urlLike).host || null;
  } catch {
    // APP_DATABASE_URL is a postgres:// URL — URL parsing works for that scheme too, but guard
    // against anything malformed rather than throwing out of a statement-generation helper.
    return null;
  }
}
