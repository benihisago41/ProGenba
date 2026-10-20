# ============================================================================
# scripts/verify_gate.ps1 — 管理者AI用・脱線検知＆品質ゲート自動監査スクリプト
# 使い方: powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session <1..5>
# 戻り値: 0 = 合格 (次セッションへ進行可), 1 = 違反検出 (Aiderへ修正指示またはgitロールバック)
# ============================================================================

param(
    [Parameter(Mandatory=$true)]
    [ValidateRange(1, 5)]
    [int]$Session
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Violations = @()

Write-Host "=== [Gate Audit] Session $Session 監査を開始します ===" -ForegroundColor Cyan

# ----------------------------------------------------------------------------
# Gate 1: 不変アンカーファイル（Read-Only契約）の改ざん検知
# ----------------------------------------------------------------------------
$AnchorChecks = @(
    @{ Path = "CONVENTIONS.md";                       MustContain = "NUMERIC(15,0)" },
    @{ Path = "migrations/001_core_cost_schema.sql";  MustContain = "forbid_approved_revision_update" },
    @{ Path = "backend/src/domain/types.rs";          MustContain = "pub struct ProjectCostCockpitDto" },
    @{ Path = "frontend/src/bindings.ts";             MustContain = "SUBMIT_SUBCONTRACT_PROGRESS" }
)

foreach ($anchor in $AnchorChecks) {
    if (-not (Test-Path $anchor.Path)) {
        $Violations += "[ANCHOR_MISSING] 必須アンカーファイルが消失しています: $($anchor.Path)"
    } else {
        $content = Get-Content -Path $anchor.Path -Raw -Encoding UTF8
        if ($content -notmatch [regex]::Escape($anchor.MustContain)) {
            $Violations += "[ANCHOR_CORRUPTED] アンカーファイル $($anchor.Path) の必須定義 '$($anchor.MustContain)' が改ざん・削除されています。"
        }
    }
}

# ----------------------------------------------------------------------------
# Gate 2: 禁止パターン（浮動小数点・サロゲート主キー・経理仕訳への脱線）の静的スキャン
# ----------------------------------------------------------------------------
$TargetFiles = @()
if (Test-Path "backend/src") {
    $TargetFiles += Get-ChildItem -Path "backend/src" -Recurse -Filter "*.rs"
}
if (Test-Path "frontend/src") {
    $TargetFiles += Get-ChildItem -Path "frontend/src" -Recurse -Include "*.ts", "*.tsx"
}

$ForbiddenPatterns = @(
    @{ Regex = "\bf32\b|\bf64\b";                        Reason = "浮動小数点型 (f32/f64) の使用は禁止されています。Decimal または YenAmount(i64) を使用してください。" },
    @{ Regex = "journal_entry|journal_entries";          Reason = "スコープ違反: 経理・複式仕訳 (journal_entry) の実装は禁止されています。" },
    @{ Regex = "借方|貸方|勘定科目|未成工事支出金";        Reason = "スコープ・UX違反: 経理用語（借方・貸方・勘定科目・未成工事支出金）をコードやUIに含めてはなりません。" }
)

foreach ($file in $TargetFiles) {
    # コメント行を除いた実コードに対して検査
    $lines = Get-Content -Path $file.FullName -Encoding UTF8
    $lineNum = 0
    foreach ($line in $lines) {
        $lineNum++
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("//") -or $trimmed.StartsWith("/*") -or $trimmed.StartsWith("*")) {
            continue
        }
        foreach ($rule in $ForbiddenPatterns) {
            if ($trimmed -match $rule.Regex) {
                $Violations += "[DRIFT_DETECTED] $($file.Name):L$lineNum -> $($rule.Reason)"
            }
        }
    }
}

# ----------------------------------------------------------------------------
# Gate 3: セッション別の必須ファイル存在＆コンパイル・単体テスト検証
# ----------------------------------------------------------------------------
if ($Session -ge 1) {
    if (-not (Test-Path "backend/src/domain/calc.rs")) {
        $Violations += "[MISSING_FILE] Session 1 の成果物 backend/src/domain/calc.rs が存在しません。"
    }
}

if ($Session -ge 2) {
    foreach ($reqFile in @("backend/src/main.rs", "backend/src/api/projects.rs", "backend/src/api/actual_costs.rs")) {
        if (-not (Test-Path $reqFile)) {
            $Violations += "[MISSING_FILE] Session 2 の成果物 $reqFile が存在しません。"
        }
    }
}

if ($Session -in @(1, 2)) {
    Write-Host "-> Rust コンパイル・単体テストを実行中..." -ForegroundColor Yellow
    if (Get-Command "cargo" -ErrorAction SilentlyContinue) {
        & cargo test --manifest-path backend/Cargo.toml
        if ($LASTEXITCODE -ne 0) {
            $Violations += "[CARGO_TEST_FAILED] backend の cargo test が失敗しました。"
        }
    } elseif (Get-Command "docker" -ErrorAction SilentlyContinue) {
        $backendAbs = (Resolve-Path "backend").Path
        & docker run --rm -v "${backendAbs}:/app" -w /app rust:1.80-bookworm cargo test
        if ($LASTEXITCODE -ne 0) {
            $Violations += "[CARGO_TEST_FAILED] Docker コンテナ上での cargo test が失敗しました。"
        }
    } else {
        $Violations += "[TOOLCHAIN_MISSING] cargo も docker も見つかりません。"
    }
}

if ($Session -ge 3) {
    foreach ($reqFile in @("frontend/src/App.tsx", "frontend/src/CockpitView.tsx")) {
        if (-not (Test-Path $reqFile)) {
            $Violations += "[MISSING_FILE] Session 3 の成果物 $reqFile が存在しません。"
        }
    }
}

if ($Session -ge 4) {
    if (-not (Test-Path "frontend/src/EasyCostInput.tsx")) {
        $Violations += "[MISSING_FILE] Session 4 の成果物 frontend/src/EasyCostInput.tsx が存在しません。"
    }
}

if ($Session -in @(3, 4)) {
    Write-Host "-> Frontend TypeScript 型チェック (tsc --noEmit) を実行中..." -ForegroundColor Yellow
    Push-Location "frontend"
    try {
        if (-not (Test-Path "node_modules")) {
            & npm.cmd install
        }
        & npm.cmd run typecheck
        if ($LASTEXITCODE -ne 0) {
            $Violations += "[TS_TYPECHECK_FAILED] frontend の TypeScript 型チェック (tsc --noEmit) が失敗しました。"
        }
    } finally {
        Pop-Location
    }
}

if ($Session -eq 5) {
    foreach ($reqFile in @("Dockerfile", "docker-compose.yml")) {
        if (-not (Test-Path $reqFile)) {
            $Violations += "[MISSING_FILE] Session 5 の成果物 $reqFile が存在しません。"
        }
    }
}

# ----------------------------------------------------------------------------
# 最終判定出力
# ----------------------------------------------------------------------------
if ($Violations.Count -gt 0) {
    Write-Host "`n❌ [GATE FAILED] Session $Session で以下の違反・エラーが検出されました:" -ForegroundColor Red
    foreach ($v in $Violations) {
        Write-Host "  - $v" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "`n✅ [GATE PASSED] Session $Session のすべての不変契約・型検査・テストに合格しました！次のセッションへ進んでください。" -ForegroundColor Green
    exit 0
}
