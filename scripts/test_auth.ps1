# 認証・権限・会社境界の結合試験（専用 Compose プロジェクト progenba-authtest で実行）
# 続けて予算・発注の登録と承認（Phase 4）の結合試験 scripts/test_revisions.mjs も同じ専用環境で実行する。
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
foreach ($k in @('POSTGRES_PASSWORD', 'APP_BIND_ADDRESS', 'APP_PORT', 'SESSION_COOKIE_SECURE', 'PGPASSWORD', 'AUTHTEST_DEMOTE_OLD_COOKIE', 'AUTHTEST_DEMOTE_ROLE_BEFORE', 'SIRIUS_MIGRATION_RESULT', 'REVISION_ALLOW_SELF_APPROVAL')) { $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k) }
$secretVars = [Collections.Generic.List[string]]::new()
$exitCode = 1
try {
    $env:POSTGRES_PASSWORD = New-Secret
    $env:APP_BIND_ADDRESS = '127.0.0.1'
    $env:APP_PORT = "$AppPort"
    $env:SESSION_COOKIE_SECURE = 'false'
    # 自己承認は既定（許可）で試験する。親プロセスに設定があっても持ち込まない
    $env:REVISION_ALLOW_SELF_APPROVAL = $null

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

    # ---- 既存DB（002・003 未適用）への起動時マイグレーション経路 ----
    # initdb で作られた認証テーブル（002）と操作履歴テーブル（003）を DROP して「導入前のDB」を再現し、
    # app 再起動で 002・003 が適用されること、2回目の再起動でも変わらない（冪等）ことを確認する。
    function Invoke-DbSql([string]$Sql) {
        $out = $Sql | & docker @compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U sirius -d sirius_reborn -tA
        if ($LASTEXITCODE -ne 0) { throw 'DB問い合わせに失敗しました' }
        @($out | Where-Object { $_ })
    }
    $compareSql = Get-Content -LiteralPath (Join-Path $root 'scripts/compare_restore.sql') -Raw -Encoding utf8
    function Get-DigestSet {
        $lines = Invoke-DbSql $compareSql
        [pscustomobject]@{
            # 業務テーブル（001）の件数・全行ダイジェスト（認証テーブル・操作履歴テーブルは除く）
            Business = @($lines | Where-Object { $_ -like 'table|*' -and $_ -notmatch '^table\|(app_|revision_events\|)' })
            # 認証テーブルの制約・インデックス定義
            AuthSchema = @($lines | Where-Object { $_ -notlike 'table|*' -and $_ -match 'app_(users|sessions)' })
            AuthTables = [int](@(Invoke-DbSql "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('app_users','app_sessions');")[0])
            # 操作履歴（003）の制約・索引・トリガー・関数の定義
            RevisionSchema = @($lines | Where-Object { $_ -notlike 'table|*' -and $_ -match 'revision_event' })
            RevisionTables = [int](@(Invoke-DbSql "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename = 'revision_events';")[0])
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
    Invoke-DbSql 'DROP TABLE IF EXISTS app_sessions; DROP TABLE IF EXISTS app_users; DROP TABLE IF EXISTS revision_events; DROP FUNCTION IF EXISTS forbid_revision_event_change();' | Out-Null
    $dropped = Get-DigestSet
    $r1 = Restart-App
    $first = Get-DigestSet
    $r2 = Restart-App
    $second = Get-DigestSet
    $same = { param($a, $b) (@(Compare-Object @($a) @($b))).Count -eq 0 }
    $revision = [ordered]@{
        initdb_revision_tables = $initial.RevisionTables
        revision_schema_objects = $initial.RevisionSchema.Count
        revision_tables_after_drop = $dropped.RevisionTables
        revision_schema_objects_after_drop = $dropped.RevisionSchema.Count
        restart1 = [ordered]@{ revision_tables = $first.RevisionTables; revision_schema_same_as_initdb = (& $same $initial.RevisionSchema $first.RevisionSchema)
            business_digest_unchanged = (& $same $initial.Business $first.Business) }
        restart2_idempotent = [ordered]@{ revision_tables = $second.RevisionTables; revision_schema_same_as_initdb = (& $same $initial.RevisionSchema $second.RevisionSchema)
            business_digest_unchanged = (& $same $initial.Business $second.Business) }
    }
    $revision.passed = ($initial.RevisionTables -eq 1) -and ($initial.RevisionSchema.Count -ge 5) -and ($dropped.RevisionTables -eq 0) -and ($dropped.RevisionSchema.Count -eq 0) -and
        $r1.Restarted -and $r1.Healthy -and ($first.RevisionTables -eq 1) -and $revision.restart1.revision_schema_same_as_initdb -and $revision.restart1.business_digest_unchanged -and
        $r2.Restarted -and $r2.Healthy -and ($second.RevisionTables -eq 1) -and $revision.restart2_idempotent.revision_schema_same_as_initdb -and $revision.restart2_idempotent.business_digest_unchanged
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
        revision_workflow_003 = $revision
    }
    $migration.passed = ($initial.AuthTables -eq 2) -and ($dropped.AuthTables -eq 0) -and ($initial.Business.Count -ge 14) -and
        $migration.business_unchanged_by_drop -and ($initial.AuthSchema.Count -gt 0) -and
        $r1.Restarted -and $r1.Healthy -and ($first.AuthTables -eq 2) -and $migration.restart1.auth_schema_same_as_initdb -and $migration.restart1.business_digest_unchanged -and
        $r2.Restarted -and $r2.Healthy -and ($second.AuthTables -eq 2) -and $migration.restart2_idempotent.auth_schema_same_as_initdb -and $migration.restart2_idempotent.business_digest_unchanged -and
        $revision.passed
    $env:SIRIUS_MIGRATION_RESULT = ($migration | ConvertTo-Json -Depth 5 -Compress)
    Write-Host "起動時マイグレーション経路: passed=$($migration.passed)（003: $($revision.passed)）"

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
    $apiAuthExit = $LASTEXITCODE

    # ---- 予算・発注の登録と承認（Phase 4）: scripts/test_revisions.mjs ----
    # test_auth.mjs は終了時に authtest-* 利用者を削除するため、別の試験用利用者 revtest-*（2社×3役割）をここで作る。
    foreach ($company in @('0000', '9001')) {
        foreach ($role in @('viewer', 'registrar', 'approver')) {
            $name = "REVTEST_PW_${company}_$($role.ToUpperInvariant())"
            $secret = New-Secret
            [Environment]::SetEnvironmentVariable($name, $secret)
            $secretVars.Add($name)
            $secret | & docker @compose exec -T app /app/sirius-reborn-backend add-user --company $company --user-id "revtest-$role" --role $role
            if ($LASTEXITCODE -ne 0) { throw "試験用利用者の作成に失敗しました: $company/revtest-$role" }
            $secret = $null
        }
    }
    $revArgs = @('run', '--rm', '--label', 'ai.agent=codex', '--network', $network,
        '-e', 'PGHOST=db', '-e', 'PGUSER=sirius', '-e', 'PGDATABASE=sirius_reborn', '-e', 'PGPASSWORD',
        '-e', 'SIRIUS_TEST_PSQL=1', '-e', 'SIRIUS_TEST_URL=http://app:8080',
        '-e', 'SIRIUS_REVISIONS_OUTPUT=artifacts/revisions-acceptance.json', '-e', 'SIRIUS_MIGRATION_RESULT',
        '-e', "SIRIUS_TEST_PROJECT=$project", '-e', "SIRIUS_TEST_COMMIT=$commit$dirty",
        '-e', 'SIRIUS_UI_CHECK=1', '-e', 'SIRIUS_PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright-core/index.mjs')
    foreach ($name in $secretVars) { if ($name -like 'REVTEST_PW_*') { $revArgs += @('-e', $name) } }
    # 375px 画面確認用に Alpine の chromium と playwright-core（frontend の playwright と同じ版）を試験コンテナ内だけに入れる
    $revArgs += @('--mount', "type=bind,source=$root,target=/repo", '-w', '/repo', 'node:22-alpine', 'sh', '-c',
        '(apk add --no-cache postgresql16-client || apk add --no-cache postgresql-client) >/dev/null && apk add --no-cache chromium >/dev/null && npm install --silent --no-audit --no-fund --prefix /tmp/pw playwright-core@1.64.1 >/dev/null && export CHROMIUM_PATH="$(command -v chromium-browser || command -v chromium)" && node scripts/test_revisions.mjs; rev=$?; echo "test_revisions=$rev"; [ $rev -eq 0 ]')
    & docker @revArgs
    $revExit = $LASTEXITCODE
    Write-Host "結果: test_api+test_auth=$apiAuthExit test_revisions=$revExit"
    $exitCode = if ($apiAuthExit -eq 0 -and $revExit -eq 0) { 0 } else { 1 }
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
