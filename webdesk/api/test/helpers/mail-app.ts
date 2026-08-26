// WSK-11 test bootstrap — a SEPARATE, minimal Nest application, importing only DbModule (Global,
// but still needs importing once into a bootstrap graph) + MailModule. This exists because
// MailModule is NOT registered in the real AppModule — app.module.ts is out of this ticket's
// owned paths (report: the exact import + imports-array line the app.module.ts owner needs to
// add). Every mail-*.spec.ts file boots THIS app, not src/app.ts's buildApp(), so these tests do
// not depend on — and cannot be broken by — whether/when MailModule lands in the shared
// AppModule. Mirrors src/app.ts's own buildApp()/stopTestApp() split on purpose.
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DbModule } from "../../src/db/db.module";
import { MailModule } from "../../src/mail/mail.module";

@Module({ imports: [DbModule, MailModule] })
class MailTestAppModule {}

export async function startMailTestApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(MailTestAppModule, new FastifyAdapter(), {
    logger: process.env.NODE_ENV === "test" ? ["error"] : ["error", "warn", "log"],
    abortOnError: false,
  });
  await app.init();
  return app;
}

export async function stopMailTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
}
