#!/bin/sh
# WS9 config-lint: structurally validate the observability stack's config. Runs the real linters
# when available (promtool / amtool / otelcol validate), else falls back to a YAML/JSON parse check.
# Kept dependency-light so it works in CI and on a dev box. Exit non-zero on any failure.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OBS="$ROOT/infra/observability"
fail=0

have() { command -v "$1" >/dev/null 2>&1; }

echo "=== observability config-lint ==="

# 1) Prometheus rules + scrape config (promtool if present).
if have promtool; then
  promtool check rules "$OBS"/prometheus/rules/*.yml || fail=1
  promtool check config "$OBS/prometheus/prometheus.yml" || fail=1
else
  echo "promtool not found — skipping deep Prometheus check (YAML parse still runs below)"
fi

# 2) OTel Collector config (otelcol / otelcol-contrib if present).
if have otelcol-contrib; then
  otelcol-contrib validate --config="$OBS/otel-collector/config.yaml" || fail=1
elif have otelcol; then
  otelcol validate --config="$OBS/otel-collector/config.yaml" || fail=1
else
  echo "otelcol not found — skipping collector validate (YAML parse still runs below)"
fi

# 3) Alertmanager (amtool) — render the env template first (envsubst), then check.
if have amtool && have envsubst; then
  tmp="$(mktemp -d)"
  cp -r "$OBS/alertmanager/templates" "$tmp/templates"
  # Provide harmless defaults so type-checked fields (chat_id int, URLs) validate.
  ALERT_CHAT_ID=0 SMTP_SMARTHOST=mail.example.com:587 SMTP_FROM=a@example.com \
  SMTP_USERNAME=u SMTP_PASSWORD=p ALERT_EMAIL_TO=a@example.com \
  TELEGRAM_BOT_TOKEN=x ALERT_WEBHOOK_URL=http://example.com/h DEADMANSSWITCH_URL=http://example.com/p \
    envsubst < "$OBS/alertmanager/alertmanager.yml" \
    | sed "s#/etc/alertmanager/templates#$tmp/templates#" > "$tmp/am.yml"
  amtool check-config "$tmp/am.yml" || fail=1
  rm -rf "$tmp"
else
  echo "amtool/envsubst not found — skipping Alertmanager check (YAML parse still runs below)"
fi

# 4) Always-on fallback: every YAML/JSON file must parse (python3 for YAML, node for JSON).
if have python3; then
  python3 - "$OBS" <<'PY' || fail=1
import glob, os, sys
try:
    import yaml
except Exception:
    print("pyyaml missing — skipping YAML parse"); sys.exit(0)
obs = sys.argv[1]
bad = 0
for f in glob.glob(os.path.join(obs, "**", "*.y*ml"), recursive=True):
    try:
        list(yaml.safe_load_all(open(f, encoding="utf-8")))
    except Exception as e:
        bad += 1; print("YAML FAIL", f, "->", e)
sys.exit(1 if bad else 0)
PY
fi
if have node; then
  for j in "$OBS"/grafana/dashboards/*.json; do
    node -e "JSON.parse(require('fs').readFileSync('$j','utf8'))" || { echo "JSON FAIL $j"; fail=1; }
  done
fi

# 5) Shell scripts parse.
for s in "$ROOT"/infra/scripts/*.sh; do sh -n "$s" || { echo "SH FAIL $s"; fail=1; }; done

[ "$fail" -eq 0 ] && echo "=== observability config-lint OK ===" || echo "=== observability config-lint FAILED ==="
exit "$fail"
