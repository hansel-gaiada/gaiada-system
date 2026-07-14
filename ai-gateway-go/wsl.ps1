<#
  wsl.ps1 - run this Go service inside WSL (Ubuntu + Go 1.26).

  WHY: Windows Smart App Control blocks natively-compiled Go binaries
  ("An Application Control policy has blocked this file"). Building/running
  Go inside WSL sidesteps that entirely - the binary is a Linux ELF, invisible
  to SAC. The code stays on /mnt/c (this same working tree) - no second copy.

  USAGE (from this folder):
    .\wsl.ps1                 # go build ./...        (default)
    .\wsl.ps1 run             # HOST=127.0.0.1 GATEWAY_TLS_MODE=off go run ./cmd/gateway
    .\wsl.ps1 test            # go test ./...
    .\wsl.ps1 test -run Foo   # extra args pass through
    .\wsl.ps1 vet
    .\wsl.ps1 mod tidy        # any other go subcommand passes through

  When run via 'run', the gateway listens on 127.0.0.1:3002; WSL2 forwards that
  to Windows localhost, so http://localhost:3002/health works from Windows with
  no firewall prompt.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'build',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'

$Distro = 'Ubuntu'
$RunPkg = './cmd/gateway'
$RunEnv = 'HOST=127.0.0.1 GATEWAY_TLS_MODE=off'

# This script's folder -> WSL /mnt path
$here   = $PSScriptRoot
$drive  = $here.Substring(0, 1).ToLower()
$wslDir = "/mnt/$drive" + ($here.Substring(2) -replace '\\', '/')

$rest = if ($Rest) { ' ' + ($Rest -join ' ') } else { '' }

switch ($Command) {
  'run'   { $go = "$RunEnv go run $RunPkg$rest" }
  'build' { $go = "go build ./...$rest" }
  'test'  { $go = "go test ./...$rest" }
  'vet'   { $go = "go vet ./...$rest" }
  default { $go = "go $Command$rest" }
}

$bash = "cd '$wslDir' && $go"
Write-Host "wsl($Distro)> $bash" -ForegroundColor DarkGray
wsl -d $Distro -- bash -lc $bash
exit $LASTEXITCODE
