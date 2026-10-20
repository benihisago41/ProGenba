# 稼働中DB（progenba-db-1）をpg_dumpカスタム形式で取得し、SHA256を併記して世代管理する。
# 稼働DB・ボリュームへは読み取りのみ。保存先はリポジトリ外（既定: OneDrive\ProGenba-backups）。
param(
    [string]$BackupDir = $(if ($env:OneDrive) { Join-Path $env:OneDrive 'ProGenba-backups' } else { '' }),
    [ValidateRange(1,365)][int]$Keep = 7
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (!$BackupDir) { throw '保存先を -BackupDir で指定してください。' }
$fullDir = [IO.Path]::GetFullPath($BackupDir)
if ($fullDir.StartsWith([IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'バックアップをリポジトリ内へ保存しないでください。'
}
New-Item -ItemType Directory -Force -Path $fullDir | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$name = "progenba_$stamp.dump"
$inContainer = "/tmp/$name"
$dest = Join-Path $fullDir $name
$timer = [Diagnostics.Stopwatch]::StartNew()
& docker compose exec -T db pg_dump -U sirius -d sirius_reborn -Fc -f $inContainer
if ($LASTEXITCODE -ne 0) { throw 'pg_dumpに失敗しました。docker compose ps と docker compose logs db を確認してください。' }
try {
    # パイプ経由のバイナリ変換を避けるため、コンテナ内に書き出してからコピーする
    & docker compose cp "db:$inContainer" $dest
    if ($LASTEXITCODE -ne 0) { throw 'ダンプのコピーに失敗しました。' }
}
finally {
    & docker compose exec -T db rm -f $inContainer | Out-Null
}
$hash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $name" | Set-Content -LiteralPath "$dest.sha256" -Encoding ascii
$timer.Stop()

# 世代管理：本スクリプトの命名規則に一致するファイルだけを古い順に削除する
$old = Get-ChildItem -LiteralPath $fullDir -File -Filter 'progenba_*.dump' |
    Where-Object Name -match '^progenba_\d{8}T\d{6}Z\.dump$' |
    Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($f in $old) {
    Remove-Item -LiteralPath $f.FullName
    Remove-Item -LiteralPath "$($f.FullName).sha256" -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    file = $dest
    bytes = (Get-Item -LiteralPath $dest).Length
    sha256 = $hash
    seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
    pruned = @($old).Count
} | ConvertTo-Json
