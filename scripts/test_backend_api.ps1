$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$network='progenba-codex-dev'
$db='progenba-codex-phase0-db'
$api='progenba-codex-api'
$existing = & docker network ls --filter "name=^${network}$" --format '{{.Name}}'
if (!$existing) { & docker network create --label ai.agent=codex $network | Out-Null }
$networks = & docker inspect $db --format '{{json .NetworkSettings.Networks}}' | ConvertFrom-Json
if (!$networks.PSObject.Properties[$network]) { & docker network connect $network $db }
if ((& docker inspect $db --format '{{index .Config.Labels "ai.agent"}}') -ne 'codex') { throw '検証DBの所有ラベル不一致' }
$backend = Join-Path $root 'backend'
& docker run -d --name $api --label ai.agent=codex --network $network -p 127.0.0.1:8080:8080 -e "DATABASE_URL=postgres://postgres@${db}:5432/sirius_reborn" --mount "type=bind,source=$backend,target=/app" -w /app rust:1.80-bookworm /app/target/debug/sirius-reborn-backend | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
try {
    $ready = $false
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 40) {
        try { $null=Invoke-RestMethod 'http://127.0.0.1:8080/api/v1/health' -TimeoutSec 2; $ready=$true; break }
        catch { Start-Sleep -Seconds 2 }
    }
    if (!$ready) { & docker logs --tail 12 $api; throw 'APIの起動確認に失敗' }
    $env:SIRIUS_TEST_DB_CONTAINER=$db
    $env:SIRIUS_TEST_DB_USER='postgres'
    & node scripts/test_api.mjs
    $result=$LASTEXITCODE
} finally {
    & docker stop $api | Out-Null
    & docker rm $api | Out-Null
    Remove-Item Env:SIRIUS_TEST_DB_CONTAINER -ErrorAction SilentlyContinue
    Remove-Item Env:SIRIUS_TEST_DB_USER -ErrorAction SilentlyContinue
}
exit $result
