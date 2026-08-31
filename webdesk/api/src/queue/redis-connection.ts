// WSK-11 — shared BullMQ connection wiring. This is the "queue/**" shared piece the ticket asked
// for: both mail.service.ts's Queue and mail-sender.processor.ts's Worker build their connection
// options from here, so a future second queue (media variants, purge sweeps — the docker-compose
// worker stub's own stated scope) reuses the same construction instead of re-deriving it.
import { queueEnv } from "./queue.config";

export type WebdeskQueueConnection = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  // REQUIRED by BullMQ for any connection a Worker uses: Workers issue blocking commands
  // (BRPOPLPUSH-style), and node-redis/ioredis silently retrying mid-block corrupts delivery
  // semantics. Set unconditionally here so every caller gets it right by construction rather than
  // needing to remember it per call site (a well-documented BullMQ footgun otherwise).
  maxRetriesPerRequest: null;
};

/**
 * Builds a plain connection object from REDIS_URL rather than sharing one app-wide ioredis
 * client — BullMQ's own documented recommendation is that a Worker's connection is NOT shared
 * with anything else, since it blocks on it. Every Queue/Worker this project creates calls this
 * fresh.
 */
export function redisConnectionOptions(): WebdeskQueueConnection {
  const url = new URL(queueEnv.redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db,
    maxRetriesPerRequest: null,
  };
}
