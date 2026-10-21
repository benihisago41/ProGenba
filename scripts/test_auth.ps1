# 認証・権限・会社境界の結合試験（専用 Compose プロジェクト progenba-authtest で実行）
# - 稼働中の progenba プロジェクト（progenba-app-1 / progenba-db-1 / progenba_pgdata）には触れない。
# - リポジトリの .env は読まない（空の env ファイルを指定）。DBパスワードは実行ごとに乱数生成しプロセス環境だけに置く。
# - 試験用利用者のパスワードも実行ごとに乱数生成し、ファイル・ログ・コマンドライン引数に残さない。
# - 終了時に docker compose -p progenba-authtest down -v --rmi local で専用プロジェクトだけを削除する。
param(
    [int]$AppPort = 18081,
    [switch]$KeepEnvironment
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$project = 'progenba-authtest'
if ($project -eq 'progenba') { throw '稼働中のプロジェクト名は使用できません' }
$network = "${project}_default"
$emptyEnv = Join-Path ([IO.Path]::GetTempPath()) ("progenba-authtest-" + [guid]::NewGuid().ToString('N') + '.env')
New-Item -ItemType File -Path $emptyEnv | Out-Null
$compose = @('compose', '-p', $project, '--env-file', $emptyEnv)

function New-Secret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant() }

