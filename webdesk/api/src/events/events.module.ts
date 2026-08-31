// WSK-12 — wires the events (B->A signed webhooks) emitter.
//
// NOT registered in AppModule — same posture WSK-10/11 each already documented for their own
// modules (forms.module.ts's own header): `app.module.ts` is out of this ticket's owned scope.
// Required change, to be applied by whoever owns that file:
//
//   import { EventsModule } from "./events/events.module";
//   @Module({ imports: [..., EventsModule] })
//
// The consuming change FormsModule actually needs (inject ZoneBEventEmitterService, call
// `emitFormReceived` after the persist transaction commits, alongside the existing best-effort
// mail dispatch in forms.service.ts's `submit()`) is likewise NOT made here — forms.service.ts is
// not this ticket's owned path. The exact one-line hook is documented in the ticket report.
import { Module } from "@nestjs/common";
import { ZoneBEventEmitterService } from "./zoneb-event-emitter.service";

@Module({
  providers: [ZoneBEventEmitterService],
  exports: [ZoneBEventEmitterService],
})
export class EventsModule {}
