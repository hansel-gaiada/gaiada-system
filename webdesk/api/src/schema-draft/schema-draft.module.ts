// WSK-32 — registered directly in ../app.module.ts (this ticket's one permitted cross-file edit;
// see final report). NOT nested inside ../control/control.module.ts — see
// schema-draft-auth.guard.ts's header for why.
import { Module } from "@nestjs/common";
import { TenantsModule } from "../tenants/tenants.module";
import { AuditModule } from "../audit/audit.module";
import { SchemaDraftService } from "./schema-draft.service";
import { SchemaDraftController } from "./schema-draft.controller";
// WSK-32 (coordinator edit) — the REAL control-channel guard, replacing this module's own
// dev-mode stub. ControlModule now exports it; see that file's `exports` comment.
import { ControlModule } from "../control/control.module";

@Module({
  // DbModule is @Global (../db/db.module.ts) so DbService needs no import here.
  imports: [TenantsModule, AuditModule, ControlModule],
  controllers: [SchemaDraftController],
  providers: [SchemaDraftService],
})
export class SchemaDraftModule {}
