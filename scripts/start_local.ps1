param([switch]$NoBuild)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktopを起動してください。' }
if (!(Test-Path -LiteralPath .env)) {
    $secret=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    "POSTGRES_PASSWORD=$secret`nAPP_BIND_ADDRESS=127.0.0.1`nAPP_PORT=8080" | Set-Content -LiteralPath .env -Encoding utf8
    $secret=$null
    Write-Host 'ローカル検証用の.envを作成しました（Git管理対象外）。'
}
$composeArgs=@('compose','up','-d','--wait')
if (!$NoBuild) { $composeArgs+='--build' }
& docker @composeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '起動しました。.envが既定設定の場合: http://127.0.0.1:8080'
