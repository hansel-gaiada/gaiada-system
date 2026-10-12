// M6-P4r-b -- the Nest graph wires the new rail: ControlModule resolves the trigger, the queue, the worker, the
// production runner (the compiled bundle) and the advisory lock, and hands the trigger to the two commands.
// COMPILE ONLY (no init): DbService opens its pool lazily, so this needs no database, Redis or RustFS. A missing
// provider or a bad injection fails here, in the service-free run, instead of at the first boot on a server.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:unused@localhost:1/webdesk";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "contract-codegen-wiring-pepper";

import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { ControlModule } from "../src/control/control.module";
import { ContractCodegenQueue } from "../src/codegen/contract-codegen.queue";
import { ContractCodegenTrigger } from "../src/codegen/contract-codegen.trigger";
import { ContractCodegenProcessor } from "../src/codegen/contract-codegen.processor";
import { PgContractCodegenLock } from "../src/codegen/contract-codegen.lock";
import { CompiledContractCodegenRunner } from "../src/codegen/contract-codegen.runner";
import { CONTRACT_CODEGEN_LOCK, CONTRACT_CODEGEN_RUNNER } from "../src/codegen/contract-codegen.types";
import { LifecycleService } from "../src/control/lifecycle/lifecycle.service";
import { SchemaService } from "../src/control/schema/schema.service";
import { ContractRegenerateService } from "../src/control/contract/contract-regenerate.service";
import { DbService } from "../src/db/db.service";

describe("contract codegen wiring (compile only)", () => {
  it("ControlModule resolves the whole rail, with the production runner and the Postgres lock bound by default", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ControlModule] }).compile();
    try {
      expect(moduleRef.get(ContractCodegenQueue, { strict: false })).toBeInstanceOf(ContractCodegenQueue);
      expect(moduleRef.get(ContractCodegenTrigger, { strict: false })).toBeInstanceOf(ContractCodegenTrigger);
      expect(moduleRef.get(ContractCodegenProcessor, { strict: false })).toBeInstanceOf(ContractCodegenProcessor);
      expect(moduleRef.get(CONTRACT_CODEGEN_RUNNER, { strict: false })).toBeInstanceOf(CompiledContractCodegenRunner);
      expect(moduleRef.get(CONTRACT_CODEGEN_LOCK, { strict: false })).toBeInstanceOf(PgContractCodegenLock);
      expect(moduleRef.get(LifecycleService, { strict: false })).toBeInstanceOf(LifecycleService);
      expect(moduleRef.get(SchemaService, { strict: false })).toBeInstanceOf(SchemaService);
      expect(moduleRef.get(ContractRegenerateService, { strict: false })).toBeInstanceOf(ContractRegenerateService);
    } finally {
      await moduleRef.get(DbService, { strict: false }).pool.end();
    }
  });
});
