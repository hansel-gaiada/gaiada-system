// WSK-07 test bootstrap. Not matched by vitest's `test/**/*.spec.ts` include (see
// vitest.config.ts) — a plain helper module, same purpose as test/helpers/app.ts but scoped to
// JUST the media subsystem, because `app.module.ts` does NOT import MediaModule yet (that wiring
// is explicitly out of this ticket's owned scope — see the ticket report's "required
// app.module.ts line" section). Building a standalone Nest testing module here lets this
// ticket's suite exercise the real MediaModule/StorageModule/guards end-to-end without touching
// the shared root module another worker also needs.
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DbModule } from "../src/db/db.module";
import { MediaModule } from "../src/media/media.module";
import { StorageModule } from "../src/storage/storage.module";

export async function buildMediaTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DbModule, StorageModule, MediaModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: ["error"],
    abortOnError: false,
  });
  await app.init();
  return app;
}

export async function stopMediaTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
}
