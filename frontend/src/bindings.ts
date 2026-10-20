// ============================================================================
// frontend/src/bindings.ts — バックエンド (backend/src/domain/types.rs) 完全同期型定義
// [LOCKED ANCHOR FILE] Aider によるフィールド名・型定義の勝手な変更は厳禁
// ============================================================================

/** 日本円金額（整数・NUMERIC(15,0)） */
export type YenAmount = number;

/** 数量・単価・比率（文字列表現による固定小数点シリアライズ・NUMERIC(15,3) / NUMERIC(5,2)） */
export type DecimalString = string;

export interface ProjectBranchKey {
  company_code: string; // CHAR(4) 例: "0000"
  project_code: string; // VARCHAR(10)
  branch_code: string;  // CHAR(3) 例: "000"(本工事), "001"(追加工事)
}

export type CompletionStatus = "0" | "1" | "2" | "3";
export type ElementCategory = "10" | "20" | "30" | "40" | "50";

export interface CostElementBreakdown {
  material_cost: YenAmount;    // 10: 材料費
  labor_cost: YenAmount;       // 20: 労務費（出面日報）
  subcontract_cost: YenAmount; // 30: 外注費（出来高査定）
  expense_cost: YenAmount;     // 40: 現場経費
  equipment_cost: YenAmount;   // 50: 機械・仮設損料
  total_cost: YenAmount;
}

export interface WorkTypeCostRow {
  work_type_code: string; // 12桁工種コード
  work_type_name: string;
  budget_amount: YenAmount;
  ordered_amount: YenAmount;
  actual_cost: YenAmount;
  remaining_budget: YenAmount;
  consumption_rate_percent: DecimalString;
}

export interface ProjectCostCockpitDto {
  key: ProjectBranchKey;
  project_name: string;
  branch_name: string;
  completion_status: CompletionStatus;
  contract_amount_tax_ex: YenAmount;   // ① 請負契約額（税抜）
  latest_budget_history_no: number;
  execution_budget_amount: YenAmount;  // ② 実行予算総額
  ordered_committed_amount: YenAmount; // ③ 発注・確定済額
  actual_occurred_cost: YenAmount;     // ④ 実際発生原価（最重要指標）
  forecast_final_cost: YenAmount;      // ⑤ 着地予想総原価
  forecast_gross_profit: YenAmount;    // 見込粗利額
  forecast_profit_rate: DecimalString; // 見込粗利率（%）
  is_budget_exceeded: boolean;
  requires_supervising_engineer_warning: boolean;
  actual_breakdown: CostElementBreakdown;
  by_work_type: WorkTypeCostRow[];
}

export interface EasySubcontractProgressRequest {
  company_code: string;
  order_number: string;
  order_history_no: number;
  assessment_year_month: string; // YYYYMM
  curr_assessed_amount_tax_ex: YenAmount;
  fixed_deductions: YenAmount;
  chargeback_offset: YenAmount;
}

export interface EasyDirectCostRequest {
  company_code: string;
  project_code: string;
  branch_code: string;
  occurred_date: string; // YYYY-MM-DD
  vendor_partner_code?: string | null;
  work_type_code: string;
  cost_element_code: "0100" | "0400"; // 0100:材料費, 0400:現場経費
  item_name: string;
  specification?: string | null;
  quantity: DecimalString;
  unit: string;
  unit_price: DecimalString;
  notes?: string | null;
}

export interface EasyDailyReportRequest {
  company_code: string;
  work_date: string; // YYYY-MM-DD
  employee_code: string;
  project_code: string;
  branch_code: string;
  work_type_code: string;
  work_hours: DecimalString;
  work_summary?: string | null;
}

export interface EasyEquipmentMovementRequest {
  company_code: string;
  equipment_code: string;
  dest_project_code: string;
  dest_branch_code: string;
  work_type_code: string;
  movement_date: string; // YYYY-MM-DD
  quantity: DecimalString;
  usage_days: number;
  freight_fee: YenAmount;
  maintenance_fee: YenAmount;
}

export interface QuickItemTemplateDto {
  template_code: string;
  item_label: string;
  work_type_code: string;
  cost_element_code: "0100" | "0400";
  default_unit: string;
  default_unit_price: DecimalString;
}

export interface SubcontractOrderSummaryDto {
  order_number: string;
  order_history_no: number;
  project_code: string;
  branch_code: string;
  subcontractor_code: string;
  subcontractor_name: string;
  work_type_code: string;
  work_type_name: string;
  order_amount_tax_ex: YenAmount;
  accum_assessed_amount_tax_ex: YenAmount;
  accum_assessed_tax_amount: YenAmount;
  remaining_order_balance: YenAmount;
  tax_rate: DecimalString;
  retainage_rate_num: DecimalString;
  retainage_rate_den: DecimalString;
  safety_assoc_rate_num: DecimalString;
  safety_assoc_rate_den: DecimalString;
}

export interface WorkTypeLookupDto {
  work_type_code: string;
  work_type_name: string;
}

export interface EmployeeLookupDto {
  employee_code: string;
  employee_name: string;
  standard_daily_wage: YenAmount;
}

export interface SupplierLookupDto {
  partner_code: string;
  partner_name: string;
}

export interface EquipmentLookupDto {
  equipment_code: string;
  equipment_name: string;
  unit: string;
  daily_rent_price: DecimalString;
}

export interface LookupsDto {
  quick_templates: QuickItemTemplateDto[];
  subcontract_orders: SubcontractOrderSummaryDto[];
  work_types: WorkTypeLookupDto[];
  employees: EmployeeLookupDto[];
  suppliers: SupplierLookupDto[];
  equipments: EquipmentLookupDto[];
}

export interface CostRegistrationResponse {
  document_no: string;
  warnings: string[];
}

export interface ErrorResponse {
  code: string;
  message: string;
}

/** API エンドポイント契約一覧（バックエンド・フロントエンド間のURL不一致防止定数） */
export const API_ENDPOINTS = {
  /** GET: 工事枝番一覧および原価コックピット取得 (?company_code=0000&project_code=...&branch_code=...) */
  COCKPIT: "/api/v1/cockpit",
  /** GET: かんたん入力用マスタ辞書（品目テンプレート・発注一覧・作業員一覧・資機材一覧）一括取得 */
  MASTER_LOOKUPS: "/api/v1/lookups",
  /** POST: ①外注出来高査定の登録 */
  SUBMIT_SUBCONTRACT_PROGRESS: "/api/v1/costs/subcontract-progress",
  /** POST: ②材料費・現場経費カードの登録 */
  SUBMIT_DIRECT_COST: "/api/v1/costs/direct-entry",
  /** POST: ③スマホ3タップ現場日報（出面）の登録 */
  SUBMIT_DAILY_REPORT: "/api/v1/costs/daily-report",
  /** POST: ④資機材出庫・機械損料の登録 */
  SUBMIT_EQUIPMENT_MOVEMENT: "/api/v1/costs/equipment-movement",
} as const;
