# 利用者の作成・更新（管理者用）。画面での利用者管理は提供しない。
# 例) pwsh -File scripts/add_user.ps1 -CompanyCode 0000 -UserId genba01 -Role registrar -DisplayName "現場 太郎"
#     既存利用者のパスワード・役割変更: -Update を付ける（既存セッションは全て失効）
# - パスワードはその場で2回対話入力（画面に表示しない）。引数・ファイル・ログには残さない。
# - 稼働中のアプリコンテナ（docker compose の app サービス）内でサブコマンド add-user を実行し、
#   パスワードは標準入力で渡す。DBには Argon2id ハッシュのみ保存される。
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Za-z]{4}$')][string]$CompanyCode,
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Za-z._-]{1,32}$')][string]$UserId,
    [Parameter(Mandatory)][ValidateSet('viewer', 'registrar', 'approver')][string]$Role,
    [string]$DisplayName,
    [switch]$Update,
    # 既定は本リポジトリの Compose プロジェクト（docker-compose.yml の name: progenba）
    [string]$ComposeProject
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$compose = @('compose')
if ($ComposeProject) { $compose += @('-p', $ComposeProject) }

$first = Read-Host -AsSecureString 'パスワード（12文字以上）'
$second = Read-Host -AsSecureString 'パスワード（確認）'
$plain1 = [Net.NetworkCredential]::new('', $first).Password
$plain2 = [Net.NetworkCredential]::new('', $second).Password
try {
    if ($plain1 -cne $plain2) { throw 'パスワードが一致しません。' }
    if ($plain1.Length -lt 12) { throw 'パスワードは12文字以上にしてください。' }

    $cliArgs = @('add-user', '--company', $CompanyCode, '--user-id', $UserId, '--role', $Role)
    if ($DisplayName) { $cliArgs += @('--display-name', $DisplayName) }
    if ($Update) { $cliArgs += '--update' }

    $plain1 | & docker @compose exec -T app /app/sirius-reborn-backend @cliArgs
    if ($LASTEXITCODE -ne 0) { throw "利用者の登録に失敗しました（終了コード $LASTEXITCODE）。" }
}
finally {
    $plain1 = $null
    $plain2 = $null
    $first.Dispose()
    $second.Dispose()
}
