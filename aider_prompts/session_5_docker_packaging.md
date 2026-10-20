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
