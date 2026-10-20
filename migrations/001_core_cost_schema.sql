-- ============================================================================
-- Project Sirius Reborn — 工事原価管理コア・データベーススキーマ (PostgreSQL 16+)
-- [LOCKED ANCHOR FILE] Aider によるスキーマ改変・サロゲートキー追加・FLOAT使用は厳禁
-- ============================================================================

BEGIN;

-- 1. 統合取引先（ビジネスパートナー）マスタ
CREATE TABLE business_partners (
    company_code          CHAR(4)        NOT NULL DEFAULT '0000',
    partner_code          VARCHAR(8)     NOT NULL,
    partner_name          VARCHAR(100)   NOT NULL,
    partner_short_name    VARCHAR(40)    NOT NULL,
    postal_code           VARCHAR(8),
    address_code          CHAR(5),
    address_line1         VARCHAR(100),
    address_line2         VARCHAR(100),
    phone_number          VARCHAR(20),
    fax_number            VARCHAR(20),
    is_customer           BOOLEAN        NOT NULL DEFAULT FALSE,
    is_subcontractor      BOOLEAN        NOT NULL DEFAULT FALSE,
    is_supplier           BOOLEAN        NOT NULL DEFAULT FALSE,
    is_employee           BOOLEAN        NOT NULL DEFAULT FALSE,
    is_bank               BOOLEAN        NOT NULL DEFAULT FALSE,
    is_taxable_vendor     BOOLEAN        NOT NULL DEFAULT TRUE,
    invoice_reg_number    VARCHAR(14),
    closing_day           SMALLINT       NOT NULL DEFAULT 99 CHECK (closing_day BETWEEN 1 AND 30 OR closing_day = 99),
    payment_month_offset  SMALLINT       NOT NULL DEFAULT 1  CHECK (payment_month_offset BETWEEN 0 AND 12),
    payment_day           SMALLINT       NOT NULL DEFAULT 99 CHECK (payment_day BETWEEN 1 AND 30 OR payment_day = 99),
    cash_ratio            NUMERIC(5,2)   NOT NULL DEFAULT 100.00,
    promissory_note_ratio NUMERIC(5,2)   NOT NULL DEFAULT 0.00,
    note_sight_days       SMALLINT       NOT NULL DEFAULT 0,
    safety_assoc_rate_num NUMERIC(5,2)   NOT NULL DEFAULT 3.00,
    safety_assoc_rate_den NUMERIC(5,2)   NOT NULL DEFAULT 1000.00,
    standard_daily_wage   NUMERIC(15,0)  NOT NULL DEFAULT 18000, -- 社員・職人の標準日額労務単価（概算労務費計算用）
    is_deleted            BOOLEAN        NOT NULL DEFAULT FALSE,
    PRIMARY KEY (company_code, partner_code),
    CONSTRAINT chk_partner_ratio CHECK (cash_ratio + promissory_note_ratio = 100.00)
);

-- 2. 工種マスタ（12桁構造化コード：大工種4桁 + 中工種4桁 + 小工種4桁）
CREATE TABLE work_types (
    company_code    CHAR(4)      NOT NULL DEFAULT '0000',
    work_type_code  VARCHAR(12)  NOT NULL CHECK (char_length(work_type_code) = 12),
    hierarchy_level SMALLINT     NOT NULL CHECK (hierarchy_level IN (1, 2, 3)),
    major_code      CHAR(4)      NOT NULL,
    middle_code     CHAR(4),
    minor_code      CHAR(4),
    work_type_name  VARCHAR(60)  NOT NULL,
    PRIMARY KEY (company_code, work_type_code)
);

-- 3. 費目マスタ（原価5要素：10=材料, 20=労務, 30=外注, 40=経費, 50=機械損料）
CREATE TABLE cost_elements (
    company_code       CHAR(4)      NOT NULL DEFAULT '0000',
    cost_element_code  CHAR(4)      NOT NULL,
    element_category   CHAR(2)      NOT NULL CHECK (element_category IN ('10', '20', '30', '40', '50')),
    cost_element_name  VARCHAR(40)  NOT NULL,
    PRIMARY KEY (company_code, cost_element_code)
);

