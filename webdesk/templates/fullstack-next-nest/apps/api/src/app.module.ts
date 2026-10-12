import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

// Client business logic goes here. No database module: the data-layer decision is OPEN (see README).
@Module({ controllers: [HealthController] })
export class AppModule {}
