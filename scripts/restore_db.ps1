# バックアップを「別の空DB」へ復元し、稼働DBと全行・スキーマを照合したうえで、
# 復元DBに向けたアプリで全会社のコックピットが取得できることを確認する。
# 稼働中のprogenba-db-1 / progenba_pgdataへは読み取りのみ（稼働系APIも呼ばない）。作成する資産はすべて
# progenba-restore-* の名前とラベル progenba.restore-test=true を持ち、-Cleanup はそれだけを削除する。
param(
    [string]$DumpFile,
    [string]$BackupDir = $(if ($env:OneDrive) { Join-Path $env:OneDrive 'ProGenba-backups' } else { '' }),
    [int]$AppPort = 18080,
    # 復元側で起動するアプリのイメージ（既定は稼働系と同じ progenba-app:latest）
    [string]$AppImage = 'progenba-app:latest',
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
$savedEnv = @{}
foreach ($name in @('POSTGRES_PASSWORD', 'DATABASE_URL')) {
    $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name)
}
$result = [ordered]@{ passed = $false; dump_file = (Split-Path -Leaf $DumpFile); dump_sha256 = $actual; dump_bytes = (Get-Item -LiteralPath $DumpFile).Length }
try {
    # Docker には環境変数名だけを渡し、秘密をプロセスの引数に残さない。
    $env:POSTGRES_PASSWORD = $pw
    $env:DATABASE_URL = "postgres://sirius:$pw@${dbName}:5432/sirius_reborn"
    # 2. 空DBの作成と復元（復旧時間＝空DB作成開始から復元完了まで）
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Invoke-Docker network create --label $label $net | Out-Null
    Invoke-Docker volume create --label $label $vol | Out-Null
    Invoke-Docker run -d --name $dbName --label $label --network $net `
        -e POSTGRES_USER=sirius -e POSTGRES_PASSWORD -e POSTGRES_DB=sirius_reborn `
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

    # 照合はアプリ起動より前に行う（アプリは起動時に 002_auth.sql を適用し、復元DBの構成を変えうるため）。
    # 照合時点の認証テーブル数を記録し、この順序を結果に残す。
    $authTablesSql = "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('app_users','app_sessions')"
    $result.compared_before_app_start = $true
    $result.restored_auth_tables_at_compare = [int](& docker exec $dbName psql -X -U sirius -d sirius_reborn -tA -c $authTablesSql)

    # 4. 復元DB（使い捨て）に向けたアプリで、全会社のコックピットが取得できることを確認する。
    #    稼働系APIとは比較しない（認証導入後は稼働系に検証用ログインが必要になり、稼働DBへ書き込むことになるため）。
    #    根拠: 上の照合で業務テーブルの全行ダイジェストが一致していれば、同じイメージのアプリは
    #    同じ入力から同じ集計を返す（コックピットはDBの業務テーブルだけから決定的に計算され、乱数・時刻に依存しない）。
    #    ここでは復元側アプリが実際に起動し、認証を通して全会社の集計を返せることと、その値を記録する。
    Invoke-Docker run -d --name $appName --label $label --network $net `
        -e DATABASE_URL -e STATIC_DIR=/app/static `
        -p "127.0.0.1:${AppPort}:8080" $AppImage | Out-Null
    $pw = $null
    $result.app_image = $AppImage
    $restoreUrl = "http://127.0.0.1:$AppPort"
    Wait-Until { try { $null = Invoke-RestMethod "$restoreUrl/api/v1/health" -TimeoutSec 2; $true } catch { $false } } 60 '復元側アプリの起動がタイムアウトしました。'
    $result.restored_auth_tables_after_app_start = [int](& docker exec $dbName psql -X -U sirius -d sirius_reborn -tA -c $authTablesSql)
    $companies = @(& docker exec $dbName psql -X -U sirius -d sirius_reborn -tA -c 'SELECT DISTINCT company_code FROM project_branches ORDER BY 1') | Where-Object { $_ }
    $cockpit = foreach ($co in $companies) {
        # 復元DBにだけ、一時的な承認権限の利用者とセッションを直接作る。
        # パスワードはログイン不能な値（PHC形式でない）とし、トークンは乱数でDBにはSHA-256だけを保存する。
        $token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::ASCII.GetBytes($token))).ToLowerInvariant()
        $sql = "INSERT INTO app_users (company_code, user_id, display_name, password_hash, role) VALUES ('$co', 'restore-verify', 'restore-verify', 'login-disabled', 'approver') ON CONFLICT (company_code, user_id) DO NOTHING; " +
               "INSERT INTO app_sessions (company_code, token_hash, user_id, expires_at) VALUES ('$co', '$hash', 'restore-verify', now() + interval '10 minutes');"
        $sql | & docker exec -i $dbName psql -X -q -v ON_ERROR_STOP=1 -U sirius -d sirius_reborn | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '復元DBへの検証用セッション作成に失敗しました。' }
        $res = Invoke-WebRequest "$restoreUrl/api/v1/cockpit?company_code=$co" -Headers @{ Cookie = "progenba_session=$token" } -TimeoutSec 10 -SkipHttpErrorCheck
        $token = $null
        $branches = if ($res.StatusCode -eq 200) { @($res.Content | ConvertFrom-Json) } else { @() }
        [ordered]@{
            company_code = $co
            http_status = [int]$res.StatusCode
            branches = $branches.Count
            execution_budget_total = [long]($branches | Measure-Object -Property execution_budget_amount -Sum).Sum
            actual_cost_total = [long]($branches | Measure-Object -Property actual_occurred_cost -Sum).Sum
            forecast_gross_profit_total = [long]($branches | Measure-Object -Property forecast_gross_profit -Sum).Sum
        }
    }
    $result.restored_cockpit = @($cockpit)
    $result.restored_cockpit_all_ok = ($companies.Count -gt 0) -and (@($cockpit | Where-Object { $_.http_status -ne 200 -or $_.branches -lt 1 }).Count -eq 0)
    $result.cockpit_equivalence_basis = 'business tables identical by full-row digest (db_identical) + same app image => same cockpit; live API not called'
    $result.passed = $result.db_identical -and $result.restored_cockpit_all_ok
}
finally {
    $pw = $null
    foreach ($name in $savedEnv.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnv[$name])
    }
    $savedEnv.Clear()
    if ($Cleanup) { Remove-RestoreAssets; $result.cleaned_up = $true }
}
$result.checked_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$json = $result | ConvertTo-Json -Depth 5
if ($ResultPath) { $json | Set-Content -LiteralPath $ResultPath -Encoding utf8 }
$json
if (!$result.passed) { if ($diff) { $diff | Format-Table | Out-String | Write-Host }; exit 1 }
