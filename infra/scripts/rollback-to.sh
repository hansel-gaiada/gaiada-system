#!/usr/bin/env sh
# MON-09e — roll the stack back to a previously deployed tag.
#
# WHY THIS IS NOT JUST `docker compose up -d`:
# A release that ADDS a service (report-renderer did; the observability stack added eleven) has no
# image for that service at the PREVIOUS tag, because it was never built there. The naive rollback
#   GAIADA_TAG=<prev> docker compose ... up -d --no-build
# therefore dies on `ghcr.io/<owner>/gaiada-<new>:<prev>: not found` — and it dies PART WAY THROUGH,
# after compose has already stopped and recreated some services. The stack is then neither the new
# release nor the old one, which is strictly worse than either.
#
# The correct semantics: rolling back to <prev> means "return to the state of <prev>". A service that
# did not exist in <prev> should be REMOVED, not started. That is what this does:
#   1. resolve every service's image at <prev> from the merged compose config,
#   2. any of OUR images (ghcr.io/$GHCR_OWNER/...) absent locally => that service is new in the
#      failed release => it cannot and must not be rolled back to,
#   3. bring up everything else explicitly, then stop+remove the new ones.
#
# `--remove-orphans` is deliberately NOT used: this brings services up by explicit name, and
# --remove-orphans would then delete every container not on that list, including other compose
# projects' work and any profile not in COMPOSE_PROFILES.
#
# Usage (from infra/compose):
#   GAIADA_TAG=<prev> GHCR_OWNER=<owner> COMPOSE_PROFILES=<profiles> \
#     sh ../scripts/rollback-to.sh -f docker-compose.vps.yml -f docker-compose.hostdata.yml ...
set -eu

: "${GAIADA_TAG:?GAIADA_TAG (the tag to roll back TO) is required}"
: "${GHCR_OWNER:?GHCR_OWNER is required}"

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi
DRY_RUN="${DRY_RUN:-0}"

if [ "$#" -eq 0 ]; then
  echo "rollback-to.sh: no compose files given" >&2
  exit 2
fi

echo "rollback-to: target tag ${GAIADA_TAG}${DRY_RUN:+ }$( [ "$DRY_RUN" = 1 ] && echo '(DRY RUN — no changes)')"

# Service -> image, straight from the merged config so it reflects every override file and the
# resolved ${GAIADA_TAG}. python3 rather than jq: python3 is present on the box, jq is not.
PAIRS=$(docker compose "$@" config --format json | python3 -c '
import json,sys
cfg = json.load(sys.stdin)
for name, svc in sorted((cfg.get("services") or {}).items()):
    img = svc.get("image")
    if img:
        print(name + "\t" + img)
')

KEEP=""
DROP=""
OURS_ALL=""   # every service whose image is one of ours, kept or dropped
# Tab-delimited read rather than word-splitting `for`: a `for line in $(...)` splits on IFS and
# would corrupt any value containing whitespace. Nothing here should contain a space, but the
# rollback path is the one place where "should" is not good enough.
while IFS="$(printf '	')" read -r svc img; do
  [ -n "$svc" ] || continue
  case "$img" in
    ghcr.io/"$GHCR_OWNER"/*)
      OURS_ALL="$OURS_ALL $svc"
      if docker image inspect "$img" >/dev/null 2>&1; then
        KEEP="$KEEP $svc"
      else
        # Ours, and not on the box at this tag => introduced by the release we are backing out of.
        DROP="$DROP $svc"
        echo "rollback-to: '$svc' has no image at ${GAIADA_TAG} ($img) — new in the failed release; will remove"
      fi
      ;;
    *)
      # Third-party pinned images (postgres, grafana, prom/*) are tag-independent of ours.
      KEEP="$KEEP $svc"
      ;;
  esac
done <<EOF
$PAIRS
EOF

# ── THE SAFETY GATE ─────────────────────────────────────────────────────────────────────────────
# Found by testing this script with a deliberately bogus tag: EVERY one of our images was absent, so
# every one of our services classified as "new in the failed release", and the script's next move
# would have been to delete the entire application. That is the opposite of a rollback.
#
# The distinction the classifier cannot make on its own: "this service is new" and "this TAG is
# wrong" look identical from a single missing image. They are told apart by PROPORTION. A real
# release adds a service or two; a wrong tag is missing all of them.
#
# So: refuse unless the target tag looks like a tag we actually shipped. Two independent checks,
# because either alone can be fooled by an unlucky compose file.
OURS_KEPT=0
for s_ in $KEEP; do
  case " $OURS_ALL " in *" $s_ "*) OURS_KEPT=$((OURS_KEPT + 1)) ;; esac
done
OURS_DROPPED=0
for s_ in $DROP; do
  OURS_DROPPED=$((OURS_DROPPED + 1))
done

if [ "$OURS_KEPT" -eq 0 ]; then
  echo "rollback-to: REFUSING — not one of our images exists at ${GAIADA_TAG}." >&2
  echo "rollback-to: that is a wrong/never-built tag, not a release that added services." >&2
  echo "rollback-to: proceeding would delete every application container. Nothing was changed." >&2
  exit 1
fi

if [ "$OURS_DROPPED" -gt "$OURS_KEPT" ]; then
  echo "rollback-to: REFUSING — ${OURS_DROPPED} of our services are missing at ${GAIADA_TAG} but only ${OURS_KEPT} are present." >&2
  echo "rollback-to: a real release adds a service or two; this looks like a wrong tag." >&2
  echo "rollback-to: re-run with a verified tag, or remove services by hand. Nothing was changed." >&2
  exit 1
fi

if [ -z "$KEEP" ]; then
  echo "rollback-to: refusing — resolved ZERO services to bring up. Compose config or tag is wrong." >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "rollback-to: DRY RUN — would bring up:$KEEP"
  echo "rollback-to: DRY RUN — would remove:${DROP:- (none)}"
  exit 0
fi

# shellcheck disable=SC2086
docker compose "$@" up -d --no-build $KEEP

if [ -n "$DROP" ]; then
  # shellcheck disable=SC2086
  docker compose "$@" rm -sf $DROP
  echo "rollback-to: removed services that did not exist at ${GAIADA_TAG}:$DROP"
fi

echo "rollback-to: complete at ${GAIADA_TAG}"
