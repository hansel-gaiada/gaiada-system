import { buildApp } from "./app";
import { config } from "./config";

async function bootstrap() {
  const app = await buildApp();
  await app.listen(config.port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`[webdesk:api] listening on :${config.port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[webdesk:api] fatal boot error:", err);
  process.exit(1);
});