$savedEnv = @{}
foreach ($k in @('POSTGRES_PASSWORD', 'APP_BIND_ADDRESS', 'APP_PORT', 'SESSION_COOKIE_SECURE', 'PGPASSWORD', 'AUTHTEST_DEMOTE_OLD_COOKIE', 'AUTHTEST_DEMOTE_ROLE_BEFORE', 'SIRIUS_MIGRATION_RESULT')) { $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k) }
$secretVars = [Collections.Generic.List[string]]::new()
$exitCode = 1
try {
    $env:POSTGRES_PASSWORD = New-Secret
    $env:APP_BIND_ADDRESS = '127.0.0.1'
    $env:APP_PORT = "$AppPort"
    $env:SESSION_COOKIE_SECURE = 'false'

    & docker @compose up -d --build --wait
    if ($LASTEXITCODE -ne 0) { throw '専用環境の起動に失敗しました' }

    # 起動したコンテナが専用プロジェクトのものであることを確認
    foreach ($svc in @('db', 'app')) {
        $id = (& docker @compose ps -q $svc).Trim()
        if (!$id) { throw "$svc コンテナが見つかりません" }
        $p = & docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' $id
        if ($p -ne $project) { throw "想定外のプロジェクトのコンテナです: $p" }
    }

    $ready = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 60) {
        try { $null = Invoke-RestMethod "http://127.0.0.1:$AppPort/api/v1/health" -TimeoutSec 2; $ready = $true; break }
        catch { Start-Sleep -Seconds 2 }
    }
    if (!$ready) { & docker @compose logs --tail 20 app; throw 'アプリの起動確認に失敗しました' }

    # ---- 既存DB（002 未適用）への起動時マイグレーション経路 ----
    # initdb で作られた認証テーブルを DROP して「認証導入前のDB」を再現し、app 再起動で 002 が適用されることを確認する。
    function Invoke-DbSql([string]$Sql) {
        $out = $Sql | & docker @compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U sirius -d sirius_reborn -tA
        if ($LASTEXITCODE -ne 0) { throw 'DB問い合わせに失敗しました' }
        @($out | Where-Object { $_ })
    }
    $compareSql = Get-Content -LiteralPath (Join-Path $root 'scripts/compare_restore.sql') -Raw -Encoding utf8
    function Get-DigestSet {
        $lines = Invoke-DbSql $compareSql
        [pscustomobject]@{
            # 業務テーブルの件数・全行ダイジェスト（認証テーブルは除く）
            Business = @($lines | Where-Object { $_ -like 'table|*' -and $_ -notmatch '^table\|app_' })
            # 認証テーブルの制約・インデックス定義
            AuthSchema = @($lines | Where-Object { $_ -notlike 'table|*' -and $_ -match 'app_(users|sessions)' })
            AuthTables = [int](@(Invoke-DbSql "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('app_users','app_sessions');")[0])
        }
    }
    function Restart-App {
        $before = (& docker inspect -f '{{.State.StartedAt}}' (& docker @compose ps -q app).Trim())
        & docker @compose restart app | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'app の再起動に失敗しました' }
        $ok = $false; $t = [Diagnostics.Stopwatch]::StartNew()
        while ($t.Elapsed.TotalSeconds -lt 60) {
            try { $null = Invoke-RestMethod "http://127.0.0.1:$AppPort/api/v1/health" -TimeoutSec 2; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
        }
        $after = (& docker inspect -f '{{.State.StartedAt}}' (& docker @compose ps -q app).Trim())
        [pscustomobject]@{ Healthy = $ok; Restarted = ($before -ne $after) }
    }
    $initial = Get-DigestSet
    Invoke-DbSql 'DROP TABLE IF EXISTS app_sessions; DROP TABLE IF EXISTS app_users;' | Out-Null
    $dropped = Get-DigestSet
    $r1 = Restart-App
    $first = Get-DigestSet
    $r2 = Restart-App
    $second = Get-DigestSet
    $same = { param($a, $b) (@(Compare-Object @($a) @($b))).Count -eq 0 }
    $migration = [ordered]@{
        initdb_auth_tables = $initial.AuthTables
        auth_tables_after_drop = $dropped.AuthTables
        business_tables_compared = $initial.Business.Count
        business_unchanged_by_drop = (& $same $initial.Business $dropped.Business)
        restart1 = [ordered]@{ restarted = $r1.Restarted; healthy = $r1.Healthy; auth_tables = $first.AuthTables
            auth_schema_objects = $first.AuthSchema.Count
            auth_schema_same_as_initdb = (& $same $initial.AuthSchema $first.AuthSchema)
            business_digest_unchanged = (& $same $initial.Business $first.Business) }
        restart2_idempotent = [ordered]@{ restarted = $r2.Restarted; healthy = $r2.Healthy; auth_tables = $second.AuthTables
            auth_schema_same_as_initdb = (& $same $initial.AuthSchema $second.AuthSchema)
            business_digest_unchanged = (& $same $initial.Business $second.Business) }
    }
    $migration.passed = ($initial.AuthTables -eq 2) -and ($dropped.AuthTables -eq 0) -and ($initial.Business.Count -ge 14) -and
        $migration.business_unchanged_by_drop -and ($initial.AuthSchema.Count -gt 0) -and
        $r1.Restarted -and $r1.Healthy -and ($first.AuthTables -eq 2) -and $migration.restart1.auth_schema_same_as_initdb -and $migration.restart1.business_digest_unchanged -and
        $r2.Restarted -and $r2.Healthy -and ($second.AuthTables -eq 2) -and $migration.restart2_idempotent.auth_schema_same_as_initdb -and $migration.restart2_idempotent.business_digest_unchanged
    $env:SIRIUS_MIGRATION_RESULT = ($migration | ConvertTo-Json -Depth 5 -Compress)
    Write-Host "起動時マイグレーション経路: passed=$($migration.passed)"

    # 試験用利用者（2社×3役割＋ロック試験用）。パスワードは標準入力で渡す。
    $users = @()
    foreach ($company in @('0000', '9001')) {
        foreach ($role in @('viewer', 'registrar', 'approver')) { $users += [pscustomobject]@{ Company = $company; Id = "authtest-$role"; Role = $role; Key = $role.ToUpperInvariant() } }
    }
    $users += [pscustomobject]@{ Company = '0000'; Id = 'authtest-lockout'; Role = 'viewer'; Key = 'LOCKOUT' }
    $users += [pscustomobject]@{ Company = '0000'; Id = 'authtest-disabled'; Role = 'viewer'; Key = 'DISABLED' }
    $users += [pscustomobject]@{ Company = '0000'; Id = 'authtest-demote'; Role = 'approver'; Key = 'DEMOTE' }
    foreach ($u in $users) {
        $name = "AUTHTEST_PW_$($u.Company)_$($u.Key)"
        $secret = New-Secret
        [Environment]::SetEnvironmentVariable($name, $secret)
        $secretVars.Add($name)
        $secret | & docker @compose exec -T app /app/sirius-reborn-backend add-user --company $u.Company --user-id $u.Id --role $u.Role
        if ($LASTEXITCODE -ne 0) { throw "試験用利用者の作成に失敗しました: $($u.Company)/$($u.Id)" }
        $secret = $null
    }

    # ---- add-user --update で役割を下げると既存セッションが失効する ----
    # 旧セッションのCookieはプロセス環境変数でだけ試験コンテナへ渡す（ファイル・ログに残さない）。
    $demoteBody = @{ company_code = '0000'; user_id = 'authtest-demote'; password = $env:AUTHTEST_PW_0000_DEMOTE } | ConvertTo-Json
    $demoteLogin = Invoke-WebRequest "http://127.0.0.1:$AppPort/api/v1/auth/login" -Method Post -ContentType 'application/json' -Body $demoteBody -SkipHttpErrorCheck
    $demoteBody = $null
    if ($demoteLogin.StatusCode -ne 200) { throw '降格試験用利用者でログインできません' }
    $m = [regex]::Match((@($demoteLogin.Headers['Set-Cookie']) -join ';'), 'progenba_session=([0-9a-f]{64})')
    if (!$m.Success) { throw '降格試験用のセッションCookieがありません' }
    $env:AUTHTEST_DEMOTE_OLD_COOKIE = "progenba_session=$($m.Groups[1].Value)"
    $meBefore = Invoke-RestMethod "http://127.0.0.1:$AppPort/api/v1/auth/me" -Headers @{ Cookie = $env:AUTHTEST_DEMOTE_OLD_COOKIE }
    $env:AUTHTEST_DEMOTE_ROLE_BEFORE = $meBefore.role
    $env:AUTHTEST_PW_0000_DEMOTE | & docker @compose exec -T app /app/sirius-reborn-backend add-user --company 0000 --user-id authtest-demote --role viewer --update
    if ($LASTEXITCODE -ne 0) { throw 'add-user --update に失敗しました' }

    # 専用ネットワーク内の Node コンテナから API（app:8080）と DB（db:5432, psql）へ接続して試験する
    $env:PGPASSWORD = $env:POSTGRES_PASSWORD
    $commit = (& git rev-parse HEAD).Trim()
    $dirty = if (& git status --porcelain) { '+uncommitted' } else { '' }
    $runArgs = @('run', '--rm', '--label', 'ai.agent=codex', '--network', $network,
        '-e', 'PGHOST=db', '-e', 'PGUSER=sirius', '-e', 'PGDATABASE=sirius_reborn', '-e', 'PGPASSWORD',
        '-e', 'SIRIUS_TEST_PSQL=1', '-e', 'SIRIUS_TEST_URL=http://app:8080',
        '-e', 'SIRIUS_TEST_OUTPUT=artifacts/acceptance-api-auth.json', '-e', 'SIRIUS_AUTH_OUTPUT=artifacts/auth-acceptance.json',
        '-e', "SIRIUS_TEST_PROJECT=$project", '-e', "SIRIUS_TEST_COMMIT=$commit$dirty")
    foreach ($name in $secretVars) { $runArgs += @('-e', $name) }
    $runArgs += @('-e', 'AUTHTEST_DEMOTE_OLD_COOKIE', '-e', 'AUTHTEST_DEMOTE_ROLE_BEFORE', '-e', 'SIRIUS_MIGRATION_RESULT')
    $runArgs += @('--mount', "type=bind,source=$root,target=/repo", '-w', '/repo', 'node:22-alpine', 'sh', '-c',
        '(apk add --no-cache postgresql16-client || apk add --no-cache postgresql-client) >/dev/null && node scripts/test_api.mjs; api=$?; node scripts/test_auth.mjs; auth=$?; echo "test_api=$api test_auth=$auth"; [ $api -eq 0 ] && [ $auth -eq 0 ]')
    & docker @runArgs
    $exitCode = $LASTEXITCODE
}
finally {
    foreach ($name in $secretVars) { [Environment]::SetEnvironmentVariable($name, $null) }
    if (!$KeepEnvironment) {
        & docker @compose down -v --rmi local --remove-orphans
    } else {
        Write-Host "専用環境を残しました。削除: docker compose -p $project --env-file <空ファイル> down -v --rmi local"
    }
    foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k]) }
    Remove-Item -LiteralPath $emptyEnv -ErrorAction SilentlyContinue
}
exit $exitCode
