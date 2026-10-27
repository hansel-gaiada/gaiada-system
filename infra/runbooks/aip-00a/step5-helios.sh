#!/usr/bin/env bash
# AIP-00a step 5 (runbook infra/runbooks/aip-00a-hermes-behind-gateway.md), run as root on helios, ONE agent at a time,
# and ONLY after step 4 for that agent showed a prompt answered and the lead saw its `chat` audit row on the gateway.
# Deletes the agent's OWN model-provider credentials. Tool credentials (Semrush, Figma, Search Console) stay.
# Rollback: cp -a <file>.bak-aip00a-step5 <file>, then restart the unit.
set -euo pipefail
a="${1:?seo or bsc}"
case "$a" in
  seo) H=/opt/hermes-seo/profiles/seo-main; PY=/opt/hermes-seo/hermes-agent/venv/bin/python; U=hermes-seo-gateway ;;
  bsc) H=/opt/hermes-bsc/profiles/bsc-main; PY=/opt/hermes-bsc/venv/bin/python;            U=hermes-bsc-gateway ;;
  *) echo "seo or bsc"; exit 2 ;;
esac
UCTL="sudo -u azlan XDG_RUNTIME_DIR=/run/user/1001 systemctl --user"
if [ "$a" = seo ]; then
  for f in "$H/.env" /opt/hermes-seo/.env; do
    [ -f "$f" ] || continue
    cp -a "$f" "$f.bak-aip00a-step5"
    sed -i -E '/^(DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY)=/d' "$f"
    echo "$f now holds: $(cut -d= -f1 "$f" | grep -vE '^\s*#|^\s*$' | tr '\n' ' ')"
  done
else
  f="$H/auth.json"
  cp -a "$f" "$f.bak-aip00a-step5"
  "$PY" - "$f" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
pool = d.get("credential_pool", {})
removed = len(pool.get("openrouter", []))
pool["openrouter"] = []
json.dump(d, open(p, "w"), indent=2)
print(f"removed {removed} openrouter credential(s); pools left: {[k for k, v in pool.items() if v]}")
EOF
  chown azlan:azlan "$f"; chmod 600 "$f"
  grep -lE '^(OPENROUTER_API_KEY|OPENAI_API_KEY)=' "$H/.env" 2>/dev/null && echo "WARNING: $H/.env still names a model key" || true
fi
echo "== the same prompt again, now with no model key of its own"
timeout 240 sudo -u azlan HERMES_HOME="$H" "$PY" -m hermes_cli.main chat -q "Reply with exactly one word: pong" 2>&1 | tail -6 || echo "  (the CLI prompt failed or timed out: see above)"
$UCTL restart "$U"
sleep 10
$UCTL is-active "$U"
sudo -u azlan XDG_RUNTIME_DIR=/run/user/1001 journalctl --user -u "$U" --since "-3 min" --no-pager 2>/dev/null | grep -iE 'error|api.?key|40[13]|429|refused' | tail -6 || true
echo "== step 5 for $a finished"
