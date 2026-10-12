// M6-P4r-b -- wires the live contract-codegen rail: the queue, the fail-soft trigger the commands call,
// the worker, the per-tenant advisory lock and the production runner (the compiled generator bundle).
//
// Imported by ControlModule (whose commands trigger it) and NOT by AppModule directly: ControlModule is
// already imported there, and Nest modules are singletons, so this adds one queue and one worker to the
// real app. DbModule is @Global. A spec replaces the runner with
// `.overrideProvider(CONTRACT_CODEGEN_RUNNER).useValue(fake)` and the queue with
// `.overrideProvider(ContractCodegenQueue).useValue(fake)`.
import { Module } from "@nestjs/common";
import { ContractCodegenQueue } from "./contract-codegen.queue";
import { ContractCodegenTrigger } from "./contract-codegen.trigger";
import { ContractCodegenProcessor } from "./contract-codegen.processor";
import { PgContractCodegenLock } from "./contract-codegen.lock";
import { CompiledContractCodegenRunner } from "./contract-codegen.runner";
import { CONTRACT_CODEGEN_LOCK, CONTRACT_CODEGEN_RUNNER } from "./contract-codegen.types";

@Module({
  providers: [
    ContractCodegenQueue,
    ContractCodegenTrigger,
    ContractCodegenProcessor,
    { provide: CONTRACT_CODEGEN_RUNNER, useClass: CompiledContractCodegenRunner },
    { provide: CONTRACT_CODEGEN_LOCK, useClass: PgContractCodegenLock },
  ],
  exports: [ContractCodegenTrigger, ContractCodegenQueue],
})
export class ContractCodegenModule {}
