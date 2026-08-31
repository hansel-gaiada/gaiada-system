// WSK-33/25 — THE TEST WHOSE ABSENCE SHIPPED A BROKEN APP.
//
// On 2026-08-27 a guard swap landed on main with `tsc --noEmit` clean and 135 tests passing, and
// the webdesk API could not boot at all:
//
//   Nest can't resolve dependencies of the ControlAuthGuard (?). Please make sure that the
//   argument Symbol(CONTROL_CHANNEL_AUTHENTICATOR) at index [0] is available in the
//   SchemaDraftModule context.
//
// Every suite that touched those controllers built its own Test.createTestingModule() and bound the
// guards and their collaborators BY HAND. That is fine for testing a handler, and it is blind to
// module wiring by construction: no test instantiated SchemaDraftModule as shipped, so nothing
// noticed that `@UseGuards(SomeGuard)` needs the guard's dependencies resolvable in the CONSUMING
// module's injector — exporting the guard class alone is not enough.
//
// This estate had already recorded the general lesson ("a missing module import is invisible to
// tsc"; "tsc clean is not a working app") after FormsService injected a provider whose module was
// only registered in AppModule. It happened again anyway, because there was no test that simply
// asked: does the application start?
//
// That is all this file does. It is deliberately not a feature test.
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module";

describe("the application boots (DI wiring of every module, as shipped)", () => {
  it("AppModule instantiates and the HTTP adapter becomes ready", async () => {
    // No provider overrides, no hand-bound guards: exactly the graph app.ts builds in production.
    // If a module forgets to import what its controllers' guards depend on, this is where it dies.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: ["error"],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    expect(app).toBeTruthy();
    await app.close();
  }, 60_000);
});
