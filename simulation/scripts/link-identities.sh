#!/usr/bin/env bash
# Give every seeded staff member a WhatsApp identity link, so the simulation can drive the estate
# through the OBO envelope as well as through a browser session.
#
# WHY THIS IS THE SECOND HALF OF "BOTH PATHS"
# -------------------------------------------
# `AuthGuard` resolves a service call to a real person by looking up (provider, external_id) in
# `identity_links` and requiring `verified_at`. That is the path the WhatsApp bot and the agent
# runner genuinely use. Without these rows the harness can only act as a browser user, which would
# leave the interesting half of the agentic-native bar untested: "every department capability must
# work identically under a human, under n8n, and under an agent."
#
# On the live estate before this script ran, `identity_links` held 17 n8n automation principals, one
# whatsapp link, one telegram, one platform and one hermes — and NOT ONE of the 19 real staff. So
# there was no way to act as a real employee over a bot channel at all.
#
# WHY THESE PHONE NUMBERS
# -----------------------
# E.164 country code 999 is unassigned and reserved, so +9990000xxxx cannot route to a real handset
# and cannot collide with a real contact. That matters more than usual here: this is a live estate
# with a live WAHA container, and a plausible-looking Indonesian number in this table is one
# mis-wired outbound call away from messaging a stranger.
#
# IDEMPOTENT (ON CONFLICT DO NOTHING) and reversible (--revert deletes exactly the rows it added,
# matched on the provider + the reserved prefix, so it can never touch a real link).
#
# Usage:  ./link-identities.sh            # create links
#         ./link-identities.sh --revert   # remove them
#         ./link-identities.sh --list     # show current state
set -euo pipefail

SSH_HOST="${SSH_HOST:-gda-aicenter}"
DB="${DB:-gaiada_platform}"
PROVIDER="whatsapp"
PREFIX="+9990000"
ACTION="${1:-create}"

# Ordered so each person keeps a STABLE number across runs: the index is the position in this list,
# not a sequence from the database. A number that changes between runs would break every prior
# corpus's ability to attribute a message to a person.
STAFF="andre azlan edward elmer fadhil fajri gusde ika kadek.arie maya monic radit rai reva rifat ruli sophi tini welly"

case "$ACTION" in
  --list)
    ssh -o ConnectTimeout=30 "$SSH_HOST" "sudo -n -u postgres psql -d $DB -c \"
      select il.provider, il.external_id, u.email, (il.verified_at is not null) as verified
      from identity_links il join users u on u.id = il.user_id
      where il.external_id like '${PREFIX}%' order by il.external_id\""
    exit 0
    ;;
  --revert)
    # Scoped to the reserved prefix AND the provider. Both, not either: a bare provider match would
    # delete the pre-existing real whatsapp link that this script never created.
    ssh -o ConnectTimeout=30 "$SSH_HOST" "sudo -n -u postgres psql -d $DB -c \"
      delete from identity_links where provider = '$PROVIDER' and external_id like '${PREFIX}%'\""
    echo "==> simulation identity links removed"
    exit 0
    ;;
  create) ;;
  *) echo "usage: $0 [--revert|--list]" >&2; exit 2 ;;
esac

# Build one INSERT ... SELECT per person. Resolving the user by EMAIL rather than by a hardcoded uuid
# is deliberate: the uuids differ between estates, and a wrong-but-well-formed uuid would insert a
# link pointing at nobody, which then fails later as a confusing 401 rather than as a missing row.
SQL="begin;"
i=0
for U in $STAFF; do
  i=$((i + 1))
  NUM=$(printf "%s%04d" "$PREFIX" "$i")
  SQL="$SQL
insert into identity_links (id, user_id, provider, external_id, verified_at)
select gen_random_uuid(), u.id, '$PROVIDER', '$NUM', now()
from users u where u.email = '${U}@gaiada.com'
on conflict (provider, external_id) do nothing;"
done
SQL="$SQL
commit;"

echo "==> linking ${i} staff accounts on $SSH_HOST/$DB"
ssh -o ConnectTimeout=60 "$SSH_HOST" "sudo -n -u postgres psql -d $DB -v ON_ERROR_STOP=1" <<SQLEOF
$SQL
SQLEOF

echo "==> verifying"
ssh -o ConnectTimeout=30 "$SSH_HOST" "sudo -n -u postgres psql -d $DB -tAc \"
  select count(*) || ' simulation links, ' || count(verified_at) || ' verified'
  from identity_links where provider='$PROVIDER' and external_id like '${PREFIX}%'\""

# A link whose user_id resolves to nobody is the one failure mode worth naming loudly: it produces a
# 401 at call time that reads like a bad service token.
echo "==> staff WITHOUT a link (these cannot be driven over the OBO path):"
ssh -o ConnectTimeout=30 "$SSH_HOST" "sudo -n -u postgres psql -d $DB -tAc \"
  select u.email from users u
  where u.email like '%@gaiada.com'
    and not exists (select 1 from identity_links il where il.user_id = u.id and il.provider='$PROVIDER')
  order by u.email\""
