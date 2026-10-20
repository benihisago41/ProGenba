# Session 2: バックエンドAPI・PostgreSQL集計実装 (`api/*.rs`, `main.rs`)

あなたは建設原価管理システム「Project Sirius Reborn」のバックエンドAPI担当エンジニアです。
Read-Onlyで提供された `CONVENTIONS.md`, `migrations/001_core_cost_schema.sql`, `backend/src/domain/types.rs`, `backend/src/domain/calc.rs`, `frontend/src/bindings.ts` に厳密に従い、Axum + SQLx によるAPIサーバーを実装してください。

## 厳守ルール
1. `types.rs`, `calc.rs`, `001_core_cost_schema.sql`, `bindings.ts` は変更禁止です。
2. エンドポイントURLは `frontend/src/bindings.ts` の `API_ENDPOINTS` 定数と1文字の狂いもなく一致させてください。
3. 経理・仕訳テーブルや会計処理は一切実装しないでください。
4. `f32` / `f64` は使用禁止です。SQLxでの数値取得は `Decimal` または `i64`（`CAST(... AS BIGINT)` 等）で行ってください。

## 実装するエンドポイントと仕様

### 1. `GET /api/v1/cockpit` (`backend/src/api/projects.rs`)
- クエリパラメータ（任意）: `company_code`（既定 `"0000"`）
- 対象会社の全工事枝番（`project_branches` JOIN `project_masters`）について、`Vec<ProjectCostCockpitDto>` を返却する。
- **集計ロジック（重要）**:
  - **実行予算額 (`execution_budget_amount`)**: `execution_budgets` のうち `approval_status = '1'` かつ最大の `budget_history_no` を持つレコードの明細合計（工種別も同様に最新 `budget_history_no` のみを集計）。
  - **発注・確定済額 (`ordered_committed_amount`)**: 最新 `order_history_no`（`order_status = '1'`）の `subcontract_orders.order_amount_tax_ex` 合計 ＋ `direct_cost_entries.amount_tax_ex` 合計 ＋ `site_daily_reports.calculated_labor_cost` 合計 ＋ `equipment_site_movements.calculated_equip_cost` 合計。
  - **実際発生原価 (`actual_occurred_cost` ＆ `actual_breakdown`)**:
    - `material_cost` (`10`): `direct_cost_entries` のうち `cost_element_code = '0100'` の `amount_tax_ex` 合計
    - `labor_cost` (`20`): `site_daily_reports.calculated_labor_cost` 合計
    - `subcontract_cost` (`30`): `progress_assessments.curr_assessed_amount_tax_ex` 合計
    - `expense_cost` (`40`): `direct_cost_entries` のうち `cost_element_code = '0400'` の `amount_tax_ex` 合計
    - `equipment_cost` (`50`): `equipment_site_movements.calculated_equip_cost` 合計
    - `total_cost`: 上記5要素の合計
  - **着地予想総原価 (`forecast_final_cost`)**: `max(execution_budget_amount, ordered_committed_amount, actual_occurred_cost)`
  - **見込粗利 (`forecast_gross_profit`)**: `contract_amount_tax_ex - forecast_final_cost`
  - **予算超過フラグ (`is_budget_exceeded`)**: `actual_occurred_cost > execution_budget_amount` または `ordered_committed_amount > execution_budget_amount`
  - **監理技術者警告 (`requires_supervising_engineer_warning`)**: 下請発注総額が `45,000,000` 円以上 かつ `supervising_engineer_code` が NULL または空文字の場合 `true`。

### 2. `GET /api/v1/lookups` (`backend/src/api/projects.rs`)
- かんたん原価入力画面で必要なマスタ一覧を1回のリクエストで返すJSONエンドポイント：
  - `quick_templates`: `Vec<QuickItemTemplateDto>`（`quick_item_templates` テーブル）
  - `subcontract_orders`: `Vec<SubcontractOrderSummaryDto>`（最新 `order_history_no` の発注一覧とこれまでの査定累計・発注残高）
  - `work_types`: 小工種（`hierarchy_level = 3`）の一覧
  - `employees`: `business_partners` のうち `is_employee = true` の一覧
  - `suppliers`: `business_partners` のうち `is_supplier = true` の一覧
  - `equipments`: `construction_equipment_masters` の一覧

### 3. 4大原価のかんたん登録API (`backend/src/api/actual_costs.rs`)
- **共通ガード制約**: 対象の `(company_code, project_code, branch_code)` の `completion_status` を確認し、`CompletionStatus::can_accept_cost()` が `false`（`'2'` または `'3'`）の場合は **HTTP 422 Unprocessable Entity** でエラーメッセージを返すこと。
- **`POST /api/v1/costs/subcontract-progress`** (`EasySubcontractProgressRequest`):
  - 対象注文書の最新履歴と過去査定累計をDBから取得し、`calc::calc_subcontract_assessment` を呼び出して消費税・保留金・安全協力会費・差引支払額を算出し、`progress_assessments` に `INSERT` する。
- **`POST /api/v1/costs/direct-entry`** (`EasyDirectCostRequest`):
  - `calc::calc_line_amount(req.quantity, req.unit_price)` で `amount_tax_ex` を決定論的に算出し、`direct_cost_entries` に `INSERT` する。
- **`POST /api/v1/costs/daily-report`** (`EasyDailyReportRequest`):
  - `business_partners` から該当社員の `standard_daily_wage` を取得し、`calc::calc_daily_labor_cost` で概算労務原価を算出して `site_daily_reports` に `INSERT` する。
- **`POST /api/v1/costs/equipment-movement`** (`EasyEquipmentMovementRequest`):
  - `construction_equipment_masters` から `daily_rent_price` を取得し、`calc::calc_equipment_movement_cost` で損料原価を算出して `equipment_site_movements` に `INSERT` する。

### 4. `backend/src/main.rs`
- 環境変数 `DATABASE_URL`（未設定時は `"postgres://postgres:postgres@localhost:5432/sirius_reborn"`）で `PgPool` に接続。
- `/api/v1/...` ルーターと、フロントエンドのビルド成果物（`../frontend/dist` または `./static`）を配信する `ServeDir`、CORS許可を設定し、`0.0.0.0:8080` でリッスンする。
