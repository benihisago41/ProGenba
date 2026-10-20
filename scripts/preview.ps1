param([switch]$Stop)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$name='progenba-codex-preview'
$existing=& docker ps -a --filter "name=^${name}$" --format '{{.ID}}'
if ($existing) {
    $owner=& docker inspect $name --format '{{index .Config.Labels "ai.task"}}'
    if ($owner -ne 'sirius-reborn-20261020') { throw '他セッションのプレビューは操作しません' }
    if ($Stop) { & docker stop $name | Out-Null; & docker rm $name | Out-Null }
    exit 0
}
if ($Stop) { exit 0 }
$backend=Join-Path $root 'backend'
$static=Join-Path $root 'frontend/dist'
& docker run -d --name $name --label ai.agent=codex --label ai.task=sirius-reborn-20261020 --network progenba-codex-dev -p 127.0.0.1:8080:8080 -e DATABASE_URL=postgres://postgres@progenba-codex-phase0-db:5432/sirius_reborn -e STATIC_DIR=/static --mount "type=bind,source=$backend,target=/app,readonly" --mount "type=bind,source=$static,target=/static,readonly" -w /app rust:1.80-bookworm /app/target/debug/sirius-reborn-backend | Out-Null
exit $LASTEXITCODE
