param([string[]]$CargoArgs = @('test', '--locked'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
# 認証スキーマ（migrations/002_auth.sql）を include_str! で埋め込むため、/migrations に読み取り専用でマウントする
$migrations = Join-Path $root 'migrations'
& docker run --rm --label ai.agent=codex --mount "type=bind,source=$backend,target=/app" --mount "type=bind,source=$migrations,target=/migrations,readonly" --mount 'type=volume,source=progenba-codex-cargo-registry,target=/usr/local/cargo/registry' --mount 'type=volume,source=progenba-codex-cargo-git,target=/usr/local/cargo/git' --workdir /app rust:1.80-bookworm cargo @CargoArgs
exit $LASTEXITCODE
