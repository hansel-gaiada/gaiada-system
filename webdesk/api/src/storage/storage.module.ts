// WSK-07 / WSK-52 — wires the concrete S3StorageAdapter behind the STORAGE_ADAPTER token.
//
// WSK-52: the api no longer CREATES or CONFIGURES buckets. Its credential is a least-privilege
// service key (object CRUD + list only — it cannot create buckets, change versioning/object-lock
// or write bucket policies), so bucket provisioning (the four buckets, versioning, GOVERNANCE
// default retention, optional public-read policies) is done once, idempotently, by
// webdesk/scripts/storage-bootstrap.mjs using the storage ROOT credential. On boot the api only
// VERIFIES that each bucket is reachable and logs loudly if not.
import { Global, Logger, Module, OnModuleInit } from "@nestjs/common";
import { S3StorageAdapter } from "./s3-storage.adapter";
import { STORAGE_ADAPTER } from "./storage.tokens";
import type { StorageAdapter } from "./storage.types";
import { storageConfig } from "./storage.config";
import type { BucketName } from "./storage.config";

const ALL_BUCKETS: BucketName[] = ["media", "video", "uploads", "artifacts"];

function buildAdapter(): S3StorageAdapter {
  if (!storageConfig.endpoint) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[webdesk:api] STORAGE_ENDPOINT is not set — refusing to boot in production.");
    }
    // Non-production boot with no storage configured (e.g. a unit-test boot that never touches
    // storage): an inert client with placeholder credentials. Any real call fails; nothing is
    // silently authenticated as root.
    return new S3StorageAdapter({
      endpoint: "http://storage-not-configured.invalid",
      region: storageConfig.region,
      forcePathStyle: storageConfig.forcePathStyle,
      accessKeyId: "unconfigured",
      secretAccessKey: "unconfigured",
    });
  }
  return new S3StorageAdapter({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    forcePathStyle: storageConfig.forcePathStyle,
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
  });
}

@Global()
@Module({
  providers: [{ provide: STORAGE_ADAPTER, useFactory: (): StorageAdapter => buildAdapter() }],
  exports: [STORAGE_ADAPTER],
})
export class StorageModule implements OnModuleInit {
  private readonly logger = new Logger(StorageModule.name);

  async onModuleInit() {
    // Verify-only and log-and-continue per bucket: a missing bucket must not take the whole api
    // down (suites that never touch storage boot this module too), but it must be LOUD.
    if (!storageConfig.endpoint) {
      this.logger.warn("STORAGE_ADAPTER: no endpoint configured — skipping bucket verification");
      return;
    }
    const adapter = buildAdapter();
    for (const bucket of ALL_BUCKETS) {
      const name = storageConfig.bucketName(bucket);
      try {
        if (!(await adapter.bucketReachable(name))) {
          this.logger.error(`bucket '${name}' does not exist — run webdesk/scripts/storage-bootstrap.mjs (root credential)`);
        }
      } catch (err) {
        this.logger.warn(`bucket '${name}' verification failed (continuing): ${String(err)}`);
      }
    }
  }
}
