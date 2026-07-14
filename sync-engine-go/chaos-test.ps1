<#
  chaos-test.ps1 - run sync-engine-go's FULL suite (incl. DB-backed convergence/chaos)
  on Windows, end to end:

    1. brings up the two chaos Postgres containers (docker-compose.chaos.yml)
    2. applies platform-nest migrations + a NOSUPERUSER NOBYPASSRLS role to both
    3. runs `go test ./...` inside WSL (Ubuntu) - Smart App Control blocks native
       Go .exe, so tests must run in WSL; see WSL-DEV.md

  The Go tests connect to the DBs over Windows localhost (Docker publishes the
  ports; WSL2 forwards localhost). Site-a defaults to 55434 because 55432 is held
  by the unrelated `aire-postgres` container on this machine.

  USAGE (from this folder):
    .\chaos-test.ps1                 # up + provision + test (leaves DBs running)
    .\chaos-test.ps1 -SkipProvision  # DBs already migrated -> just re-run tests
    .\chaos-test.ps1 -Down           # tear the DBs down and exit
#>
[CmdletBinding()]
param(
  [int]$SitePort    = 55434,
  [int]$CentralPort = 55433,
  [switch]$SkipProvision,
  [switch]$Down
)
$ErrorActionPreference = 'Stop'

$here    = $PSScriptRoot
$compose = Join-Path $here 'docker-compose.chaos.yml'
$migDir  = Join-Path $here '..\platform-nest\migrations'
$project = 'sync-engine-chaos'
$siteC   = "$project-site-a-db-1"
$centralC= "$project-central-db-1"
$distro  = 'Ubuntu'

# port override (dodges the aire 55432 clash; also lets central move if needed)
$ovr = Join-Path $env:TEMP 'sync-chaos-override.yml'
@"
services:
  site-a-db:
    ports: !override ["${SitePort}:5432"]
  central-db:
    ports: !override ["${CentralPort}:5432"]
"@ | Set-Content -Encoding ascii $ovr

if ($Down) {
  docker compose -f $compose -f $ovr -p $project down
  exit $LASTEXITCODE
}

# A full (provisioning) run needs FRESH DBs - 0001_core.sql uses bare CREATE TABLE
# and errors against an already-migrated database. The containers are volume-less,
# so down+up gives a clean slate. -SkipProvision reuses whatever is already running.
if (-not $SkipProvision) {
  Write-Host "== resetting chaos DBs for a clean provision ==" -ForegroundColor Cyan
  docker compose -f $compose -f $ovr -p $project down *> $null
}
Write-Host "== bringing up chaos DBs (site-a:$SitePort, central:$CentralPort) ==" -ForegroundColor Cyan
docker compose -f $compose -f $ovr -p $project up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed" }

# wait for readiness
foreach ($c in @($siteC, $centralC)) {
  for ($i = 0; $i -lt 30; $i++) {
    docker exec $c pg_isready -U postgres *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
  }
}

if (-not $SkipProvision) {
  $roleSql = @'
DO $$ BEGIN CREATE ROLE sync_app LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO sync_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO sync_app;
'@
  $migrations = Get-ChildItem (Join-Path $migDir '*.sql') | Sort-Object Name
  foreach ($pair in @(@($siteC, 'site_a'), @($centralC, 'central'))) {
    $c, $db = $pair
    Write-Host "== provisioning $c/$db ($($migrations.Count) migrations) ==" -ForegroundColor Cyan
    foreach ($m in $migrations) {
      Get-Content -Raw $m.FullName | docker exec -i $c psql -U postgres -d $db -q -v ON_ERROR_STOP=1 2>&1 |
        Where-Object { $_ -notmatch 'NOTICE|already exists, skipping|does not exist, skipping' }
      if ($LASTEXITCODE -ne 0) { throw "migration $($m.Name) failed on $c/$db" }
    }
    $roleSql | docker exec -i $c psql -U postgres -d $db -q -v ON_ERROR_STOP=1
  }
}

# run the full suite in WSL against both DBs (localhost is forwarded from WSL2)
$wslDir = '/mnt/' + $here.Substring(0,1).ToLower() + ($here.Substring(2) -replace '\\','/')
$bash = @"
cd '$wslDir' && \
DATABASE_URL_TEST='postgres://sync_app:test@localhost:$SitePort/site_a' \
DATABASE_URL_SITE_A='postgres://sync_app:test@localhost:$SitePort/site_a' \
DATABASE_URL_CENTRAL='postgres://sync_app:test@localhost:$CentralPort/central' \
go test ./...
"@
Write-Host "== go test ./... (in WSL) ==" -ForegroundColor Cyan
wsl -d $distro -- bash -lc $bash
$code = $LASTEXITCODE
Write-Host "`n== done (exit $code). DBs left running; '.\chaos-test.ps1 -Down' to stop. ==" -ForegroundColor Cyan
exit $code
