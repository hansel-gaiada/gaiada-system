#!/usr/bin/env bash
# Render traefik.yml from traefik.yml.template. Usage:  ./render-config.sh <mimi-source-cidr> <acme-email>
# e.g.  ./render-config.sh 172.28.92.1/32 ops@example.com
set -euo pipefail
cd "$(dirname "$0")"
src="${1:?usage: render-config.sh <mimi source address as a /32 CIDR> <acme email>}"
mail="${2:?usage: render-config.sh <mimi source address as a /32 CIDR> <acme email>}"
[[ "$src" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/32$ ]] || { echo "trusted source must be one IPv4 /32, got: $src" >&2; exit 1; }
[[ "$src" == 0.0.0.0/* ]] && { echo "refusing 0.0.0.0" >&2; exit 1; }
[[ "$mail" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "bad e-mail" >&2; exit 1; }
sed -e "s#__MIMI_SOURCE__#${src}#" -e "s#__ACME_EMAIL__#${mail}#" traefik.yml.template > traefik.yml.new
grep -q '__' traefik.yml.new && { echo "placeholder left" >&2; rm -f traefik.yml.new; exit 1; }
mv traefik.yml.new traefik.yml
echo "rendered traefik.yml (trusted PROXY source: $src)"
