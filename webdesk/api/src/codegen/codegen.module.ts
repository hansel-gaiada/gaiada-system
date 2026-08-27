// WSK-15 — wires ContractReadService. `STORAGE_ADAPTER` resolves without an explicit
// `StorageModule` import here because `StorageModule` is `@Global()` (storage/storage.module.ts)
// and is already instantiated elsewhere in this app's graph (MediaModule pulls it in, per
// app.module.ts's own comment) — but importing it explicitly costs nothing and keeps this
// module's real dependency visible to a reader who has not memorized every other module's
// wiring, so it is imported anyway.
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { ContractReadService } from "./contract-read.service";

@Module({
  imports: [StorageModule],
  providers: [ContractReadService],
  exports: [ContractReadService],
})
export class CodegenModule {}
