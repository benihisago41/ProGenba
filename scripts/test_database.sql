\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';
    IF n <> 14 THEN RAISE EXCEPTION 'テーブル数不一致: %',n; END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND NOT EXISTS (
            SELECT 1 FROM information_schema.key_column_usage k
            JOIN information_schema.table_constraints c USING (constraint_catalog,constraint_schema,constraint_name)
            WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name
              AND c.constraint_type='PRIMARY KEY' AND k.ordinal_position=1 AND k.column_name='company_code'
        )
    ) THEN RAISE EXCEPTION '会社コードが主キー先頭ではありません'; END IF;
    BEGIN
        UPDATE execution_budgets SET total_budget_amount=1 WHERE company_code='0000';
        RAISE EXCEPTION '承認済予算を変更できました';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'IMMUTABLE_REVISION_VIOLATION:%' THEN RAISE; END IF;
    END;
    BEGIN
        UPDATE subcontract_orders SET order_amount_tax_ex=1 WHERE company_code='0000';
        RAISE EXCEPTION '承認済発注を変更できました';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'IMMUTABLE_REVISION_VIOLATION:%' THEN RAISE; END IF;
    END;
    BEGIN
        UPDATE business_partners SET safety_assoc_rate_den=0 WHERE partner_code='SUB-0001';
        RAISE EXCEPTION 'ゼロ分母が保存できました';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO site_daily_reports(company_code,report_no,employee_code,project_code,branch_code,work_type_code,work_hours,calculated_labor_cost)
        VALUES ('9999','000000000001','EMP-0001','PRJ-2026-A','000','001000100010',8,22000);
        RAISE EXCEPTION '会社違いの参照が保存できました';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    SELECT count(*) INTO n FROM project_branches;
    IF n <> 2 THEN RAISE EXCEPTION '初期枝番数不一致'; END IF;
END $$;
ROLLBACK;
SELECT 'DB_ACCEPTANCE_PASSED';
