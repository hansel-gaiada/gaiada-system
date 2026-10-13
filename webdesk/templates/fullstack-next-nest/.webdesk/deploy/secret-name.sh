#!/usr/bin/env bash
# secret-name.sh SLUG ENVIRONMENT REPOSITORY_ID  >  name
#
# The name of a site's per-site deploy secret (M6-P6f; the ERP side is siteDeploySecretName() in
# platform-nest/src/modules/webdev/deploy-grant.ts, and both are tested against secret-name.fixture.json):
#
#   WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>      e.g. WEBDESK_DEPLOY_ACME_SITE_STAGING_123456789
#
# SLUG and ENV are uppercased, every character outside A-Z0-9 becomes an underscore. REPOID is the GitHub
# repository's numeric id (`github.repository_id` in a workflow): globally unique, so it carries the identity
# and two sites can never share a name; a repository the workflow runs in always knows it, a provisioned
# site's own id it never does. In a workflow: SLUG = github.event.repository.name, REPOID = github.repository_id.
#
# Exit 0 and the name on stdout; exit 2 and a reason on stderr when an input is not usable (nothing printed).
set -uo pipefail

die() { printf 'secret-name: %s\n' "$*" >&2; exit 2; }
[ "$#" -eq 3 ] || die "usage: secret-name.sh SLUG ENVIRONMENT REPOSITORY_ID"
slug="$1" env_="$2" repo_id="$3"

# A repository name is [A-Za-z0-9._-]; an environment is a word of the same alphabet. Anything else is refused,
# never silently mapped (a different alphabet could make two sites collide).
[[ "$slug" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || die "the slug is empty or holds a character outside A-Z a-z 0-9 . _ -"
[[ "$env_" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "the environment is empty or holds a character outside A-Z a-z 0-9 . _ -"
[[ "$repo_id" =~ ^[1-9][0-9]{0,15}$ ]] || die "the repository id is not a positive integer"
(( repo_id <= 9007199254740991 )) || die "the repository id is above the safe integer range"

part() { printf '%s' "$1" | LC_ALL=C tr 'a-z' 'A-Z' | LC_ALL=C sed 's/[^A-Z0-9]/_/g'; }
name="WEBDESK_DEPLOY_$(part "$slug")_$(part "$env_")_${repo_id}"

# A GitHub Actions secret name: letters, digits, underscore; not starting with a digit or GITHUB_; at most 200 characters here.
[[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]{0,199}$ ]] || die "the derived name is not a valid GitHub secret name"
printf '%s\n' "$name"
