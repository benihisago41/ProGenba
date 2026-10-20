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

## 管理者による確定補足（既存指示と矛盾する場合はこちらを優先）
- 編集対象は api/mod.rs, api/projects.rs, api/actual_costs.rs, main.rs の最大4ファイル。他の変更を戻さず、アンカー・calc.rs・依存を変更しない。コマンド・commit・pushは禁止。
- DBクエリは動的 sqlx::query と Row::try_get を使い、ビルド時DBを要求するquery!系マクロを使わない。NUMERIC金額取得はCAST AS BIGINT、数量/率はDecimal。Decimal計算結果が15桁を超える場合は422（JS safe integerも超えない）。
- main.rsは mod api; とし、domainは sirius_reborn_backend::domain を使用。api/mod.rsに共有AppState/PgPool、ApiErrorのIntoResponse、JSON rejectionを共通ErrorResponseへ変換する処理、routerを実装。public router(pool: PgPool) -> Router とする。mainは DATABASE_URL 未設定で安全にエラー終了（認証情報をログ出力しない）、STATIC_DIR 既定 ./static、PORT既定8080、GET /api/v1/health はSELECT 1でDB readiness確認、API未定義はJSON404、staticはSPAフォールバックで配信。CORSはsame-originを基本とする。
- cockpitは company_code既定0000、project_code/branch_code任意絞込。companyを全クエリとJOIN条件へ含める。最新承認済予算/発注をそれぞれ選択後、原価ソースごとに独立集計してから結合する。素の複数明細表を同時JOINして金額が倍増しないこと。budgetは明細合計、工種別も同じ履歴。by_work_typeは予算・発注・原価のいずれか存在する工種を全て表示。予算0の率は0、請負0の粗利率は0。RateはDecimal小数2桁。forecast=max(予算,発注確定,実原価)。発注確定=最新承認発注額+材料経費+労務+機械、外注出来高を追加して二重計上しない。
- lookupsもcompany_code既定0000。型はPhase0のLookupsDtoそのまま。発注は最新承認済のみ。過去査定累計は注文番号全履歴でSUM(curr_assessed_...)を使い、最新累計のSUMをしない。is_deleted取引先は除外し、employees/suppliersロールを確認。契約実値の率と税額を返す。
- 全POSTは201 CostRegistrationResponse{document_no,warnings}。404不存在、409旧発注履歴、422入力不正/ロック。JSON失敗も共通ErrorResponse{code,message}。DBエラーは詳細/接続文字列を応答やログに漏らさない。
- ガードからINSERTまで同一transaction。project_branchesをFOR UPDATEし区分2/3拒否、区分1警告、internal_end_date超過警告。会社内の工種(厳密12桁)、仕入先、社員、機材の存在/ロール確認を行う。数量・時間は正数でscale<=3、単価は0以上でscale<=3、usage_daysは正整数、金額は0以上/15桁以下、費目0100/0400、年月は実在YYYYMM、branchは3桁。積・加算はchecked Decimal/i64で、DB制約による黙った丸めを許可しない。
- 採番はpg_advisory_xact_lock(hashtextextended(company_code || ':' || 伝票種別,0))を取得し、該当表のcompany内MAX(12桁数字文字列)から+1、左ゼロ詰め12桁。SQL table名は固定したmatch/定数からのみ選択しユーザー値を補間しない。上限超過は422。採番も登録と同一TX。
- 出来高はcompany+order_number全体のadvisory lockも取り、最新承認履歴をFOR UPDATEで取得、req履歴と一致しなければ409。過去全履歴のSUMから累計を計算しcalc関数を呼ぶ。req値でproject/subcontractor/work_type/率を決めない。前回+今回>契約、負額、控除超過を拒否。INSERTにprogress_rate_percentを累計/契約*100で設定（契約0は0）。無関係な承認済発注UPDATEを行わない。
- direct/daily/equipmentは純粋calcを呼ぶ前にchecked積で15桁金額範囲を検証しpanicを防止。機械movement_typeは02。日報は概算原価で、月次確定賃金の登録UI/APIは今回対象外。
- 計算・DBデコードのunwrapやexpectは避け、HTTPエラーへ伝播する。予算超過は警告表示対象で登録を止めない。
