-- ============================================================================
-- Project Sirius Reborn — 予算・発注の登録と承認（Phase 4）操作履歴スキーマ (PostgreSQL 16+)
-- 冪等: 何度実行しても同じ結果になる（IF NOT EXISTS / CREATE OR REPLACE）。業務テーブル（001）は変更しない。
-- 適用経路:
--   (a) 新規構築: docker-compose.yml で initdb に 001・002 の後で投入
--   (b) 既存DB : アプリ起動時に同一内容を自動適用（backend/src/api/schema.rs）
-- 規約: 複合主キー先頭は company_code CHAR(4)。SERIAL・UUID・浮動小数点は使わない。
--       操作番号 event_no は会社ごとに「既存最大+1」を排他ロック（pg_advisory_xact_lock）の下で採番する。
-- 状態値（業務テーブルの既存列をそのまま使う）:
--   execution_budgets.approval_status / subcontract_orders.order_status
--   '0' = 未承認の案, '1' = 承認済, '9' = 否認（仕様書 §6.2 の '3' 申請中・'2' 確認済は将来拡張）
-- ============================================================================

BEGIN;

-- 同時起動したアプリ間で DDL が競合しないよう、トランザクション単位で直列化する
SELECT pg_advisory_xact_lock(hashtextextended('sirius_reborn:003_revision_workflow', 0));

-- 操作履歴（誰が・いつ・何を・理由）。追記専用。
-- 利用者の削除後も履歴を残すため app_users への外部キーは張らない（利用者IDと役割を記録時点の値で保存）。
CREATE TABLE IF NOT EXISTS revision_events (
    company_code    CHAR(4)        NOT NULL,
    event_no        BIGINT         NOT NULL,                -- 会社ごとの連番（既存最大+1）
    occurred_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    actor_user_id   VARCHAR(32)    NOT NULL,
    actor_role      VARCHAR(16)    NOT NULL,                -- 操作時点の役割
    target_type     VARCHAR(16)    NOT NULL,                -- project / branch / budget / order
    action          VARCHAR(16)    NOT NULL,                -- create / update / delete / approve / reject
    project_code    VARCHAR(10),
    branch_code     CHAR(3),
    order_number    VARCHAR(12),
    history_no      SMALLINT,                               -- 予算 budget_history_no / 発注 order_history_no
    reason          VARCHAR(200),                           -- 否認理由（必須）・承認コメント（任意）
    amount_before   NUMERIC(15,0),                          -- 操作前の金額（予算総額・発注額税抜。無ければ NULL）
    amount_after    NUMERIC(15,0),                          -- 操作後の金額
    PRIMARY KEY (company_code, event_no),
    CONSTRAINT chk_revision_events_company CHECK (company_code ~ '^[0-9A-Za-z]{4}$'),
    CONSTRAINT chk_revision_events_no CHECK (event_no >= 1),
    CONSTRAINT chk_revision_events_role CHECK (actor_role IN ('viewer', 'registrar', 'approver')),
    CONSTRAINT chk_revision_events_target CHECK (target_type IN ('project', 'branch', 'budget', 'order')),
    CONSTRAINT chk_revision_events_action CHECK (action IN ('create', 'update', 'delete', 'approve', 'reject')),
    CONSTRAINT chk_revision_events_reject_reason CHECK (
        action <> 'reject' OR (reason IS NOT NULL AND char_length(btrim(reason)) BETWEEN 1 AND 200)
    ),
    CONSTRAINT chk_revision_events_key CHECK (
        (target_type = 'project' AND project_code IS NOT NULL)
     OR (target_type = 'branch'  AND project_code IS NOT NULL AND branch_code IS NOT NULL)
     OR (target_type = 'budget'  AND project_code IS NOT NULL AND branch_code IS NOT NULL AND history_no IS NOT NULL)
     OR (target_type = 'order'   AND order_number IS NOT NULL AND history_no IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS ix_revision_events_branch ON revision_events (company_code, project_code, branch_code, event_no);
CREATE INDEX IF NOT EXISTS ix_revision_events_order ON revision_events (company_code, order_number, history_no);

-- 追記専用ガード: 操作履歴の UPDATE・DELETE を DB が拒否する
CREATE OR REPLACE FUNCTION forbid_revision_event_change()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'REVISION_EVENT_IMMUTABLE: 操作履歴（revision_events）は追記専用です。変更・削除はできません。';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_revision_events_append_only
BEFORE UPDATE OR DELETE ON revision_events
FOR EACH ROW EXECUTE FUNCTION forbid_revision_event_change();

COMMIT;
