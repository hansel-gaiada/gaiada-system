import { Global, Module } from "@nestjs/common";
import { DbService } from "./db.service";
import { config } from "../config";

@Global()
@Module({
  providers: [
    {
      provide: DbService,
      useFactory: () => new DbService(config.appDatabaseUrl, config.dbPoolMax),
    },
  ],
  exports: [DbService],
})
export class DbModule {}
