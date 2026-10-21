-- ============================================================================
-- Project Sirius Reborn — 認証・権限（Phase 3）スキーマ (PostgreSQL 16+)
-- 冪等: 何度実行しても同じ結果になる（IF NOT EXISTS）。業務テーブルは変更しない。
-- 適用経路:
--   (a) 新規構築: docker-compose.yml で initdb に 001 の後で投入
--   (b) 既存DB : アプリ起動時に同一内容を自動適用（backend/src/api/auth.rs）
-- 規約: 各テーブルの複合主キー先頭は company_code CHAR(4)。SERIAL・UUID・浮動小数点は使わない。
-- ============================================================================

BEGIN;

-- 同時起動したアプリ間で DDL が競合しないよう、トランザクション単位で直列化する
SELECT pg_advisory_xact_lock(hashtextextended('sirius_reborn:002_auth', 0));

-- 1. 利用者（1利用者 = 1会社 = 1役割）
CREATE TABLE IF NOT EXISTS app_users (
    company_code        CHAR(4)       NOT NULL,
    user_id             VARCHAR(32)   NOT NULL,
    display_name        VARCHAR(60),
    password_hash       VARCHAR(255)  NOT NULL,                 -- Argon2id PHC文字列（平文は保存しない）
    role                VARCHAR(16)   NOT NULL,                 -- viewer / registrar / approver
    is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
    failed_login_count  SMALLINT      NOT NULL DEFAULT 0,       -- 連続ログイン失敗回数
    locked_until        TIMESTAMPTZ,                            -- 一時ロック期限（NULL=ロックなし）
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (company_code, user_id),
    CONSTRAINT chk_app_users_company CHECK (company_code ~ '^[0-9A-Za-z]{4}$'),
    CONSTRAINT chk_app_users_user_id CHECK (user_id ~ '^[0-9A-Za-z._-]{1,32}$'),
    CONSTRAINT chk_app_users_role CHECK (role IN ('viewer', 'registrar', 'approver')),
    CONSTRAINT chk_app_users_failed CHECK (failed_login_count >= 0)
);

-- 2. サーバー側セッション（トークン本体は保存せず SHA-256 の16進のみ）
CREATE TABLE IF NOT EXISTS app_sessions (
    company_code        CHAR(4)       NOT NULL,
    token_hash          CHAR(64)      NOT NULL,
    user_id             VARCHAR(32)   NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ   NOT NULL,                 -- 無操作失効（スライディング更新）
    PRIMARY KEY (company_code, token_hash),
    CONSTRAINT fk_app_sessions_user FOREIGN KEY (company_code, user_id)
        REFERENCES app_users (company_code, user_id) ON DELETE CASCADE,
    CONSTRAINT chk_app_sessions_token CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

-- Cookie にはトークンのみを載せるため、トークンハッシュ単独で一意検索できるようにする
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_sessions_token_hash ON app_sessions (token_hash);
CREATE INDEX IF NOT EXISTS ix_app_sessions_expires_at ON app_sessions (expires_at);
CREATE INDEX IF NOT EXISTS ix_app_sessions_user ON app_sessions (company_code, user_id);

COMMIT;