-- 4. 品目・作業辞書マスタ（freee型UIで「買ったもの・作業」を選ぶだけで工種・費目を自動決定する辞書）
CREATE TABLE quick_item_templates (
    company_code       CHAR(4)       NOT NULL DEFAULT '0000',
    template_code      VARCHAR(8)    NOT NULL,
    item_label         VARCHAR(60)   NOT NULL, -- 例：「生コン打設」「重機リース」「現場駐車場・高速代」
    work_type_code     VARCHAR(12)   NOT NULL,
    cost_element_code  CHAR(4)       NOT NULL,
    default_unit       VARCHAR(10)   NOT NULL DEFAULT '式',
    default_unit_price NUMERIC(15,3) NOT NULL DEFAULT 0.000,
    PRIMARY KEY (company_code, template_code),
    FOREIGN KEY (company_code, work_type_code) REFERENCES work_types (company_code, work_type_code),
    FOREIGN KEY (company_code, cost_element_code) REFERENCES cost_elements (company_code, cost_element_code)
);

-- 5. 工事基本マスタ
CREATE TABLE project_masters (
    company_code       CHAR(4)       NOT NULL DEFAULT '0000',
    project_code       VARCHAR(10)   NOT NULL,
    project_name       VARCHAR(120)  NOT NULL,
    project_short_name VARCHAR(40)   NOT NULL,
    construction_type  CHAR(4)       NOT NULL DEFAULT '0001',
    doken_type         CHAR(1)       NOT NULL DEFAULT '1' CHECK (doken_type IN ('1', '2', '9')),
    honzatsu_type      CHAR(1)       NOT NULL DEFAULT '1' CHECK (honzatsu_type IN ('1', '2')),
    kanmin_type1       CHAR(1)       NOT NULL DEFAULT '2' CHECK (kanmin_type1 IN ('1', '2')),
    kanmin_type2       CHAR(1)       NOT NULL DEFAULT '9',
    order_format       CHAR(1)       NOT NULL DEFAULT '1' CHECK (order_format IN ('1', '2')),
    contract_method    CHAR(1)       NOT NULL DEFAULT '1',
    is_common_cost     BOOLEAN       NOT NULL DEFAULT FALSE,
    PRIMARY KEY (company_code, project_code)
);

-- 6. 工事枝番・施工契約管理（本工事='000', 追加工事='001'〜'999'）
CREATE TABLE project_branches (
    company_code                    CHAR(4)        NOT NULL DEFAULT '0000',
    project_code                    VARCHAR(10)    NOT NULL,
    branch_code                     CHAR(3)        NOT NULL DEFAULT '000',
    branch_name                     VARCHAR(80)    NOT NULL DEFAULT '本工事',
    completion_status               CHAR(1)        NOT NULL DEFAULT '0' CHECK (completion_status IN ('0', '1', '2', '3')),
    revenue_recognition_method      CHAR(1)        NOT NULL DEFAULT '0' CHECK (revenue_recognition_method IN ('0', '1')),
    managing_dept_code              CHAR(4)        NOT NULL DEFAULT '0000',
    site_manager_code               VARCHAR(8)     NOT NULL,
    supervising_engineer_code       VARCHAR(8),
    chief_engineer_code             VARCHAR(8),
    contract_start_date             DATE           NOT NULL,
    contract_end_date               DATE           NOT NULL,
    internal_start_date             DATE           NOT NULL,
    internal_end_date               DATE           NOT NULL,
    actual_completion_date          DATE,
    client_partner_code             VARCHAR(8)     NOT NULL,
    current_contract_amount_tax_ex  NUMERIC(15,0)  NOT NULL DEFAULT 0,
    current_contract_tax_amount     NUMERIC(15,0)  NOT NULL DEFAULT 0,
    estimated_total_cost            NUMERIC(15,0)  NOT NULL DEFAULT 0,
    approval_status                 CHAR(1)        NOT NULL DEFAULT '1' CHECK (approval_status IN ('0', '1', '2', '3', '9')),
    PRIMARY KEY (company_code, project_code, branch_code),
    FOREIGN KEY (company_code, project_code) REFERENCES project_masters (company_code, project_code),
    FOREIGN KEY (company_code, client_partner_code) REFERENCES business_partners (company_code, partner_code)
);

