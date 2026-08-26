// WSK-07 — wires the concrete S3StorageAdapter behind the STORAGE_ADAPTER token and ensures the
// four buckets (§07 AC) exist with versioning + object lock on boot, idempotently.
import { Global, Logger, Module, OnModuleInit } from "@nestjs/common";
import { S3StorageAdapter } from "./s3-storage.adapter";
import { STORAGE_ADAPTER } from "./storage.tokens";
import type { StorageAdapter } from "./storage.types";
import { storageConfig } from "./storage.config";
import type { BucketName } from "./storage.config";

const ALL_BUCKETS: BucketName[] = ["media", "video", "uploads", "artifacts"];

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_ADAPTER,
      useFactory: (): StorageAdapter =>
        new S3StorageAdapter({
          endpoint: storageConfig.endpoint,
          region: storageConfig.region,
          forcePathStyle: storageConfig.forcePathStyle,
          accessKeyId: storageConfig.accessKeyId,
          secretAccessKey: storageConfig.secretAccessKey,
        }),
    },
  ],
  exports: [STORAGE_ADAPTER],
})
export class StorageModule implements OnModuleInit {
  private readonly logger = new Logger(StorageModule.name);

  constructor() {}

  async onModuleInit() {
    // Bucket bootstrap is deliberately best-effort/log-and-continue per bucket: one bucket's
    // provisioning failure (e.g. object-lock unsupported on this provider edition) must not take
    // the whole api down — the ensureBucket() call itself already swallows the
    // versioning/object-lock sub-steps for the same reason (see s3-storage.adapter.ts).
    // Skipped entirely when no endpoint is configured (e.g. some unit-test boots) so this never
    // becomes a hard dependency for suites that do not exercise storage at all.
    if (!storageConfig.endpoint) {
      this.logger.warn("STORAGE_ADAPTER: no endpoint configured — skipping bucket bootstrap");
      return;
    }
    const adapter = new S3StorageAdapter({
      endpoint: storageConfig.endpoint,
      region: storageConfig.region,
      forcePathStyle: storageConfig.forcePathStyle,
      accessKeyId: storageConfig.accessKeyId,
      secretAccessKey: storageConfig.secretAccessKey,
    });
    for (const bucket of ALL_BUCKETS) {
      try {
        await adapter.ensureBucket(storageConfig.bucketName(bucket), { versioning: true, objectLock: true });
      } catch (err) {
        this.logger.warn(`bucket '${bucket}' bootstrap failed (continuing): ${String(err)}`);
      }
    }
  }
}
