param([string[]]$CargoArgs = @('test', '--locked'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
& docker run --rm --label ai.agent=codex --mount "type=bind,source=$backend,target=/app" --mount 'type=volume,source=progenba-codex-cargo-registry,target=/usr/local/cargo/registry' --mount 'type=volume,source=progenba-codex-cargo-git,target=/usr/local/cargo/git' --workdir /app rust:1.80-bookworm cargo @CargoArgs
exit $LASTEXITCODE