-- 7. 実行予算ヘッダ（Immutable Revision：history_no による履歴管理）
CREATE TABLE execution_budgets (
    company_code             CHAR(4)        NOT NULL DEFAULT '0000',
    project_code             VARCHAR(10)    NOT NULL,
    branch_code              CHAR(3)        NOT NULL,
    budget_history_no        SMALLINT       NOT NULL DEFAULT 0 CHECK (budget_history_no >= 0),
    budget_created_date      DATE           NOT NULL DEFAULT CURRENT_DATE,
    total_budget_amount      NUMERIC(15,0)  NOT NULL DEFAULT 0,
    target_gross_profit_rate NUMERIC(5,2)   NOT NULL DEFAULT 0.00,
    approval_status          CHAR(1)        NOT NULL DEFAULT '1' CHECK (approval_status IN ('0', '1', '2', '3', '9')),
    notes                    TEXT,
    PRIMARY KEY (company_code, project_code, branch_code, budget_history_no),
    FOREIGN KEY (company_code, project_code, branch_code)
        REFERENCES project_branches (company_code, project_code, branch_code)
);

-- 8. 実行予算明細
CREATE TABLE execution_budget_details (
    company_code       CHAR(4)        NOT NULL DEFAULT '0000',
    project_code       VARCHAR(10)    NOT NULL,
    branch_code        CHAR(3)        NOT NULL,
    budget_history_no  SMALLINT       NOT NULL,
    line_no            INTEGER        NOT NULL CHECK (line_no >= 1),
    work_type_code     VARCHAR(12)    NOT NULL,
    cost_element_code  CHAR(4)        NOT NULL,
    item_name          VARCHAR(60)    NOT NULL,
    specification      VARCHAR(60),
    unit               VARCHAR(10)    NOT NULL,
    planned_quantity   NUMERIC(15,3)  NOT NULL DEFAULT 1.000,
    planned_unit_price NUMERIC(15,3)  NOT NULL DEFAULT 0.000,
    planned_amount     NUMERIC(15,0)  NOT NULL DEFAULT 0,
    PRIMARY KEY (company_code, project_code, branch_code, budget_history_no, line_no),
    FOREIGN KEY (company_code, project_code, branch_code, budget_history_no)
        REFERENCES execution_budgets (company_code, project_code, branch_code, budget_history_no),
    FOREIGN KEY (company_code, work_type_code) REFERENCES work_types (company_code, work_type_code),
    FOREIGN KEY (company_code, cost_element_code) REFERENCES cost_elements (company_code, cost_element_code)
);

-- 9. 下請注文書ヘッダ（Immutable Revision：order_history_no による履歴管理）
CREATE TABLE subcontract_orders (
    company_code            CHAR(4)        NOT NULL DEFAULT '0000',
    order_number            VARCHAR(12)    NOT NULL,
    order_history_no        SMALLINT       NOT NULL DEFAULT 0 CHECK (order_history_no >= 0),
    project_code            VARCHAR(10)    NOT NULL,
    branch_code             CHAR(3)        NOT NULL,
    subcontractor_code      VARCHAR(8)     NOT NULL,
    work_type_code          VARCHAR(12)    NOT NULL,
    order_date              DATE           NOT NULL DEFAULT CURRENT_DATE,
    work_start_date         DATE           NOT NULL,
    work_end_date           DATE           NOT NULL,
    order_type              CHAR(1)        NOT NULL DEFAULT '1' CHECK (order_type IN ('1', '2')),
    is_unit_price_contract  BOOLEAN        NOT NULL DEFAULT FALSE,
    order_amount_tax_ex     NUMERIC(15,0)  NOT NULL DEFAULT 0,
    order_tax_amount        NUMERIC(15,0)  NOT NULL DEFAULT 0,
    tax_rate                NUMERIC(5,3)   NOT NULL DEFAULT 0.100,
    retainage_rate_num      NUMERIC(5,2)   NOT NULL DEFAULT 10.00,
    retainage_rate_den      NUMERIC(5,2)   NOT NULL DEFAULT 100.00,
    safety_assoc_rate_num   NUMERIC(5,2)   NOT NULL DEFAULT 3.00,
    safety_assoc_rate_den   NUMERIC(5,2)   NOT NULL DEFAULT 1000.00,
    order_status            CHAR(1)        NOT NULL DEFAULT '1' CHECK (order_status IN ('0', '1', '9')),
    PRIMARY KEY (company_code, order_number, order_history_no),
    FOREIGN KEY (company_code, project_code, branch_code)
        REFERENCES project_branches (company_code, project_code, branch_code),
    FOREIGN KEY (company_code, subcontractor_code)
        REFERENCES business_partners (company_code, partner_code),
    FOREIGN KEY (company_code, work_type_code)
        REFERENCES work_types (company_code, work_type_code)
);

