#!/usr/bin/env bash
# AIP-00a step 4 (runbook infra/runbooks/aip-00a-hermes-behind-gateway.md), run as root on helios, ONE agent at a time:
#   bash step4-helios.sh seo     then, after the lead has seen the gateway's audit row,     ... bsc
# Points the agent's model AND every auxiliary task at the gateway (named provider `gaiada-gateway`, its token from its
# own .env via key_env), removes the direct-provider fallback, proves one prompt through the same config, restarts the
# agent. It does NOT delete any key (that is step 5, only after the audit row is seen).
# Rollback: cp -a <file>.bak-aip00a <file> for config.yaml (and auth.json), then restart the unit.
set -euo pipefail
a="${1:?seo or bsc}"
case "$a" in
  seo) H=/opt/hermes-seo/profiles/seo-main; PY=/opt/hermes-seo/hermes-agent/venv/bin/python; U=hermes-seo-gateway ;;
  bsc) H=/opt/hermes-bsc/profiles/bsc-main; PY=/opt/hermes-bsc/venv/bin/python;            U=hermes-bsc-gateway ;;
  *) echo "seo or bsc"; exit 2 ;;
esac
GW=http://10.88.0.2:3012/v1
UCTL="sudo -u azlan XDG_RUNTIME_DIR=/run/user/1001 systemctl --user"
cd "$H"   # run from the agent's home, as its unit does: azlan cannot use /root as a working directory
cp -a "$H/config.yaml" "$H/config.yaml.bak-aip00a"
[ -f "$H/auth.json" ] && cp -a "$H/auth.json" "$H/auth.json.bak-aip00a"

echo "== reach the gateway through the relay"
curl -s -o /dev/null -w "  /v1/models without a token: %{http_code} (want 401)\n" "$GW/models"
tok=$(grep '^GAIADA_GATEWAY_TOKEN=' "$H/.env" | cut -d= -f2-)
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" "$GW/models")
unset tok
echo "  /v1/models with the $a token: $code (want 200)"
[ "$code" = 200 ] || { echo "STOP: the gateway does not accept this agent's token; nothing was changed"; exit 3; }

hc() { sudo -u azlan HERMES_HOME="$H" "$PY" -m hermes_cli.main config set "$@"; }
echo "== repoint the model"
hc --force providers.gaiada-gateway.base_url "$GW"
hc --force providers.gaiada-gateway.api_mode chat_completions
hc --force providers.gaiada-gateway.key_env GAIADA_GATEWAY_TOKEN
hc model.provider gaiada-gateway
hc model.base_url "$GW"
hc model.default z-ai/glm-5.3-flash
hc model.context_length 131072
sudo -u azlan HERMES_HOME="$H" "$PY" -m hermes_cli.main config unset fallback_providers || true
echo "== every auxiliary task uses the main (gateway) provider; vision will be refused by the gateway (no images)"
for t in approval compression curator kanban_decomposer mcp profile_describer skills_hub title_generation triage_specifier vision web_extract session_search; do
  hc --force "auxiliary.$t.provider" main >/dev/null
done
echo "== the resulting model section:"
awk '/^model:/{p=1;print;next} /^[^ #]/{p=0} p' "$H/config.yaml" | grep -viE 'key|token|secret' || true
awk '/^providers:/{p=1;print;next} /^[^ #]/{p=0} p' "$H/config.yaml" | grep -viE 'secret' || true

echo "== one prompt through the same config (CLI, not the messaging service)"
timeout 240 sudo -u azlan HERMES_HOME="$H" "$PY" -m hermes_cli.main chat -q "Reply with exactly one word: pong" 2>&1 | tail -6 || echo "  (the CLI prompt failed or timed out: see above)"

echo "== restart $U"
$UCTL restart "$U"
sleep 10
$UCTL is-active "$U"
sudo -u azlan XDG_RUNTIME_DIR=/run/user/1001 journalctl --user -u "$U" --since "-3 min" --no-pager 2>/dev/null | grep -iE 'error|api.?key|40[13]|429|refused' | tail -6 || true
echo "== step 4 for $a finished: tell the lead, who checks the gateway's audit row before step 5"
