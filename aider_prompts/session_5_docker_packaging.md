# Session 5: Windows Server不要・ローカル単一コンテナ化 (`Dockerfile`, `docker-compose.yml`)

あなたはインフラ・コンテナパッケージング担当エンジニアです。
Read-Onlyで提供された `CONVENTIONS.md`, `migrations/001_core_cost_schema.sql`, `backend/Cargo.toml`, `frontend/package.json` を参照し、Windows Server等の管理負担を一切発生させず `docker compose up -d` 1コマンドで社内稼働する `Dockerfile` と `docker-compose.yml` を作成してください。

## 実装仕様

### 1. マルチステージ `Dockerfile`
- **Stage 1 (`frontend-builder`)**: `node:22-alpine` を使用し、`frontend/` を `npm install && npm run build` して静的ファイル（`dist/`）を生成。
- **Stage 2 (`backend-builder`)**: `rust:1.80-bookworm` を使用し、`backend/` を `cargo build --release` して単一ネイティブバイナリ `sirius-reborn-backend` を生成。
- **Stage 3 (`runtime`)**: 軽量な `debian:bookworm-slim`（`ca-certificates`, `libssl3` のみ導入）に、Stage 2の単一バイナリとStage 1の `dist/`（`/app/static` 等）をコピー。メモリ消費数十MBで高速動作する構成とする。

### 2. ゼロメンテナンス `docker-compose.yml`
- **`db` サービス**:
  - イメージ: `postgres:16-alpine`
  - 文字コード・ロケール: UTF-8
  - `./migrations/001_core_cost_schema.sql` を `/docker-entrypoint-initdb.d/001_core_cost_schema.sql:ro` にマウントし、初回起動時に全テーブル・不変トリガー・初期シードデータが自動構築されるようにする。
  - `healthcheck` (`pg_isready`) と永続化ボリューム `pgdata` を設定。
- **`app` サービス**:
  - 上記 `Dockerfile` をビルドし、`db` の `service_healthy` 後に自動起動。
  - ポート `8080:8080` を公開し、社内LANのどのPC・タブレット・スマホのブラウザからも `http://<ホストIP>:8080` で即座に利用可能にする。
  - `restart: unless-stopped` を設定し、PC再起動時も人手を介さず自動復旧させる。

## 管理者による確定補足
- 編集担当はDockerfile/docker-compose.ymlの2つのみ。アンカー/ソース/依存を変更しない。他者の変更を戻さない。コマンド・commit・pushは禁止。
- 構成はアプリとPostgreSQL16の2サービス。name: progenba を設定し、各サービスのlabelsに ai.agent: codex を設定する。container_nameは指定しない。
- Rust builderは既定rust:1.80-bookwormを維持し、cargo build --release --locked。frontend builderはnode:22-alpineでnpm ci && npm run build。COPY対象は各サブディレクトリとlockfileを含める。runtimeはdebian:bookworm-slim＋ca-certificates/libssl3。単一バイナリと/app/staticをコピーしUSER 10001:10001で実行。EXPOSE8080。STATIC_DIR=/app/static。
- dbのPOSTGRES_USERはsirius、POSTGRES_DBはsirius_reborn、POSTGRES_PASSWORDは ${POSTGRES_PASSWORD:?環境変数POSTGRES_PASSWORDを設定してください} として.envから取得。接続文字列をログに出さない。dbのhostポートは公開しない。
- appのDATABASE_URLは上記dbサービス名・ユーザー・パスワードと一致。portsは ${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-8080}:8080。検証後に明示設定で社内LANに公開できる。db healthcheckはpg_isready、appはservice_healthyを待機。両方restart unless-stopped。
- dbのnamed volume pgdataで永続化し、001のDDLを初回だけread-onlyマウントする。アプリ起動毎にシード再投入しない。
- 現状のmainに未実装のhealthcheckコマンド引数などを想定して追加しない。
- db healthcheckのpg_isreadyは -h 127.0.0.1 を付け、初期化中の一時Unixソケットサーバーではなく本稼働TCP接続の準備を確認する。
