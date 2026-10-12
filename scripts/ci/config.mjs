// WSK-69 — the ONE place that says which paths each CI job group and each release component depends on.
//
// A prefix ending in "/" matches a directory; any other prefix is a plain startsWith (so
// "platform-ui/src/lib/rbac" covers rbac.ts and rbac-*.ts). When in doubt a dependency is listed:
// a wrongly-listed path costs a few runner minutes, a wrongly-omitted one lets a break through.
//
// Cross-component reads were found by grepping each component's tests and scripts for paths that
// leave their own directory (see the notes on each group). Everything else is self-contained.

/** Changing any of these forces EVERY ci job to run. */
export const CI_SHARED = [".github/workflows/ci.yml", "scripts/ci/"];

/**
 * CI job groups. Keys are the plan-job output names (see ci.yml). A group runs when any changed file
 * matches any of its prefixes, or any CI_SHARED prefix matches.
 */
export const CI_GROUPS = {
  // platform-nest jobs: nest-static-gates, platform-nest shards, nest-corpus-perf.
  // WSK-49c: platform-nest VENDORS webdesk/delivery/vocabulary (src/modules/webdev/vocabulary, drift-checked by
  // vocabulary-vendor.test.ts), so a change to that source must run the nest tests too.
  // Reads outside platform-nest/: docs/modules/CAPABILITY-INVENTORY.md, automation/workflows/
  // pipeline-delivery.json, root scripts/replay-inbound.mjs, platform-ui/src/lib/rbac*.
  // contracts/ holds cross-package wire fixtures (contracts/zoneb/*: WebDesk -> ERP Zone B envelopes), read by tests on BOTH sides.
  nest: ["platform-nest/", "docs/modules/", "automation/workflows/", "platform-ui/src/lib/rbac", "scripts/", "contracts/", "webdesk/delivery/vocabulary/"],
  // platform-ui reads platform-nest's Cerbos derived_roles, rbac catalogs and the clients registry.
  ui: ["platform-ui/", "platform-nest/cerbos/", "platform-nest/src/rbac/", "platform-nest/src/modules/clients/centre/"],
  gateway: ["ai-gateway-go/"],
  // M5-V2-b: the enrichment collector (Go). Self-contained; its Postgres test makes its own schema.
  insights_collector: ["insights-collector/"],
  // sync-engine-go applies platform-nest/migrations/*.sql to its test databases.
  sync: ["sync-engine-go/", "platform-nest/migrations/"],
  wa_chat_bot: ["wa-chat-bot/"],
  mcp_hub: ["mcp-hub/"],
  ai_agents: ["ai-agents/"],
  report_renderer: ["report-renderer/"],
  // webdesk root: migration lint + RLS selftest + compose port gate.
  webdesk_root: ["webdesk/migrations/", "webdesk/scripts/", "webdesk/package", "webdesk/docker-compose", "webdesk/postgres/", "infra/runbooks/webdesk"],
  // webdesk/api: migrations runner, storage-bootstrap, role bootstrap, and webdesk/delivery/ (the
  // vocabulary the api vendors, plus the vocabulary tests this job runs; WSK-48b renamed it from
  // webdesk/payload/ when Payload was deleted). M6-P4r-a: webdesk/blocks/ too, because the api image
  // packs the block library into a tarball it ships (a blocks-only change changes the image).
  webdesk_api: ["webdesk/api/", "webdesk/blocks/", "webdesk/migrations/", "webdesk/scripts/", "webdesk/postgres/", "webdesk/package", "webdesk/delivery/", "contracts/"],
  // blocks vendors delivery/vocabulary and fails on drift.
  webdesk_blocks: ["webdesk/blocks/", "webdesk/delivery/vocabulary/"],
  webdesk_deploy: ["webdesk/deploy/"],
  // M6-P5b: the WordPress theme + its php-cli probes. The vendored block list derives from
  // delivery/vocabulary, and sdk-php.mts generates the PHP SDK fixture the probes load.
  webdesk_wordpress: ["webdesk/wordpress/", "webdesk/delivery/vocabulary/", "webdesk/api/src/codegen/generator/sdk-php.mts"],
  // + the compose file and the write-only auditor that gate the WebDesk OTLP receiver (WSK-D63 (2)).
  obs: ["infra/observability/", "infra/scripts/", "infra/compose/docker-compose.observability", "webdesk/ops/scripts/check-otlp-write-only"],
};

/**
 * Release components, in matrix order. `path` is the component's own directory (for most, the Docker
 * build context). `deps` (optional) lists further path prefixes that reach the image: a change under
 * any of them rebuilds the component instead of re-tagging the previous image. webdesk-api builds
 * from the ./webdesk context (M6-P4r-a) and bakes in the block-library tarball and the vocabulary
 * the contract generator inlines, so webdesk/blocks/ and webdesk/delivery/vocabulary/ are deps.
 * `image` is the GHCR package suffix (gaiada-<image>); it differs from the matrix name for none
 * today but is explicit. deploy.yml's COMPONENTS list is a SUBSET of these (webdesk-* have no
 * Zone B box); a unit test asserts that.
 */
export const COMPONENTS = [
  { name: "wa-chat-bot", path: "wa-chat-bot/" },
  { name: "mcp-hub", path: "mcp-hub/" },
  { name: "ai-agents", path: "ai-agents/" },
  { name: "ai-gateway-go", path: "ai-gateway-go/" },
  { name: "sync-engine-go", path: "sync-engine-go/" },
  { name: "search-crawl-go", path: "search-crawl-go/" },
  { name: "platform-nest", path: "platform-nest/" },
  { name: "platform-ui", path: "platform-ui/" },
  { name: "report-renderer", path: "report-renderer/" },
  { name: "webdesk-api", path: "webdesk/api/", deps: ["webdesk/blocks/", "webdesk/delivery/vocabulary/"] },
  { name: "synthetic-prober", path: "infra/observability/synthetic-prober/" },
  // M5-V2-b: runs on sumopod (compose project `umami`, V2-c); NOT in deploy.yml COMPONENTS on purpose.
  { name: "insights-collector", path: "insights-collector/" },
];

/**
 * Changing these rebuilds EVERY component. Only the release workflow itself: every Dockerfile and
 * every file COPYed into an image lives inside its component's build context (webdesk-api's is
 * ./webdesk; the parts of it outside webdesk/api/ are that component's `deps`), and the only
 * build-args (webdesk-api's block-library sha256) are computed by release.yml from webdesk/blocks/,
 * so nothing else is shared. (scripts/ci/ is deliberately NOT here: it never
 * reaches an image.)
 */
export const RELEASE_SHARED = [".github/workflows/release.yml"];

/** Base images are floating tags (node:22-alpine ...), so an unchanged component is rebuilt if its
 *  previous image is older than this, to pick up base-image security patches. */
export const MAX_REUSE_AGE_DAYS = 30;

/** How many previous release tags to walk back through looking for a signed image per component. */
export const MAX_CANDIDATE_TAGS = 6;

/** Tags release.yml triggers on. */
export const RELEASE_TAG_RE = /^(v|alpha-|beta-|rc-|stable-)/;
