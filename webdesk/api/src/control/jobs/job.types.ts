import type { CommandName, ImpactClass } from "../command-types";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  tenantSlug: string;
  command: CommandName;
  impactClass: ImpactClass;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: { code: string; message: string };
}
