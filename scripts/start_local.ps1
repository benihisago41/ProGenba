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
$taskSettings=@{APP_BIND_ADDRESS='127.0.0.1';APP_PORT='8080'}
foreach($line in (Get-Content -LiteralPath .env -Encoding utf8)) {
    if($line -match '^(APP_BIND_ADDRESS|APP_PORT)=(.*)$') { $taskSettings[$Matches[1]]=$Matches[2].Trim() }
}
foreach($key in @('APP_BIND_ADDRESS','APP_PORT')) {
    $value=[Environment]::GetEnvironmentVariable($key)
    if($value) { $taskSettings[$key]=$value }
}
$taskAddress=$taskSettings.APP_BIND_ADDRESS
if($taskAddress -eq '0.0.0.0') { $taskAddress='127.0.0.1' }
$taskUrl="http://${taskAddress}:$($taskSettings.APP_PORT)"
$taskReady=$false
$taskTimer=[Diagnostics.Stopwatch]::StartNew()
while($taskTimer.Elapsed.TotalSeconds -lt 45) {
    try { $null=Invoke-RestMethod "$taskUrl/api/v1/health" -TimeoutSec 2; $taskReady=$true; break }
    catch { Start-Sleep -Seconds 2 }
}
if(!$taskReady) { throw 'アプリの稼働確認がタイムアウトしました。docker compose logs app を確認してください。' }
Write-Host "起動しました: $taskUrl"
Write-Host "ログインには利用者が必要です。初回は pwsh -File scripts/add_user.ps1 -CompanyCode 0000 -UserId <利用者ID> -Role approver で作成してください。"
