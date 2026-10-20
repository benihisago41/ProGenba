# バックアップを「別の空DB」へ復元し、稼働DBと全行・スキーマ・コックピット値を照合する。
# 稼働中のprogenba-db-1 / progenba_pgdataへは読み取りのみ。作成する資産はすべて
# progenba-restore-* の名前とラベル progenba.restore-test=true を持ち、-Cleanup はそれだけを削除する。
param(
    [string]$DumpFile,
    [string]$BackupDir = $(if ($env:OneDrive) { Join-Path $env:OneDrive 'ProGenba-backups' } else { '' }),
    [int]$AppPort = 18080,
    [string]$ResultPath,
    [switch]$Cleanup,
    [switch]$CleanupOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$label = 'progenba.restore-test=true'
$net = 'progenba-restore-net'
$vol = 'progenba-restore-pgdata'
$dbName = 'progenba-restore-db'
$appName = 'progenba-restore-app'

function Remove-RestoreAssets {
    foreach ($c in @($appName, $dbName)) {
        $l = & docker inspect -f '{{index .Config.Labels "progenba.restore-test"}}' $c 2>$null
        if ($LASTEXITCODE -eq 0 -and $l -eq 'true') { & docker rm -f $c | Out-Null }
    }
    $l = & docker volume inspect -f '{{index .Labels "progenba.restore-test"}}' $vol 2>$null
    if ($LASTEXITCODE -eq 0 -and $l -eq 'true') { & docker volume rm $vol | Out-Null }
    $l = & docker network inspect -f '{{index .Labels "progenba.restore-test"}}' $net 2>$null
    if ($LASTEXITCODE -eq 0 -and $l -eq 'true') { & docker network rm $net | Out-Null }
    $global:LASTEXITCODE = 0
}
function Invoke-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) に失敗しました。" } }
function Wait-Until([scriptblock]$Probe, [int]$Seconds, [string]$Message) {
    $t = [Diagnostics.Stopwatch]::StartNew()
    while ($t.Elapsed.TotalSeconds -lt $Seconds) { if (& $Probe) { return }; Start-Sleep -Milliseconds 500 }
    throw $Message
}
function Get-LivePort {
    $port = '8080'
    if (Test-Path -LiteralPath .env) {
        foreach ($line in (Get-Content -LiteralPath .env -Encoding utf8)) { if ($line -match '^APP_PORT=(.*)$') { $port = $Matches[1].Trim() } }
    }
    if ($env:APP_PORT) { $port = $env:APP_PORT }
    $port
}

if ($CleanupOnly) { Remove-RestoreAssets; Write-Host '復元検証用の資産を削除しました。'; return }

# 1. ダンプの特定と改ざん・破損の確認
if (!$DumpFile) {
    if (!$BackupDir -or !(Test-Path -LiteralPath $BackupDir)) { throw '-DumpFile または -BackupDir を指定してください。' }
    $DumpFile = (Get-ChildItem -LiteralPath $BackupDir -File -Filter 'progenba_*.dump' | Sort-Object Name -Descending | Select-Object -First 1).FullName
    if (!$DumpFile) { throw "バックアップが見つかりません: $BackupDir" }
}
$DumpFile = (Resolve-Path -LiteralPath $DumpFile).Path
$expected = ((Get-Content -LiteralPath "$DumpFile.sha256" -Raw) -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $DumpFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw 'ダンプのSHA256が一致しません。破損または改ざんの可能性があります。' }

foreach ($c in @($appName, $dbName)) {
    & docker inspect $c *> $null
    if ($LASTEXITCODE -eq 0) { throw "$c が既に存在します。前回の検証資産を確認し、不要なら -CleanupOnly で削除してください。" }
}
& docker volume inspect $vol *> $null
if ($LASTEXITCODE -eq 0) { throw "$vol が既に存在します。不要なら -CleanupOnly で削除してください。" }
$global:LASTEXITCODE = 0

