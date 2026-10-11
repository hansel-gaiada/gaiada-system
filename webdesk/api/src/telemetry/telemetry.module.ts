// M4 telemetry — flushes queued spans when Nest shuts down (main.ts enables the shutdown hooks). Registered
// in AppModule; it does nothing when telemetry never started. onApplicationShutdown runs after the HTTP
// server has closed, so the last requests' spans are in the queue by then.
import { Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { shutdownTelemetry } from "./index";

@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

@Module({ providers: [TelemetryShutdown] })
export class TelemetryModule {}
