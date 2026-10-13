#!/usr/bin/env bash
# write-stamp.sh DIR - writes the build stamp DIR/webdesk-build.json (M6-P6f). The BUILD job runs it on the build output
# (the site root for static, the theme directory for wp), so every deploy can be read back over HTTPS.
#
# The fields WSK-60 already reads (platform-nest/src/modules/webdev/site-build-stamp.ts parseStamp): `source`, `pulledAt`,
# `maxUpdatedAt`, `itemCount`, plus `sourceSha256` as the proof site's pull step writes it. A template build reads its content
# through the vendored SDK while it builds, so it does not enumerate the content: `maxUpdatedAt`, `itemCount` and
# `sourceSha256` are honestly null, and `pulledAt` is the instant the build began (before it read anything).
# NEW: `buildId`, which deploy.sh (M6-P6e) reads: it refuses an artifact whose own stamp does not carry the expected id, and it
# polls the site until the SERVED stamp carries it. Also the commit, the run, the kind and environment, and for a dispatch the
# approval and publish time the ERP sent.
#
# Inputs (environment): STAMP_BUILD_ID STAMP_COMMIT STAMP_KIND STAMP_ENVIRONMENT STAMP_PULLED_AT STAMP_TRIGGER STAMP_RUN_ID
# STAMP_RUN_ATTEMPT; optional STAMP_APPROVAL_ID STAMP_PUBLISHED_AT. No secret is read or written.
set -euo pipefail

dir="${1:?usage: write-stamp.sh DIR}"
[ -d "$dir" ] || { echo "write-stamp: not a directory: $dir" >&2; exit 2; }
need() { [ -n "${!1:-}" ] || { echo "write-stamp: $1 is required" >&2; exit 2; }; }
for v in STAMP_BUILD_ID STAMP_COMMIT STAMP_KIND STAMP_ENVIRONMENT STAMP_PULLED_AT STAMP_TRIGGER STAMP_RUN_ID STAMP_RUN_ATTEMPT; do need "$v"; done

[[ "$STAMP_BUILD_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "write-stamp: the build id is not [A-Za-z0-9._-]{1,64}" >&2; exit 2; }
[[ "$STAMP_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "write-stamp: the commit is not a 40-hex sha" >&2; exit 2; }
[[ "$STAMP_RUN_ID" =~ ^[0-9]+$ && "$STAMP_RUN_ATTEMPT" =~ ^[0-9]+$ ]] || { echo "write-stamp: run id/attempt are not numbers" >&2; exit 2; }

jq -n \
  --arg buildId "$STAMP_BUILD_ID" --arg pulledAt "$STAMP_PULLED_AT" --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "$STAMP_COMMIT" --arg kind "$STAMP_KIND" --arg environment "$STAMP_ENVIRONMENT" --arg trigger "$STAMP_TRIGGER" \
  --argjson runId "$STAMP_RUN_ID" --argjson runAttempt "$STAMP_RUN_ATTEMPT" \
  --arg approvalId "${STAMP_APPROVAL_ID:-}" --arg publishedAt "${STAMP_PUBLISHED_AT:-}" \
  '{ source: "webdesk", buildId: $buildId, pulledAt: $pulledAt, maxUpdatedAt: null, itemCount: null, sourceSha256: null,
     builtAt: $builtAt, commit: $commit, kind: $kind, environment: $environment, trigger: $trigger, runId: $runId, runAttempt: $runAttempt }
   + (if $approvalId != "" then { approvalId: $approvalId } else {} end)
   + (if $publishedAt != "" then { publishedAt: $publishedAt } else {} end)' \
  | tr -d '\r' >"$dir/webdesk-build.json"
echo "write-stamp: wrote $dir/webdesk-build.json (build $STAMP_BUILD_ID)"