-- 10. 月次出来高査定（外注費の実発生原価確定）
CREATE TABLE progress_assessments (
    company_code                 CHAR(4)        NOT NULL DEFAULT '0000',
    assessment_no                VARCHAR(12)    NOT NULL,
    order_number                 VARCHAR(12)    NOT NULL,
    order_history_no             SMALLINT       NOT NULL,
    subcontractor_code           VARCHAR(8)     NOT NULL,
    project_code                 VARCHAR(10)    NOT NULL,
    branch_code                  CHAR(3)        NOT NULL,
    work_type_code               VARCHAR(12)    NOT NULL,
    assessment_year_month        CHAR(6)        NOT NULL, -- YYYYMM
    assessment_closing_date      DATE           NOT NULL DEFAULT CURRENT_DATE,
    progress_rate_percent        NUMERIC(5,2)   NOT NULL DEFAULT 0.00,
    curr_assessed_amount_tax_ex  NUMERIC(15,0)  NOT NULL, -- ★工事台帳上の「外注実発生原価」
    curr_assessed_tax_amount     NUMERIC(15,0)  NOT NULL,
    accum_assessed_amount_tax_ex NUMERIC(15,0)  NOT NULL,
    accum_assessed_tax_amount    NUMERIC(15,0)  NOT NULL,
    curr_retainage_deduction     NUMERIC(15,0)  NOT NULL DEFAULT 0,
    curr_safety_assoc_deduction  NUMERIC(15,0)  NOT NULL DEFAULT 0,
    curr_fixed_deductions        NUMERIC(15,0)  NOT NULL DEFAULT 0,
    curr_chargeback_offset       NUMERIC(15,0)  NOT NULL DEFAULT 0,
    net_payment_amount           NUMERIC(15,0)  NOT NULL,
    PRIMARY KEY (company_code, assessment_no),
    FOREIGN KEY (company_code, order_number, order_history_no)
        REFERENCES subcontract_orders (company_code, order_number, order_history_no),
    FOREIGN KEY (company_code, project_code, branch_code)
        REFERENCES project_branches (company_code, project_code, branch_code)
);

-- 11. 材料費・現場経費かんたん登録テーブル（freee型カード入力による直課原価）
CREATE TABLE direct_cost_entries (
    company_code       CHAR(4)        NOT NULL DEFAULT '0000',
    entry_no           VARCHAR(12)    NOT NULL,
    project_code       VARCHAR(10)    NOT NULL,
    branch_code        CHAR(3)        NOT NULL,
    occurred_date      DATE           NOT NULL DEFAULT CURRENT_DATE,
    vendor_partner_code VARCHAR(8),
    work_type_code     VARCHAR(12)    NOT NULL,
    cost_element_code  CHAR(4)        NOT NULL, -- '10':材料費 または '40':現場経費
    item_name          VARCHAR(80)    NOT NULL,
    specification      VARCHAR(60),
    quantity           NUMERIC(15,3)  NOT NULL DEFAULT 1.000,
    unit               VARCHAR(10)    NOT NULL DEFAULT '式',
    unit_price         NUMERIC(15,3)  NOT NULL,
    amount_tax_ex      NUMERIC(15,0)  NOT NULL, -- ★工事台帳上の「材料・経費実発生原価」
    notes              TEXT,
    PRIMARY KEY (company_code, entry_no),
    FOREIGN KEY (company_code, project_code, branch_code)
        REFERENCES project_branches (company_code, project_code, branch_code),
    FOREIGN KEY (company_code, work_type_code)
        REFERENCES work_types (company_code, work_type_code),
    FOREIGN KEY (company_code, cost_element_code)
        REFERENCES cost_elements (company_code, cost_element_code)
);

