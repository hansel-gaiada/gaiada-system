// Shared ioredis client for the event backbone (relay writer + consumer reader). One
// connection per process is enough at v1 scale; both relay.ts and consumer.service.ts
// import getRedis() rather than constructing their own clients.
import Redis from "ioredis";
import { config } from "../config";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    if (!config.redisUrl) throw new Error("REDIS_URL not set");
    client = new Redis(config.redisUrl);
  }
  return client;
}

export function setRedis(r: Redis | null): void {
  client = r;
}

export async function closeRedis(): Promise<void> {
  await client?.quit();
  client = null;
}
