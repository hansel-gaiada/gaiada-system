<#
  wsl.ps1 - run this Go service's tooling inside WSL (Ubuntu + Go 1.26).

  WHY: Windows Smart App Control can block natively-compiled Go binaries on some laptops
  ("An Application Control policy has blocked this file"). Building/testing inside WSL sidesteps
  that: the binary is a Linux ELF, invisible to SAC. The code stays on /mnt/c (this same working tree).
  (On the laptop this was written on, plain `go test ./...` worked natively; use this script when it does not.)

  USAGE (from this folder):
    .\wsl.ps1                 # go build ./...        (default)
    .\wsl.ps1 test             # go test ./...        (the vdb test needs TEST_DATABASE_URL, else it self-skips;
                                                      there is NO local Postgres: run it on the Linux gate)
    .\wsl.ps1 vet
    .\wsl.ps1 mod tidy         # any other go subcommand passes through

  NO DOCKER on this laptop (owner order 2026-10-12): the image is built by CI (M5-V2-b), never here.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'build',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'

$Distro = 'Ubuntu'

# This script's folder -> WSL /mnt path
$here   = $PSScriptRoot
$drive  = $here.Substring(0, 1).ToLower()
$wslDir = "/mnt/$drive" + ($here.Substring(2) -replace '\\', '/')

$rest = if ($Rest) { ' ' + ($Rest -join ' ') } else { '' }

switch ($Command) {
  'build' { $go = "go build ./...$rest" }
  'test'  { $go = "go test ./...$rest" }
  'vet'   { $go = "go vet ./...$rest" }
  default { $go = "go $Command$rest" }
}

$bash = "cd '$wslDir' && $go"
Write-Host "wsl($Distro)> $bash" -ForegroundColor DarkGray
wsl -d $Distro -- bash -lc $bash
exit $LASTEXITCODE