-- 12. 現場日報・出面工数明細（労務費の実発生原価）
CREATE TABLE site_daily_reports (
    company_code       CHAR(4)        NOT NULL DEFAULT '0000',
    report_no          VARCHAR(12)    NOT NULL,
    work_date          DATE           NOT NULL DEFAULT CURRENT_DATE,
    employee_code      VARCHAR(8)     NOT NULL, -- business_partners (is_employee = true)
    project_code       VARCHAR(10)    NOT NULL,
    branch_code        CHAR(3)        NOT NULL,
    work_type_code     VARCHAR(12)    NOT NULL,
    work_hours         NUMERIC(15,3)  NOT NULL CHECK (work_hours > 0), -- 従事時間（例：8.000 時間）
    calculated_labor_cost NUMERIC(15,0) NOT NULL, -- ★標準日額または月次賃金按分による「労務実発生原価」
    work_summary       VARCHAR(120),
    PRIMARY KEY (company_code, report_no),
    FOREIGN KEY (company_code, employee_code)
        REFERENCES business_partners (company_code, partner_code),
    FOREIGN KEY (company_code, project_code, branch_code)
        REFERENCES project_branches (company_code, project_code, branch_code),
    FOREIGN KEY (company_code, work_type_code)
        REFERENCES work_types (company_code, work_type_code)
);

-- 13. 仮設資機材マスタ ＆ 現場移動・損料計算（機械・仮設損料の実発生原価）
CREATE TABLE construction_equipment_masters (
    company_code          CHAR(4)        NOT NULL DEFAULT '0000',
    equipment_code        VARCHAR(10)    NOT NULL,
    equipment_name        VARCHAR(60)    NOT NULL,
    specification         VARCHAR(40),
    unit                  VARCHAR(10)    NOT NULL,
    daily_rent_price      NUMERIC(15,3)  NOT NULL,
    monthly_rent_price    NUMERIC(15,3)  NOT NULL,
    loss_settlement_price NUMERIC(15,0)  NOT NULL DEFAULT 0,
    PRIMARY KEY (company_code, equipment_code)
);

CREATE TABLE equipment_site_movements (
    company_code       CHAR(4)        NOT NULL DEFAULT '0000',
    movement_slip_no   VARCHAR(12)    NOT NULL,
    equipment_code     VARCHAR(10)    NOT NULL,
    dest_project_code  VARCHAR(10)    NOT NULL,
    dest_branch_code   CHAR(3)        NOT NULL,
    work_type_code     VARCHAR(12)    NOT NULL,
    movement_date      DATE           NOT NULL DEFAULT CURRENT_DATE,
    movement_type      CHAR(2)        NOT NULL DEFAULT '02' CHECK (movement_type IN ('01','02','03','04','08','09','10')),
    quantity           NUMERIC(15,3)  NOT NULL,
    usage_days         INTEGER        NOT NULL DEFAULT 1 CHECK (usage_days >= 0),
    freight_fee        NUMERIC(15,0)  NOT NULL DEFAULT 0,
    maintenance_fee    NUMERIC(15,0)  NOT NULL DEFAULT 0,
    calculated_equip_cost NUMERIC(15,0) NOT NULL, -- ★損料(数量×日単価×日数)＋運賃＋整備費の「機械損料実発生原価」
    PRIMARY KEY (company_code, movement_slip_no),
    FOREIGN KEY (company_code, equipment_code)
        REFERENCES construction_equipment_masters (company_code, equipment_code),
    FOREIGN KEY (company_code, dest_project_code, dest_branch_code)
        REFERENCES project_branches (company_code, project_code, branch_code),
    FOREIGN KEY (company_code, work_type_code)
        REFERENCES work_types (company_code, work_type_code)
);

-- ============================================================================
-- DBレベル不変ガードトリガー（Aiderが誤ったSQLを書いてもDB自身が拒絶する防壁）
-- ============================================================================

