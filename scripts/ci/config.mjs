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
  // Reads outside platform-nest/: docs/modules/CAPABILITY-INVENTORY.md, automation/workflows/
  // pipeline-delivery.json, root scripts/replay-inbound.mjs, platform-ui/src/lib/rbac*.
  nest: ["platform-nest/", "docs/modules/", "automation/workflows/", "platform-ui/src/lib/rbac", "scripts/"],
  // platform-ui reads platform-nest's Cerbos derived_roles, rbac catalogs and the clients registry.
  ui: ["platform-ui/", "platform-nest/cerbos/", "platform-nest/src/rbac/", "platform-nest/src/modules/clients/centre/"],
  gateway: ["ai-gateway-go/"],
  // sync-engine-go applies platform-nest/migrations/*.sql to its test databases.
  sync: ["sync-engine-go/", "platform-nest/migrations/"],
  wa_chat_bot: ["wa-chat-bot/"],
  mcp_hub: ["mcp-hub/"],
  ai_agents: ["ai-agents/"],
  report_renderer: ["report-renderer/"],
  // webdesk root: migration lint + RLS selftest + compose port gate.
  webdesk_root: ["webdesk/migrations/", "webdesk/scripts/", "webdesk/package", "webdesk/docker-compose", "webdesk/postgres/", "infra/runbooks/webdesk"],
  // webdesk/api: migrations runner, storage-bootstrap, role bootstrap, payload vocabulary.
  webdesk_api: ["webdesk/api/", "webdesk/migrations/", "webdesk/scripts/", "webdesk/postgres/", "webdesk/package", "webdesk/payload/vocabulary/"],
  // blocks vendors payload/vocabulary and fails on drift.
  webdesk_blocks: ["webdesk/blocks/", "webdesk/payload/vocabulary/"],
  webdesk_payload: ["webdesk/payload/"],
  webdesk_deploy: ["webdesk/deploy/"],
  obs: ["infra/observability/", "infra/scripts/"],
};

/**
 * Release components, in matrix order. `path` is the Docker build context. `image` is the GHCR
 * package suffix (gaiada-<image>); it differs from the matrix name for none today but is explicit.
 * deploy.yml's COMPONENTS list is a SUBSET of these (webdesk-* have no Zone B box); a unit test
 * asserts that.
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
  { name: "webdesk-api", path: "webdesk/api/" },
  { name: "webdesk-payload", path: "webdesk/payload/" },
  { name: "synthetic-prober", path: "infra/observability/synthetic-prober/" },
];

/**
 * Changing these rebuilds EVERY component. Only the release workflow itself: every Dockerfile and
 * every file COPYed into an image lives inside its component's build context, and no Dockerfile
 * takes build-args, so nothing else is shared. (scripts/ci/ is deliberately NOT here: it never
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
