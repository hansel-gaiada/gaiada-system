#!/usr/bin/env bash
# Generate roster.generated.json — the cast list the simulation acts as.
#
# WHY GENERATED AND COMMITTED, RATHER THAN DISCOVERED AT RUNTIME
# -------------------------------------------------------------
# The harness needs four things per person that no single API returns together: display name,
# users.id, department, and the WhatsApp external_id that `link-identities.sh` assigned. The org
# structure endpoint has names + assigneeIds but no emails; `identity_links` has no API at all. So a
# runtime discovery would need admin reads across three surfaces on every start, and would silently
# produce a half-cast if any one of them was unavailable.
#
# Generating it once, checking the output in, and regenerating when the roster changes gives an
# inspectable cast list, a stable phone-to-person mapping across runs (so an old corpus can still be
# attributed), and a harness that starts with no privileged discovery at all.
#
# The org tree is the source of DEPARTMENT because that is what the office canvas renders rooms from
# (`office-data.ts` -> `listDepartmentBriefs` -> `getOrgStructure`). Taking the department from
# anywhere else would let the simulation put someone in a room the office does not draw them in.
#
# Usage:  ./build-roster.sh            # writes ../roster.generated.json
#         SSH_HOST=gda-aicenter ./build-roster.sh
set -euo pipefail

SSH_HOST="${SSH_HOST:-gda-aicenter}"
DB="${DB:-gaiada_platform}"
TENANT="${TENANT:-019fb652-c68b-728f-b779-04465fcec5ae}"
OUT="${OUT:-$(cd "$(dirname "$0")/.." && pwd)/roster.generated.json}"

echo "==> building roster from $SSH_HOST/$DB tenant=$TENANT"

# One query, one JSON document. Built server-side with jsonb_agg so the shell never parses table
# output — a name containing a space or a parenthesis ("Ayu (Owner)", "Kadek Arie") would otherwise
# need quoting rules that are easy to get subtly wrong.
#
# LEFT JOIN on identity_links, not INNER: a person with no WhatsApp link must still appear, with
# `whatsapp: null`, so the harness can report "this person cannot be driven over the OBO path"
# instead of silently omitting them from the cast and looking like they had no work to do.
#
# `simulated: true` marks the six retained placeholder personas (Ayu (Owner), Budi (PM), Citra
# (Design), Dewi (Copy), Eka (Client Lead), Gaiada Exec). They are deliberately kept as workflow
# actors by `retire-placeholder-hr.ts`, but they are not real employees, and a simulation that
# reported "26 people worked today" without distinguishing them would overstate the roster.
read -r -d '' SQL <<'SQLEOF' || true
with recursive n as (
  select c as node, c->>'name' as dept
    from company_org_structure, jsonb_array_elements(structure->'root'->'children') c
   where tenant_id = :'tenant'
  union all
  select ch, n.dept from n, jsonb_array_elements(n.node->'children') ch
),
people as (
  select distinct
    n.dept                              as department,
    n.node->>'assigneeName'             as name,
    (n.node->>'assigneeId')::uuid       as user_id
  from n
  where n.node->>'kind' = 'person'
    and n.node->>'assigneeId' is not null
)
select jsonb_pretty(jsonb_build_object(
  'generatedAt', now(),
  'tenantId',    :'tenant',
  'people', jsonb_agg(jsonb_build_object(
     'name',        p.name,
     'userId',      p.user_id,
     'email',       u.email,
     'department',  p.department,
     'whatsapp',    il.external_id,
     'placeholder', (u.email not like '%@gaiada.com'),
     'roles',       coalesce((select array_agg(distinct r2.name order by r2.name)
                                from user_roles ur2 join roles r2 on r2.id = ur2.role_id
                               where ur2.user_id = p.user_id), '{}')
  ) order by p.department, p.name)
))
from people p
join users u on u.id = p.user_id
left join identity_links il
       on il.user_id = p.user_id
      and il.provider = 'whatsapp'
      and il.external_id like '+999%'
      and il.verified_at is not null;
SQLEOF

ssh -o ConnectTimeout=45 "$SSH_HOST" "sudo -n -u postgres psql -d $DB -v tenant=\"$TENANT\" -tA" <<SQLEOF > "$OUT"
$SQL
SQLEOF

if [ ! -s "$OUT" ]; then
  echo "ERR: roster came back empty — check the tenant id and that the org structure is populated" >&2
  exit 1
fi

node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const real = r.people.filter(p => !p.placeholder);
const drivable = real.filter(p => p.whatsapp);
console.log("==> " + r.people.length + " people (" + real.length + " real, " + (r.people.length - real.length) + " retained placeholders)");
console.log("==> " + drivable.length + " of " + real.length + " real staff drivable over the OBO path");
const undrivable = real.filter(p => !p.whatsapp).map(p => p.email);
if (undrivable.length) console.log("==> NOT drivable (no verified whatsapp link): " + undrivable.join(", "));
const byDept = {};
for (const p of r.people) (byDept[p.department] ??= []).push(p.name);
for (const [d, names] of Object.entries(byDept)) console.log("    " + d + ": " + names.length + " — " + names.join(", "));
' "$OUT"

echo "==> wrote $OUT"
