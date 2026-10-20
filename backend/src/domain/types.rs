// ============================================================================
// backend/src/domain/types.rs — ドメイン型・API契約（LOCKED ANCHOR FILE）
// ※Aiderはこのファイルの型名・フィールド名を勝手に変更してはならない。
// ※f32 / f64 の使用は全面禁止。金額は YenAmount(i64)、数量・単価・率は Decimal を使用する。
// ============================================================================

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// 日本円金額型 — DB: NUMERIC(15,0) と1対1対応（端数を持たない整数円）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct YenAmount(pub i64);

impl YenAmount {
    pub const ZERO: Self = Self(0);

    pub fn checked_add(self, rhs: Self) -> Option<Self> {
        self.0.checked_add(rhs.0).map(Self)
    }

    pub fn checked_sub(self, rhs: Self) -> Option<Self> {
        self.0.checked_sub(rhs.0).map(Self)
    }
}

/// 数量・工数型 — DB: NUMERIC(15,3)（小数点以下3桁）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Quantity(pub Decimal);

/// 単価型 — DB: NUMERIC(15,3)（小数点以下3桁）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UnitPrice(pub Decimal);

/// 比率・進捗率型 — DB: NUMERIC(5,2)（小数点以下2桁）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rate(pub Decimal);

/// マルチテナント複合主キー：工事枝番識別子
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProjectBranchKey {
    pub company_code: String, // CHAR(4) 例: "0000"
    pub project_code: String, // VARCHAR(10)
    pub branch_code: String,  // CHAR(3) 例: "000"(本工事), "001"(追加工事)
}

/// 完成区分（0:未成, 1:完成, 2:前期完成, 3:計上ロック済）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompletionStatus {
    #[serde(rename = "0")]
    Uncompleted,
    #[serde(rename = "1")]
    Completed,
    #[serde(rename = "2")]
    PriorCompleted,
    #[serde(rename = "3")]
    Locked,
}

impl CompletionStatus {
    pub fn from_code(code: &str) -> Result<Self, String> {
        match code.trim() {
            "0" => Ok(Self::Uncompleted),
            "1" => Ok(Self::Completed),
            "2" => Ok(Self::PriorCompleted),
            "3" => Ok(Self::Locked),
            other => Err(format!("不正な完成区分コード: {}", other)),
        }
    }

    /// 完了ロック済（'2' または '3'）は原価投入を遮断（HTTP 422）
    pub fn can_accept_cost(self) -> bool {
        matches!(self, Self::Uncompleted | Self::Completed)
    }
}

/// 原価要素大区分（10:材料費, 20:労務費, 30:外注費, 40:現場経費, 50:機械損料）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ElementCategory {
    #[serde(rename = "10")]
    Material,
    #[serde(rename = "20")]
    Labor,
    #[serde(rename = "30")]
    Subcontract,
    #[serde(rename = "40")]
    Expense,
    #[serde(rename = "50")]
    Equipment,
}

// ============================================================================
// 計算エンジン入出力型（Session 1: calc.rs 用）
// ============================================================================

/// 下請出来高査定の計算入力パラメータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssessmentCalcInput {
    pub order_amount_tax_ex: YenAmount,
    pub prev_accum_assessed_tax_ex: YenAmount,
    pub prev_accum_tax_amount: YenAmount,
    pub curr_assessed_tax_ex: YenAmount,
    pub tax_rate: Decimal, // 例: 0.10
    pub retainage_rate_num: Rate,
    pub retainage_rate_den: Rate,
    pub safety_assoc_rate_num: Rate,
    pub safety_assoc_rate_den: Rate,
    pub fixed_deductions: YenAmount,
    pub chargeback_offset: YenAmount,
}

/// 下請出来高査定の決定論的計算結果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssessmentCalcOutput {
    pub curr_assessed_amount_tax_ex: YenAmount, // 工事台帳へ計上する外注実発生原価
    pub curr_assessed_tax_amount: YenAmount,
    pub accum_assessed_amount_tax_ex: YenAmount,
    pub accum_assessed_tax_amount: YenAmount,
    pub curr_retainage_deduction: YenAmount,
    pub curr_safety_assoc_deduction: YenAmount,
    pub total_deduction_amount: YenAmount,
    pub net_payment_amount: YenAmount,
    pub remaining_order_balance: YenAmount,
}

