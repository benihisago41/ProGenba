param(
    [Parameter(Mandatory)][string]$Task,
    [Parameter(Mandatory)][string]$MessageFile,
    [Parameter(Mandatory)][string[]]$EditableFiles,
    [string[]]$ReferenceFiles = @()
)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if ($EditableFiles.Count -gt 4) { throw '編集対象は最大4ファイルです。' }
$run = Join-Path $root "artifacts/runs/$Task"
New-Item -ItemType Directory -Path $run -Force | Out-Null
$aiderArgs = @(
    '--model', 'vertex_ai/gemini-4-argon',
    '--weak-model', 'vertex_ai/gemini-3.8-flash',
    '--message-file', $MessageFile, '--encoding', 'utf-8',
    '--no-auto-commits', '--no-dirty-commits', '--no-gitignore',
    '--no-auto-lint', '--no-auto-test', '--no-suggest-shell-commands',
    '--no-watch-files', '--no-restore-chat-history', '--no-check-update',
    '--no-show-release-notes', '--no-analytics', '--no-pretty', '--no-stream', '--no-detect-urls',
    '--chat-language', 'Japanese', '--map-tokens', '0', '--max-chat-history-tokens', '100000',
    '--input-history-file', (Join-Path $run 'input.history'),
    '--chat-history-file', (Join-Path $run 'chat.history.md')
)
foreach ($file in $EditableFiles) { $aiderArgs += @('--file', $file) }
foreach ($file in $ReferenceFiles) { $aiderArgs += @('--read', $file) }
& aider @aiderArgs 2>&1 | Tee-Object -FilePath (Join-Path $run 'output.log') | ForEach-Object {
    if ($_ -match 'Tokens:|Applied edit|Error|error:|Exception|Main model:|Weak model:|Added |Unable|failed|Retry|confirm|Warning|warning') { Write-Output $_ }
}
exit $LASTEXITCODE
