#!/usr/bin/env bash
# plan.sh - decides, from the trigger alone, whether this run deploys and to which environment (M6-P6f).
# It runs in the BUILD job, which holds no deploy credential, and its answer gates the deploy job.
#
#   one deploy job, two triggers:
#     push to the default branch      -> deploys STAGING
#     push to any other branch / tag  -> deploys nothing (the build still verifies)
#     pull_request                    -> deploys nothing
#     workflow_dispatch (the ERP's WSK-60 chokepoint: inputs approval_id, kind, published_at)
#                                     -> rebuilds STAGING (kind publish | rebuild), or
#                                        deploys PRODUCTION only when environment=production AND kind=promote
#                                        AND an approval id is present. Anything else is REFUSED (exit 1), never
#                                        quietly downgraded: a dispatch that asked for production and did not get it
#                                        must not look like a green staging rebuild.
#
# Inputs (environment, never argv): PLAN_EVENT PLAN_REF PLAN_DEFAULT_BRANCH PLAN_IS_TEMPLATE and, for a dispatch,
# PLAN_IN_APPROVAL_ID PLAN_IN_KIND PLAN_IN_PUBLISHED_AT PLAN_IN_ENVIRONMENT.
# Output (stdout, one `key=value` per line, for $GITHUB_OUTPUT): deploy=true|false, environment=staging|production,
# reason=<one line>. Exit 1 with a `::error::` line when a dispatch is refused.
set -uo pipefail

event="${PLAN_EVENT:-}"
ref="${PLAN_REF:-}"
default_branch="${PLAN_DEFAULT_BRANCH:-}"
is_template="${PLAN_IS_TEMPLATE:-false}"
in_approval="${PLAN_IN_APPROVAL_ID:-}"
in_kind="${PLAN_IN_KIND:-}"
in_published="${PLAN_IN_PUBLISHED_AT:-}"
in_env="${PLAN_IN_ENVIRONMENT:-}"

out() { printf 'deploy=%s\nenvironment=%s\nreason=%s\n' "$1" "$2" "$3"; }
# Only a plain, short ref name is ever echoed back (it is attacker-chosen text in a log line).
safe() { printf '%s' "$1" | LC_ALL=C tr -cd 'A-Za-z0-9._/-' | cut -c1-80; }
refuse() { printf '::error::%s\n' "$*"; exit 1; }

if [ "$is_template" = true ]; then out false staging "this repo is a template; nothing builds or deploys from it"; exit 0; fi
[ -n "$default_branch" ] || refuse "the repository's default branch is unknown; refusing to decide anything"

case "$event" in
  push)
    if [ "$ref" = "refs/heads/$default_branch" ]; then
      out true staging "a push to the default branch deploys staging"
    else
      out false staging "a push to $(safe "${ref#refs/heads/}") deploys nothing: only the default branch ($(safe "$default_branch")) deploys"
    fi
    ;;
  pull_request | pull_request_target)
    out false staging "a pull request builds and verifies; it deploys nothing"
    ;;
  workflow_dispatch)
    [ "$ref" = "refs/heads/$default_branch" ] \
      || refuse "a dispatch from $(safe "${ref#refs/heads/}") is refused: deploys come from the default branch ($(safe "$default_branch")) only"
    [[ "$in_approval" =~ ^[A-Za-z0-9-]{8,64}$ ]] \
      || refuse "dispatch refused: approval_id is missing or malformed (the ERP's deploy chokepoint always sends the approval that authorised it)"
    case "$in_kind" in
      publish | rebuild | promote) ;;
      *) refuse "dispatch refused: kind must be publish, rebuild or promote" ;;
    esac
    if [ -n "$in_published" ] && ! [[ "$in_published" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{5,20}(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
      refuse "dispatch refused: published_at is not an ISO-8601 timestamp"
    fi
    case "${in_env:-staging}" in
      staging)
        [ "$in_kind" != promote ] || refuse "dispatch refused: a promote deploys to production; this one asked for staging"
        out true staging "an approved $in_kind dispatch rebuilds staging"
        ;;
      production)
        [ "$in_kind" = promote ] \
          || refuse "dispatch refused: production is deployed only by an approved promote (kind=promote), not by a $in_kind"
        out true production "an approved promote deploys production"
        ;;
      *) refuse "dispatch refused: environment must be staging or production" ;;
    esac
    ;;
  *)
    out false staging "the $(safe "$event") event deploys nothing"
    ;;
esac
