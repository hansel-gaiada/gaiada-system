// WSK-61 — scheduler env config. Same live-read discipline as ../config.ts: the settings are
// resolved from process.env when asked for, never snapshotted at module-import time (ESM import
// hoisting can race a test's own `process.env.X = ...` assignment otherwise).
//
//   WEBDESK_SCHEDULER_ENABLED         true | false (1/0/yes/no). Default: on, except under NODE_ENV=test,
//                                     where every spec builds the real app and none may start a worker
//                                     implicitly (a spec that wants the scheduler sets it to true).
//   WEBDESK_SCHEDULER_TICK_SECONDS    how often the content tick runs. Default 60, allowed 15-300.
//   WEBDESK_SCHEDULER_HOURLY_SECONDS  how often the forms purge and the idempotency sweep run.
//                                     Default 3600, allowed 300-86400.
//   WEBDESK_SCHEDULER_QUEUE_NAME      the BullMQ queue. Default `webdesk-scheduler`; an override exists
//                                     so a spec can have a queue (and its job schedulers) to itself.
//
// An EMPTY variable means "the default", never 0: compose passes `${VAR:-}` through as an empty string
// when the operator set nothing (see the estate's "empty env var becomes zero" incident, where
// `Number("")` is 0 and a 0-second interval is a busy loop). A value outside its range is a loud
// refusal to boot, naming the variable, the value and the range: a scheduler silently running every
// second, or never, is worse than a process that does not start.
export interface SchedulerSettings {
  enabled: boolean;
  tickSeconds: number;
  hourlySeconds: number;
  queueName: string;
}

export const TICK_SECONDS = { default: 60, min: 15, max: 300 } as const;
export const HOURLY_SECONDS = { default: 3600, min: 300, max: 86_400 } as const;
export const DEFAULT_QUEUE_NAME = "webdesk-scheduler";

/** The three job-scheduler ids (and BullMQ job names). */
export const JOB_CONTENT_TICK = "content-tick";
export const JOB_FORMS_PURGE = "forms-retention-purge";
export const JOB_IDEMPOTENCY_SWEEP = "idempotency-sweep";
export const SCHEDULER_JOB_IDS = [JOB_CONTENT_TICK, JOB_FORMS_PURGE, JOB_IDEMPOTENCY_SWEEP] as const;

export class SchedulerConfigError extends Error {
  constructor(message: string) {
    super(`[webdesk:scheduler] ${message}`);
    this.name = "SchedulerConfigError";
  }
}

function present(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function seconds(env: NodeJS.ProcessEnv, name: string, range: { default: number; min: number; max: number }): number {
  const v = present(env, name);
  if (v === null) return range.default;
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max) {
    throw new SchedulerConfigError(
      `${name}=${JSON.stringify(v)} is not allowed: it must be a whole number of seconds from ${range.min} to ${range.max}. ` +
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
      throw new SchedulerConfigError(
        `${name}=${JSON.stringify(v)} is not allowed: use true or false. Unset it (or leave it empty) for the default. Refusing to boot.`,
      );
  }
}

/** Resolves and validates the settings. Throws SchedulerConfigError on an out-of-range or malformed value. */
export function resolveSchedulerSettings(env: NodeJS.ProcessEnv = process.env): SchedulerSettings {
  return {
    enabled: flag(env, "WEBDESK_SCHEDULER_ENABLED", env.NODE_ENV !== "test"),
    tickSeconds: seconds(env, "WEBDESK_SCHEDULER_TICK_SECONDS", TICK_SECONDS),
    hourlySeconds: seconds(env, "WEBDESK_SCHEDULER_HOURLY_SECONDS", HOURLY_SECONDS),
    queueName: present(env, "WEBDESK_SCHEDULER_QUEUE_NAME") ?? DEFAULT_QUEUE_NAME,
  };
}