$pw = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$result = [ordered]@{ passed = $false; dump_file = (Split-Path -Leaf $DumpFile); dump_sha256 = $actual; dump_bytes = (Get-Item -LiteralPath $DumpFile).Length }
try {
    # 2. 空DBの作成と復元（復旧時間＝空DB作成開始から復元完了まで）
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Docker network create --label $label $net | Out-Null
    Invoke-Docker volume create --label $label $vol | Out-Null
    Invoke-Docker run -d --name $dbName --label $label --network $net `
        -e POSTGRES_USER=sirius -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=sirius_reborn `
        -e 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C' -e LANG=C.UTF-8 `
        -v "${vol}:/var/lib/postgresql/data" postgres:16-alpine | Out-Null
    Wait-Until { & docker exec $dbName pg_isready -h 127.0.0.1 -U sirius -d sirius_reborn *> $null; $LASTEXITCODE -eq 0 } 90 '復元先DBの起動がタイムアウトしました。'
    Invoke-Docker cp $DumpFile "${dbName}:/tmp/restore.dump"
    Invoke-Docker exec $dbName pg_restore -U sirius -d sirius_reborn --no-owner --exit-on-error /tmp/restore.dump
    $timer.Stop()
    $result.restore_seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)

    # 3. 全行・制約・トリガー・関数・インデックスの照合
    Invoke-Docker compose cp scripts/compare_restore.sql db:/tmp/compare_restore.sql
    Invoke-Docker cp scripts/compare_restore.sql "${dbName}:/tmp/compare_restore.sql"
    $live = @(& docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U sirius -d sirius_reborn -tA -f /tmp/compare_restore.sql) | Where-Object { $_ }
    if ($LASTEXITCODE -ne 0) { throw '稼働DBの照合クエリに失敗しました。' }
    & docker compose exec -T db rm -f /tmp/compare_restore.sql | Out-Null
    $restored = @(& docker exec $dbName psql -X -v ON_ERROR_STOP=1 -U sirius -d sirius_reborn -tA -f /tmp/compare_restore.sql) | Where-Object { $_ }
    if ($LASTEXITCODE -ne 0) { throw '復元DBの照合クエリに失敗しました。' }
    $diff = @(Compare-Object $live $restored)
    $tables = @($live | Where-Object { $_ -like 'table|*' } | ForEach-Object { $p = $_ -split '\|'; [ordered]@{ table = $p[1]; rows = [int]$p[2] } })
    $result.tables = $tables
    $result.table_count = $tables.Count
    $result.schema_objects = @($live | Where-Object { $_ -notlike 'table|*' }).Count
    $result.db_diff_lines = $diff.Count
    $result.db_identical = ($diff.Count -eq 0)

    # 4. 同じアプリイメージを復元DBへ向け、全会社のコックピット値を稼働系と比較
    Invoke-Docker run -d --name $appName --label $label --network $net `
        -e "DATABASE_URL=postgres://sirius:$pw@${dbName}:5432/sirius_reborn" -e STATIC_DIR=/app/static `
        -p "127.0.0.1:${AppPort}:8080" progenba-app:latest | Out-Null
    $pw = $null
    $restoreUrl = "http://127.0.0.1:$AppPort"
    $liveUrl = "http://127.0.0.1:$(Get-LivePort)"
    Wait-Until { try { $null = Invoke-RestMethod "$restoreUrl/api/v1/health" -TimeoutSec 2; $true } catch { $false } } 60 '復元側アプリの起動がタイムアウトしました。'
    $companies = @(& docker exec $dbName psql -X -U sirius -d sirius_reborn -tA -c 'SELECT DISTINCT company_code FROM project_branches ORDER BY 1') | Where-Object { $_ }
    $cockpit = foreach ($co in $companies) {
        $a = (Invoke-WebRequest "$liveUrl/api/v1/cockpit?company_code=$co" -TimeoutSec 10).Content
        $b = (Invoke-WebRequest "$restoreUrl/api/v1/cockpit?company_code=$co" -TimeoutSec 10).Content
        $branches = @($b | ConvertFrom-Json)
        [ordered]@{
            company_code = $co
            identical = ($a -ceq $b)
            branches = $branches.Count
            actual_cost_total = ($branches | Measure-Object -Property actual_occurred_cost -Sum).Sum
        }
    }
    $result.cockpit = @($cockpit)
    $result.cockpit_identical = (@($cockpit | Where-Object { -not $_.identical }).Count -eq 0) -and ($companies.Count -gt 0)
    $result.passed = $result.db_identical -and $result.cockpit_identical
}
finally {
    $pw = $null
    if ($Cleanup) { Remove-RestoreAssets; $result.cleaned_up = $true }
}
$result.checked_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$json = $result | ConvertTo-Json -Depth 5
if ($ResultPath) { $json | Set-Content -LiteralPath $ResultPath -Encoding utf8 }
$json
if (!$result.passed) { if ($diff) { $diff | Format-Table | Out-String | Write-Host }; exit 1 }
