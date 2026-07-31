// SM-58 QA-adversarial — an INDEPENDENT precedence probe, deliberately not reusing
// last-resort-exception.filter.test.ts's ProbeController/ProbeModule or its filter set. The point
// of a second QA pass is to not just trust the existing empirical proof; this rebuilds the same
// claim ("the LAST argument to useGlobalFilters(...) is checked FIRST") from scratch with a
// different exception type and a different catch-all, so a bug specific to the original probe's
// shape (e.g. an accidental dependency on HttpException specifically) can't hide the truth.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyReply } from "fastify";

class NarrowFault extends RangeError {}

@Catch(NarrowFault)
class NarrowFilter implements ExceptionFilter {
  catch(_exception: NarrowFault, host: ArgumentsHost): void {
    void host.switchToHttp().getResponse<FastifyReply>().status(418).send({ from: "narrow" });
  }
}

@Catch()
class CatchAllFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost): void {
    void host.switchToHttp().getResponse<FastifyReply>().status(500).send({ from: "catch-all" });
  }
}

@Controller()
class ProbeController2 {
  @Get("narrow")
  throwNarrow(): never {
    throw new NarrowFault("narrow fault");
  }
}

@Module({ controllers: [ProbeController2] })
class ProbeModule2 {}

async function buildApp(filters: unknown[]): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(ProbeModule2, new FastifyAdapter(), { logger: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.useGlobalFilters(...(filters as any[]));
  await app.init();
  return app;
}

describe("SM-58 QA-adversarial · independent precedence probe (own filters, own error type)", () => {
  it("catch-all FIRST argument -> NarrowFilter wins (418), matching the main.ts shape", async () => {
    const app = await buildApp([new CatchAllFilter(), new NarrowFilter()]);
    try {
      const res = await app.inject({ method: "GET", url: "/narrow" });
      expect(res.statusCode).toBe(418);
      expect(res.json()).toEqual({ from: "narrow" });
    } finally {
      await app.close();
    }
  });

  it("catch-all LAST argument -> catch-all wins (500), shadowing NarrowFilter — the mistake main.ts must avoid", async () => {
    const app = await buildApp([new NarrowFilter(), new CatchAllFilter()]);
    try {
      const res = await app.inject({ method: "GET", url: "/narrow" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ from: "catch-all" });
    } finally {
      await app.close();
    }
  });
});
