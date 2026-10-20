#!/bin/sh
set -eu

# オプション解析（--no-build のみ許可）
NO_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --no-build)
            NO_BUILD=1
            ;;
        *)
            echo "エラー: 未知の引数です: $arg (使用可能: --no-build)" >&2
            exit 1
            ;;
    esac
done

# スクリプト位置からリポジトリルートへ移動
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

# 前提コマンドとDocker起動状態の確認
if ! command -v docker >/dev/null 2>&1; then
    echo "エラー: docker コマンドが見つかりません。" >&2
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "エラー: docker compose (Compose v2) が利用できません。" >&2
    exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
    echo "エラー: curl コマンドが見つかりません。" >&2
    exit 1
fi
if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    echo "エラー: Dockerデーモンが起動していません。Dockerを起動してください。" >&2
    exit 1
fi

# .env が存在しない場合のみ生成（既存は変更しない）
if [ ! -e .env ]; then
    OLD_UMASK=$(umask)
    umask 077
    SECRET=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
    if [ "${#SECRET}" -lt 48 ]; then
        echo "エラー: 乱数の生成に失敗しました。" >&2
        umask "$OLD_UMASK"
        exit 1
    fi
    printf 'POSTGRES_PASSWORD=%s\nAPP_BIND_ADDRESS=127.0.0.1\nAPP_PORT=8080\n' "$SECRET" > .env
    unset SECRET
    umask "$OLD_UMASK"
    echo "ローカル検証用の.envを作成しました（Git管理対象外）。"
fi

# コンテナのビルドと起動（停止・削除・ボリューム操作は行わない）
if [ "$NO_BUILD" -eq 1 ]; then
    docker compose up -d --wait
else
    docker compose up -d --wait --build
fi

# .env から設定を文字列として読み取る（source/eval禁止）
FILE_BIND_ADDRESS=""
FILE_PORT=""
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%$(printf '\r')}
        case "$line" in
            APP_BIND_ADDRESS=*)
                FILE_BIND_ADDRESS=${line#APP_BIND_ADDRESS=}
                ;;
            APP_PORT=*)
                FILE_PORT=${line#APP_PORT=}
                ;;
        esac
    done < .env
fi

# 優先順位: プロセス環境変数 > .env > 既定値
FINAL_BIND_ADDRESS=${APP_BIND_ADDRESS:-${FILE_BIND_ADDRESS:-127.0.0.1}}
FINAL_PORT=${APP_PORT:-${FILE_PORT:-8080}}

# 0.0.0.0 の場合はヘルスチェック接続先のみ 127.0.0.1 に置換
CHECK_ADDRESS="$FINAL_BIND_ADDRESS"
if [ "$CHECK_ADDRESS" = "0.0.0.0" ]; then
    CHECK_ADDRESS="127.0.0.1"
fi

TASK_URL="http://${CHECK_ADDRESS}:${FINAL_PORT}"

# ヘルスチェック待機（最大約45秒）
READY=0
START_TIME=$(date +%s)
DEADLINE=$((START_TIME + 45))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if curl --fail --silent --show-error --max-time 2 "${TASK_URL}/api/v1/health" >/dev/null 2>&1; then
        READY=1
        break
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        break
    fi
    sleep 2
done

if [ "$READY" -ne 1 ]; then
    echo "エラー: アプリの稼働確認がタイムアウトしました。docker compose logs app を確認してください。" >&2
    exit 1
fi

echo "起動しました: $TASK_URL"
