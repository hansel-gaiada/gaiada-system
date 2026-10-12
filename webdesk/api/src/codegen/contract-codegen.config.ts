// M6-P4r-b -- env config for the live contract-codegen queue. Same discipline as
// ../scheduler/scheduler.config.ts: resolved from process.env when asked for (never snapshotted at
// import time), an EMPTY variable means the default (compose passes `${VAR:-}` as ""), and a value
// outside its range is a loud refusal to boot rather than a silent 0.
//
//   WEBDESK_CONTRACT_CODEGEN_ENABLED          true | false (1/0/yes/no). Default: on, except under
//                                             NODE_ENV=test, where every spec builds the real app and none
//                                             may start a worker or queue implicitly (a spec that wants it
//                                             sets this to true).
//   WEBDESK_CONTRACT_CODEGEN_QUEUE_NAME       the BullMQ queue. Default `contract-codegen`; an override
//                                             exists so a spec can have a queue to itself.
//   WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS  per-attempt job timeout. Default 120, allowed 10-900.
//   WEBDESK_CONTRACT_CODEGEN_ATTEMPTS         BullMQ attempts per job. Default 3, allowed 1-10.
//   WEBDESK_CONTRACT_CODEGEN_BACKOFF_SECONDS  base of the exponential backoff between attempts.
//                                             Default 10, allowed 1-600.
//
// With the feature disabled nothing is created: no queue, no worker, no Redis connection, and an
// enqueue request is a logged no-op.
export interface ContractCodegenSettings {
  enabled: boolean;
  queueName: string;
  jobTimeoutMs: number;
  attempts: number;
  backoffMs: number;
}

export const DEFAULT_CONTRACT_CODEGEN_QUEUE = "contract-codegen";
export const TIMEOUT_SECONDS = { default: 120, min: 10, max: 900 } as const;
export const ATTEMPTS = { default: 3, min: 1, max: 10 } as const;
export const BACKOFF_SECONDS = { default: 10, min: 1, max: 600 } as const;

/** How long a command waits for Redis to accept the enqueue before giving up (fail-soft: the command already committed). */
export const ENQUEUE_TIMEOUT_MS = 3_000;
/** How long a worker waits for another run of the SAME tenant to release the advisory lock before retrying the job. */
export const TENANT_LOCK_WAIT_MS = 30_000;

export class ContractCodegenConfigError extends Error {
  constructor(message: string) {
    super(`[webdesk:contract-codegen] ${message}`);
    this.name = "ContractCodegenConfigError";
  }
}

function present(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function whole(env: NodeJS.ProcessEnv, name: string, unit: string, range: { default: number; min: number; max: number }): number {
  const v = present(env, name);
  if (v === null) return range.default;
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    throw new ContractCodegenConfigError(
      `${name}=${JSON.stringify(v)} is not allowed: it must be a whole number of ${unit} from ${range.min} to ${range.max}. ` +
        `Unset it (or leave it empty) for the default of ${range.default}. Refusing to boot.`,
    );
  }
  return n;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = present(env, name);
  if (v === null) return fallback;
  switch (v.toLowerCase()) {
    case "true":
    case "1":
    case "yes":
      return true;
    case "false":
    case "0":
    case "no":
      return false;
    default:
      throw new ContractCodegenConfigError(
        `${name}=${JSON.stringify(v)} is not allowed: use true or false. Unset it (or leave it empty) for the default. Refusing to boot.`,
      );
  }
}

export function resolveContractCodegenSettings(env: NodeJS.ProcessEnv = process.env): ContractCodegenSettings {
  return {
    enabled: flag(env, "WEBDESK_CONTRACT_CODEGEN_ENABLED", env.NODE_ENV !== "test"),
    queueName: present(env, "WEBDESK_CONTRACT_CODEGEN_QUEUE_NAME") ?? DEFAULT_CONTRACT_CODEGEN_QUEUE,
    jobTimeoutMs: whole(env, "WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS", "seconds", TIMEOUT_SECONDS) * 1000,
    attempts: whole(env, "WEBDESK_CONTRACT_CODEGEN_ATTEMPTS", "attempts", ATTEMPTS),
    backoffMs: whole(env, "WEBDESK_CONTRACT_CODEGEN_BACKOFF_SECONDS", "seconds", BACKOFF_SECONDS) * 1000,
  };
}