/// 労務費出面按分の入力（1作業員の現場別従事時間）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteWorkHours {
    pub branch_key: ProjectBranchKey,
    pub work_type_code: String,
    pub hours: Quantity,
}

/// 労務費出面按分の結果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AllocatedLaborCost {
    pub branch_key: ProjectBranchKey,
    pub work_type_code: String,
    pub hours: Quantity,
    pub allocated_cost: YenAmount,
}

// ============================================================================
// API DTO（フロントエンド frontend/src/bindings.ts と1対1同期）
// ============================================================================

/// 5大原価要素別の金額内訳
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CostElementBreakdown {
    pub material_cost: YenAmount,    // 10: 材料費
    pub labor_cost: YenAmount,       // 20: 労務費（出面日報）
    pub subcontract_cost: YenAmount, // 30: 外注費（出来高査定）
    pub expense_cost: YenAmount,     // 40: 現場経費
    pub equipment_cost: YenAmount,   // 50: 機械・仮設損料
    pub total_cost: YenAmount,
}

/// 工種別（12桁）の予実対比行
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTypeCostRow {
    pub work_type_code: String,
    pub work_type_name: String,
    pub budget_amount: YenAmount,
    pub ordered_amount: YenAmount,
    pub actual_cost: YenAmount,
    pub remaining_budget: YenAmount,
    pub consumption_rate_percent: Rate,
}

/// 工事原価コックピット（工事枝番別のリアルタイム原価・粗利サマリー）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCostCockpitDto {
    pub key: ProjectBranchKey,
    pub project_name: String,
    pub branch_name: String,
    pub completion_status: CompletionStatus,
    pub contract_amount_tax_ex: YenAmount,   // ① 請負契約額（税抜）
    pub latest_budget_history_no: i16,
    pub execution_budget_amount: YenAmount,  // ② 実行予算総額
    pub ordered_committed_amount: YenAmount, // ③ 発注・確定済額
    pub actual_occurred_cost: YenAmount,     // ④ 実際発生原価（最重要指標）
    pub forecast_final_cost: YenAmount,      // ⑤ 着地予想総原価
    pub forecast_gross_profit: YenAmount,    // 見込粗利額
    pub forecast_profit_rate: Rate,          // 見込粗利率（%）
    pub is_budget_exceeded: bool,            // 予算超過アラート
    pub requires_supervising_engineer_warning: bool, // 下請発注4,500万円以上かつ監理技術者未設定警告
    pub actual_breakdown: CostElementBreakdown,
    pub by_work_type: Vec<WorkTypeCostRow>,
}

/// freee型かんたん入力1: 外注出来高登録リクエスト
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasySubcontractProgressRequest {
    pub company_code: String,
    pub order_number: String,
    pub order_history_no: i16,
    pub assessment_year_month: String, // YYYYMM
    /// 進捗率（%）で指定する場合（例: 30.00%）または今回査定税抜額を直接指定する場合
    pub curr_assessed_amount_tax_ex: YenAmount,
    pub fixed_deductions: YenAmount,
    pub chargeback_offset: YenAmount,
}

/// freee型かんたん入力2: 材料費・現場経費カード登録リクエスト
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyDirectCostRequest {
    pub company_code: String,
    pub project_code: String,
    pub branch_code: String,
    pub occurred_date: NaiveDate,
    pub vendor_partner_code: Option<String>,
    pub work_type_code: String,
    pub cost_element_code: String, // "0100"(材料) or "0400"(経費)
    pub item_name: String,
    pub specification: Option<String>,
    pub quantity: Quantity,
    pub unit: String,
    pub unit_price: UnitPrice,
    pub notes: Option<String>,
}

/// freee型かんたん入力3: スマホ3タップ現場日報（出面）登録リクエスト
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyDailyReportRequest {
    pub company_code: String,
    pub work_date: NaiveDate,
    pub employee_code: String,
    pub project_code: String,
    pub branch_code: String,
    pub work_type_code: String,
    pub work_hours: Quantity, // 例: 8.000
    pub work_summary: Option<String>,
}

/// freee型かんたん入力4: 資機材出庫・損料登録リクエスト
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyEquipmentMovementRequest {
    pub company_code: String,
    pub equipment_code: String,
    pub dest_project_code: String,
    pub dest_branch_code: String,
    pub work_type_code: String,
    pub movement_date: NaiveDate,
    pub quantity: Quantity,
    pub usage_days: i32,
    pub freight_fee: YenAmount,
    pub maintenance_fee: YenAmount,
}
