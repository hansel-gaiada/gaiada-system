#!/usr/bin/env bash
# AIP-00a step 1 (runbook infra/runbooks/aip-00a-hermes-behind-gateway.md), run as root on helios.
# Writes one fresh 256-bit token per agent into that agent's own .env (HERMES_HOME = its profile dir),
# keeps a backup, and prints ONLY name:sha256 lines. The plain tokens never leave helios.
set -euo pipefail
umask 077
for a in seo bsc; do
  case $a in
    seo) envf=/opt/hermes-seo/profiles/seo-main/.env ;;
    bsc) envf=/opt/hermes-bsc/profiles/bsc-main/.env ;;
  esac
  if [ -f "$envf" ]; then
    cp -a "$envf" "$envf.bak-aip00a"
  else
    install -o azlan -g azlan -m 600 /dev/null "$envf"
    : > "$envf.bak-aip00a-was-absent"
  fi
  sed -i '/^GAIADA_GATEWAY_TOKEN=/d' "$envf"
  t=$(openssl rand -hex 32)
  printf 'GAIADA_GATEWAY_TOKEN=%s\n' "$t" >> "$envf"
  chown azlan:azlan "$envf"
  chmod 600 "$envf"
  printf 'hermes-%s:%s\n' "$a" "$(printf %s "$t" | sha256sum | cut -d' ' -f1)"
  unset t
done
