// WSK-07 — media-module env config. CLAMAV_HOST/CLAMAV_PORT already exist in .env.example
// (WSK-01's file). IMGPROXY_* do NOT exist yet anywhere in this project — flagged here and in the
// ticket report as a required .env.example + docker-compose.yml addition; this ticket does not
// edit either file (both are out of scope), so ImgproxyService below runs in a documented
// "no imgproxy configured" mode until that lands, and its own unit test exercises URL-building
// logic without a live imgproxy.
export const mediaConfig = {
  get clamAvHost(): string {
    return process.env.CLAMAV_HOST || "localhost";
  },
  get clamAvPort(): number {
    return Number(process.env.CLAMAV_PORT ?? 3310);
  },
  get clamAvTimeoutMs(): number {
    return Number(process.env.WEBDESK_CLAMAV_TIMEOUT_MS ?? 15_000);
  },

  /** Base URL of an imgproxy instance, e.g. http://imgproxy:8080. Empty = not configured. */
  get imgproxyUrl(): string {
    return process.env.IMGPROXY_URL || "";
  },
  get imgproxyKeyHex(): string {
    return process.env.IMGPROXY_KEY || "";
  },
  get imgproxySaltHex(): string {
    return process.env.IMGPROXY_SALT || "";
  },
};