-- ガード1: 承認済の実行予算・注文書に対するインプレースUPDATE禁止（Immutable Revision強制）
CREATE OR REPLACE FUNCTION forbid_approved_revision_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_REVISION_VIOLATION: 承認済の予算・注文書は直接UPDATEできません。history_noを+1した新レコードをINSERTしてください。';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_no_update_execution_budgets
BEFORE UPDATE ON execution_budgets
FOR EACH ROW WHEN (OLD.approval_status = '1')
EXECUTE FUNCTION forbid_approved_revision_update();

CREATE TRIGGER trg_no_update_subcontract_orders
BEFORE UPDATE ON subcontract_orders
FOR EACH ROW WHEN (OLD.order_status = '1')
EXECUTE FUNCTION forbid_approved_revision_update();

-- ============================================================================
-- 初期シードデータ（起動直後からコックピットと原価登録を即テスト可能なサンプル）
-- ============================================================================

INSERT INTO cost_elements (company_code, cost_element_code, element_category, cost_element_name) VALUES
('0000', '0100', '10', '材料費'),
('0000', '0200', '20', '労務費'),
('0000', '0300', '30', '外注費'),
('0000', '0400', '40', '現場経費'),
('0000', '0500', '50', '機械・仮設損料');

INSERT INTO work_types (company_code, work_type_code, hierarchy_level, major_code, middle_code, minor_code, work_type_name) VALUES
('0000', '001000000000', 1, '0010', NULL,   NULL,   '仮設・土工・基礎工事'),
('0000', '001000100010', 3, '0010', '0010', '0010', '外部足場・共通仮設'),
('0000', '001000200010', 3, '0010', '0020', '0010', '掘削・山留・基礎土工'),
('0000', '002000000000', 1, '0020', NULL,   NULL,   '躯体工事'),
('0000', '002000100010', 3, '0020', '0010', '0010', '鉄筋・型枠・躯体コンクリート'),
('0000', '003000100010', 3, '0030', '0010', '0010', '内装・仕上・設備工事');

INSERT INTO quick_item_templates (company_code, template_code, item_label, work_type_code, cost_element_code, default_unit, default_unit_price) VALUES
('0000', 'TMP-001', '生コンクリート（24-18-20N）購入', '002000100010', '0100', 'm3', 18500.000),
('0000', 'TMP-002', '異形鉄筋（D16 SD345）購入',       '002000100010', '0100', 't',  115000.000),
('0000', 'TMP-003', '砕石・砂・基礎資材購入',           '001000200010', '0100', 'm3', 6500.000),
('0000', 'TMP-004', '産廃処分・マニフェスト費',         '001000100010', '0400', '式', 45000.000),
('0000', 'TMP-005', '現場駐車場・道路使用・保安経費',   '001000100010', '0400', '式', 15000.000);

INSERT INTO business_partners (company_code, partner_code, partner_name, partner_short_name, is_customer, is_subcontractor, is_supplier, is_employee, standard_daily_wage) VALUES
('0000', 'CLI-0001', '青葉都市開発株式会社',     '青葉都市開発', TRUE,  FALSE, FALSE, FALSE, 0),
('0000', 'SUB-0001', '株式会社佐藤型枠工業',     '佐藤型枠',     FALSE, TRUE,  FALSE, FALSE, 0),
('0000', 'SUB-0002', '鈴木基礎工事株式会社',     '鈴木基礎',     FALSE, TRUE,  FALSE, FALSE, 0),
('0000', 'SUP-0001', '東京建材リース株式会社',   '東京建材',     FALSE, FALSE, TRUE,  FALSE, 0),
('0000', 'EMP-0001', '高橋 健太（現場代理人）',   '高橋健太',     FALSE, FALSE, FALSE, TRUE,  22000),
('0000', 'EMP-0002', '渡辺 誠（多能工・職長）',   '渡辺誠',       FALSE, FALSE, FALSE, TRUE,  20000);

INSERT INTO project_masters (company_code, project_code, project_name, project_short_name, doken_type, honzatsu_type) VALUES
('0000', 'PRJ-2026-A', '青葉台レジデンス新築工事', '青葉台レジ新築', '2', '1');

