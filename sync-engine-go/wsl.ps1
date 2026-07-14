<#
  wsl.ps1 - run this Go service inside WSL (Ubuntu + Go 1.26).

  WHY: Windows Smart App Control blocks natively-compiled Go binaries
  ("An Application Control policy has blocked this file"). Building/running
  Go inside WSL sidesteps that entirely - the binary is a Linux ELF, invisible
  to SAC. The code stays on /mnt/c (this same working tree) - no second copy.

  USAGE (from this folder):
    .\wsl.ps1                 # go build ./...        (default)
    .\wsl.ps1 run             # go run ./cmd/sync   (set DB/topology env first)
    .\wsl.ps1 test            # go test ./...       (chaos suite needs Postgres - see docker-compose.chaos.yml)
    .\wsl.ps1 vet
    .\wsl.ps1 mod tidy        # any other go subcommand passes through

  NOTE: the full test suite (property-based convergence + partition/chaos)
  needs a 2-Postgres harness - bring it up with the project's
  docker-compose.chaos.yml, then '.\wsl.ps1 test'. Plain build/vet need nothing.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'build',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'

$Distro = 'Ubuntu'
$RunPkg = './cmd/sync'
$RunEnv = ''

# This script's folder -> WSL /mnt path
$here   = $PSScriptRoot
$drive  = $here.Substring(0, 1).ToLower()
$wslDir = "/mnt/$drive" + ($here.Substring(2) -replace '\\', '/')

$rest = if ($Rest) { ' ' + ($Rest -join ' ') } else { '' }

switch ($Command) {
  'run'   { $prefix = if ($RunEnv) { "$RunEnv " } else { '' }; $go = "${prefix}go run $RunPkg$rest" }
  'build' { $go = "go build ./...$rest" }
  'test'  { $go = "go test ./...$rest" }
  'vet'   { $go = "go vet ./...$rest" }
  default { $go = "go $Command$rest" }
}

$bash = "cd '$wslDir' && $go"
Write-Host "wsl($Distro)> $bash" -ForegroundColor DarkGray
wsl -d $Distro -- bash -lc $bash
exit $LASTEXITCODE
