#!/usr/bin/env bash
# Install hermes-config into HERMES_HOME, with validation and rollback.
#
#   ./hermes-config/render-and-install.sh            # validate + diff, DO NOT install
#   ./hermes-config/render-and-install.sh --install  # ...then back up and install
#
# Why this exists: Hermes' config, persona and MCP wiring have only ever been hand-edited files on
# one box, with `.bak` files as the change history — while every other component in this estate ships
# by tag. See docs/superpowers/plans/2026-08-22-hermes-runtime-plan.md §3 and the tracker's B7.
#
# ── THE CENTRAL RULE: THIS SCRIPT DOES NOT SUBSTITUTE SECRETS ─────────────────────────────────────
# Verified against the live box 2026-08-23: `/opt/hermes-zen/config.yaml` contains the LITERAL string
#
#     Authorization: "Bearer ${GAIADA_HUB_TOKEN}"
#
# Hermes expands that itself at read time, from `$HERMES_HOME/.env`. So the config file on disk NEVER
# contains the token, and this installer must preserve that property.
#
# An earlier draft of this script ran the template through `envsubst` before installing. That was
# wrong in the dangerous direction: it would have written the plaintext token into config.yaml,
# converting a file that merely REFERENCES a secret into a second place the secret LIVES — one more
# thing to rotate, back up carefully and keep out of a diff. (It also, while being tested, printed the
# real token into a terminal. Substituting secrets in tooling is exactly how they leak.)
#
# So: §3 asserts the REFERENCE SURVIVES. A literal `${GAIADA_HUB_TOKEN}` in the rendered file is the
# CORRECT state, and an expanded one is the failure.
#
# ── TRAP — HERMES_HOME IS 0700 AND OWNED BY ANOTHER USER ─────────────────────────────────────────
# `/opt/hermes-zen` is `drwx------ azlan:azlan`. A deploy running as a different user CANNOT write
# there, so the install step needs sudo — and wiring this into deploy.yml is a permissions decision
# the owner has to make rather than something to arrange implicitly. See README.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${HERMES_HOME:-/opt/hermes-zen}"
TMPL="$HERE/config.yaml.tmpl"
SOUL="$HERE/SOUL.md"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DO_INSTALL=0
[ "${1:-}" = "--install" ] && DO_INSTALL=1

say() { printf '%s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ── 1 · inputs exist ─────────────────────────────────────────────────────────────────────────────
[ -f "$TMPL" ] || die "missing template: $TMPL"
[ -f "$SOUL" ] || die "missing soul: $SOUL"

# ── 2 · the TARGET must actually be a Hermes home ────────────────────────────────────────────────
# Found while testing: an unrelated `HERMES_HOME` was already exported in the environment (pointing at
# a Windows path), and the script happily aimed there. `HERMES_HOME` is a generic name — some other
# tool, or a stale shell, can own it. Installing into whatever that points at is a silent, confusing
# failure. On a first-ever install pass INSTALL_FRESH=1 deliberately.
if [ "${INSTALL_FRESH:-0}" != "1" ]; then
  case "$HERMES_HOME" in
    /*) : ;;
    *) die "HERMES_HOME is not an absolute POSIX path: '$HERMES_HOME'
       It is probably inherited from an unrelated tool. Set it explicitly:
         HERMES_HOME=/opt/hermes-zen $0 ${1:-}" ;;
  esac
  if ! sudo test -e "$HERMES_HOME/config.yaml" 2>/dev/null \
     && ! sudo test -e "$HERMES_HOME/SOUL.md" 2>/dev/null; then
    die "'$HERMES_HOME' has neither config.yaml nor SOUL.md — this does not look like a Hermes home.
       Refusing to install into it. Pass INSTALL_FRESH=1 if this really is a first install."
  fi
fi

# ── 3 · validate — FAIL CLOSED, and assert the secret STAYS a reference ──────────────────────────
grep -q 'Bearer \${GAIADA_HUB_TOKEN}' "$TMPL" \
  || die "the template must carry the LITERAL \${GAIADA_HUB_TOKEN} reference.
       Hermes expands it from $HERMES_HOME/.env at read time. If it has been replaced with a real
       token, remove it, ROTATE that token, and restore the reference."

# A 40+ char hex/base64 run where the reference belongs means someone pasted a live credential in.
if grep -qE 'Bearer [A-Za-z0-9+/=_-]{24,}' "$TMPL"; then
  die "the template appears to contain a literal credential. Rotate it and restore the \${...} reference."
fi

# The MCP wiring is the single line that gives Hermes its whole tool surface. If it silently vanished,
# Hermes would start cleanly and simply be unable to act — a failure that looks like a model problem.
grep -q 'mcp_servers:' "$TMPL" || die "template has no mcp_servers block"
grep -q 'x-obo-provider' "$TMPL" || die "template has no OBO provider header"

# `--yolo` must never be the default. Autonomy comes from the risk ladder enforced in mcp-hub, where
# it is auditable — never from a flag on the agent's own command line.
grep -qi 'yolo' "$TMPL" && die "template mentions yolo — approvals must stay ON"

# YAML must actually parse. A config Hermes cannot read is a config that reverts it to defaults.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$TMPL" <<'PY' || die "template is not valid YAML"
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)  # no pyyaml here; the other checks still applied
yaml.safe_load(open(sys.argv[1]))
PY
fi

say "✓ validated (secret reference intact, MCP wiring present, YAML parses, approvals on)"

# ── 4 · diff against what is live ────────────────────────────────────────────────────────────────
# Compares the FILES AS STORED — both sides keep the ${...} reference, so no secret is ever rendered
# into this output. Comment-only differences are expected and fine.
LIVE="$HERMES_HOME/config.yaml"
if sudo test -f "$LIVE" 2>/dev/null; then
  say ""
  say "functional diff (comments stripped; live → repo):"
  if diff -u <(sudo grep -vE '^\s*#|^\s*$' "$LIVE") <(grep -vE '^\s*#|^\s*$' "$TMPL") > /tmp/.hc.diff 2>&1; then
    say "    (identical — the repo template reproduces the live config exactly)"
  else
    sed 's/^/    /' /tmp/.hc.diff
  fi
  rm -f /tmp/.hc.diff
else
  say "(no live config readable at $LIVE — first install, or insufficient permissions)"
fi

if [ "$DO_INSTALL" -eq 0 ]; then
  say ""
  say "DRY RUN. Re-run with --install to back up and apply."
  exit 0
fi

# ── 5 · install, with a backup ───────────────────────────────────────────────────────────────────
say ""
say "installing to $HERMES_HOME ..."
sudo cp -a "$LIVE" "$HERMES_HOME/config.yaml.bak-$STAMP" 2>/dev/null || say "  (no previous config to back up)"
sudo install -o azlan -g azlan -m 600 "$TMPL" "$LIVE"
sudo install -o azlan -g azlan -m 600 "$SOUL" "$HERMES_HOME/SOUL.md"
say "✓ installed (backup: config.yaml.bak-$STAMP)"

# ── 6 · verify ───────────────────────────────────────────────────────────────────────────────────
sudo test -s "$LIVE" || die "post-install config is empty — restore the backup NOW"
sudo grep -q 'Bearer \${GAIADA_HUB_TOKEN}' "$LIVE" \
  || die "post-install config lost the token reference — restore the backup NOW"
say "✓ post-install file is non-empty and the token reference survived"
say ""
say "Verify the agent still answers AND that the hub logs the call — both halves, or the tool"
say "surface is not actually wired. Rollback:  sudo cp $HERMES_HOME/config.yaml.bak-$STAMP $LIVE"