INSERT INTO project_branches (
    company_code, project_code, branch_code, branch_name, completion_status,
    site_manager_code, supervising_engineer_code,
    contract_start_date, contract_end_date, internal_start_date, internal_end_date,
    client_partner_code, current_contract_amount_tax_ex, current_contract_tax_amount, estimated_total_cost, approval_status
) VALUES
('0000', 'PRJ-2026-A', '000', '本工事（新築本体）', '0', 'EMP-0001', 'EMP-0001',
 '2026-04-01', '2026-12-20', '2026-04-05', '2026-12-10',
 'CLI-0001', 50000000, 5000000, 38000000, '1'),
('0000', 'PRJ-2026-A', '001', '第1回追加工事（外構擁壁変更）', '0', 'EMP-0001', 'EMP-0001',
 '2026-06-01', '2026-12-20', '2026-06-05', '2026-12-10',
 'CLI-0001', 5000000, 500000, 3500000, '1');

INSERT INTO execution_budgets (company_code, project_code, branch_code, budget_history_no, total_budget_amount, target_gross_profit_rate, approval_status, notes) VALUES
('0000', 'PRJ-2026-A', '000', 0, 38000000, 24.00, '1', '当初承認済実行予算'),
('0000', 'PRJ-2026-A', '001', 0, 3500000,  30.00, '1', '追加工事当初実行予算');

INSERT INTO execution_budget_details (company_code, project_code, branch_code, budget_history_no, line_no, work_type_code, cost_element_code, item_name, unit, planned_quantity, planned_unit_price, planned_amount) VALUES
('0000', 'PRJ-2026-A', '000', 0, 1, '001000100010', '0500', '外部枠組足場・仮囲い損料', '式', 1.000,  2500000.000,  2500000),
('0000', 'PRJ-2026-A', '000', 0, 2, '001000200010', '0300', '根伐・山留・基礎土工外注', '式', 1.000,  8500000.000,  8500000),
('0000', 'PRJ-2026-A', '000', 0, 3, '002000100010', '0300', '型枠・鉄筋組立一式外注',   '式', 1.000, 10000000.000, 10000000),
('0000', 'PRJ-2026-A', '000', 0, 4, '002000100010', '0100', '生コン・鉄筋資材購入',     '式', 1.000, 11000000.000, 11000000),
('0000', 'PRJ-2026-A', '000', 0, 5, '002000100010', '0200', '直営施工管理・多能工労務', '人', 200.000,  20000.000,  4000000),
('0000', 'PRJ-2026-A', '000', 0, 6, '001000100010', '0400', '現場水道光熱・産廃・諸経費', '式', 1.000,  2000000.000,  2000000),
('0000', 'PRJ-2026-A', '001', 0, 1, '001000200010', '0300', '追加擁壁土工・型枠外注',   '式', 1.000,  3500000.000,  3500000);

INSERT INTO subcontract_orders (
    company_code, order_number, order_history_no, project_code, branch_code,
    subcontractor_code, work_type_code, order_date, work_start_date, work_end_date,
    order_amount_tax_ex, order_tax_amount, retainage_rate_num, retainage_rate_den, safety_assoc_rate_num, safety_assoc_rate_den, order_status
) VALUES
('0000', 'ORD-2026-001', 0, 'PRJ-2026-A', '000', 'SUB-0001', '002000100010',
 '2026-04-10', '2026-04-15', '2026-10-31', 10000000, 1000000, 10.00, 100.00, 3.00, 1000.00, '1'),
('0000', 'ORD-2026-002', 0, 'PRJ-2026-A', '000', 'SUB-0002', '001000200010',
 '2026-04-12', '2026-04-15', '2026-07-31',  8000000,  800000, 10.00, 100.00, 3.00, 1000.00, '1');

INSERT INTO construction_equipment_masters (company_code, equipment_code, equipment_name, specification, unit, daily_rent_price, monthly_rent_price, loss_settlement_price) VALUES
('0000', 'EQP-001', '枠組足場セット（建枠・布板・筋交）', 'W900×H1700', 'スパン', 120.000, 3000.000, 25000),
('0000', 'EQP-002', '防音型ディーゼル発電機',             '25kVA',       '台',    4500.000, 95000.000, 800000);

COMMIT;
