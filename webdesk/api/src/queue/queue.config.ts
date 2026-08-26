// WSK-11 — shared Redis connection config for BullMQ, read live from process.env (same
// live-getter reasoning as ../config.ts's own header comment: ESM import hoisting can race a
// test's env-var assignment against this module's evaluation, so every field here is a GETTER,
// never a value snapshotted at module-load time).
export const queueEnv = {
  get redisUrl() {
    return process.env.REDIS_URL || "redis://localhost:6379";
  },
};
