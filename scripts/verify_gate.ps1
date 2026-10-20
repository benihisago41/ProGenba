param([Parameter(Mandatory)][ValidateRange(1,5)][int]$Session)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$violations = [Collections.Generic.List[string]]::new()
$manifest = Join-Path $root 'artifacts/anchor-hashes.json'
if (!(Test-Path -LiteralPath $manifest)) { $violations.Add('[ANCHOR_BASELINE_MISSING] アンカー基準が未固定です。') }
else {
    foreach ($anchor in (Get-Content -LiteralPath $manifest -Raw -Encoding utf8 | ConvertFrom-Json)) {
        if (!(Test-Path -LiteralPath $anchor.path)) { $violations.Add("[ANCHOR_MISSING] $($anchor.path)") }
        elseif ((Get-FileHash -LiteralPath $anchor.path -Algorithm SHA256).Hash -ne $anchor.sha256) { $violations.Add("[ANCHOR_CORRUPTED] $($anchor.path)") }
    }
}
$sources = @(Get-ChildItem backend/src -Recurse -File -Filter '*.rs') + @(Get-ChildItem frontend/src -Recurse -File -Include '*.ts','*.tsx')
foreach ($file in $sources) {
    $lineNo = 0
    foreach ($line in (Get-Content -LiteralPath $file.FullName -Encoding utf8)) {
        $lineNo++
        if ($line.Trim() -match '^(//|/\*|\*)') { continue }
        if ($line -match '\bf32\b|\bf64\b|journal_entries|journal_entry|借方|貸方|勘定科目|未成工事支出金') { $violations.Add("[DRIFT_DETECTED] $($file.Name):${lineNo}") }
    }
}
$sql = Get-Content migrations/001_core_cost_schema.sql -Raw -Encoding utf8
$sql = $sql -replace '(?m)--.*$', ''
if ($sql -match '\b(FLOAT|REAL|DOUBLE|SERIAL|BIGSERIAL|UUID)\b') { $violations.Add('[SQL_DRIFT] 禁止された数値型またはキー型です。') }
$required = @('backend/src/lib.rs','backend/src/domain/calc.rs')
if ($Session -ge 2) { $required += @('backend/src/main.rs','backend/src/api/mod.rs','backend/src/api/projects.rs','backend/src/api/actual_costs.rs') }
if ($Session -ge 3) { $required += @('frontend/index.html','frontend/vite.config.ts','frontend/src/main.tsx','frontend/src/App.tsx','frontend/src/CockpitView.tsx') }
if ($Session -ge 4) { $required += 'frontend/src/EasyCostInput.tsx' }
if ($Session -ge 5) { $required += @('Dockerfile','docker-compose.yml') }
foreach ($file in $required) { if (!(Test-Path -LiteralPath $file)) { $violations.Add("[MISSING_FILE] $file") } }
if ($violations.Count -eq 0 -and $Session -in @(1,2)) {
    & "$PSScriptRoot/test_backend.ps1"
    if ($LASTEXITCODE -ne 0) { $violations.Add('[CARGO_TEST_FAILED] Rust試験失敗') }
}
if ($violations.Count -eq 0 -and $Session -eq 2) {
    & "$PSScriptRoot/test_backend_api.ps1"
    if ($LASTEXITCODE -ne 0) { $violations.Add('[API_ACCEPTANCE_FAILED] 実DBを用いたAPI受入試験失敗') }
}
if ($violations.Count -eq 0 -and $Session -in @(3,4)) {
    Push-Location frontend
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { $violations.Add('[TS_BUILD_FAILED] 型検査またはビルド失敗') }
    } finally { Pop-Location }
}
if ($violations.Count -eq 0 -and $Session -eq 5) {
    & docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { $violations.Add('[COMPOSE_CONFIG_FAILED] Compose設定不正') }
    foreach ($evidence in @('artifacts/acceptance-api.json','artifacts/acceptance-browser.json','artifacts/acceptance-persistence.json')) {
        if (!(Test-Path -LiteralPath $evidence)) { $violations.Add("[EVIDENCE_MISSING] $evidence") }
        elseif (!(Get-Content -LiteralPath $evidence -Raw | ConvertFrom-Json).passed) { $violations.Add("[ACCEPTANCE_FAILED] $evidence") }
    }
}
$result = [ordered]@{ session=$Session; passed=($violations.Count -eq 0); checked_at=(Get-Date).ToUniversalTime().ToString('o'); commit=(& git rev-parse HEAD); violations=$violations.ToArray() }
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "artifacts/gate-$Session.json" -Encoding utf8
if ($violations.Count) { $violations | ForEach-Object { Write-Host $_ }; Write-Host '[GATE FAILED]'; exit 1 }
Write-Host "[GATE PASSED] Session $Session"
exit 0
