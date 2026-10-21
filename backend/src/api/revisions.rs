//! 予算・発注の登録と承認（2段階ワークフロー）、工事・枝番の登録（Phase 4）
//!
//! - 状態: '0' 未承認の案 → '1' 承認 / '9' 否認。仕様書 §6.2 の '3' 申請中・'2' 確認済は将来拡張（今回は使わない）。
//! - 承認済みの版は上書きしない。改定は「最新の承認済み版（明細含む）を複写して history_no+1、状態 '0'」。
//! - 1つのキー（予算: 会社＋工事＋枝番、発注: 会社＋注文番号）につき未承認の案は同時に1つまで。
//! - 案の作成・編集・削除は registrar 以上、承認・否認は approver のみ。工事・枝番の登録は approver のみ。
//! - 集計（projects.rs）・外注出来高（actual_costs.rs）は承認済みの最新版だけを使うため、案は承認まで反映されない。
//! - 全ての問い合わせはセッションの会社（AuthContext::resolve_company）で行う。他社のキーは 404（存在しない扱い）、
//!   本文・クエリで他社の company_code を指定した場合は 403。
//! - 状態を変える処理は単一トランザクション＋関係キーの advisory lock。操作履歴は revision_events（003）に追記する。

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sirius_reborn_backend::domain::{
    calc::{self, MAX_YEN_ABS},
    types::{CompletionStatus, Quantity, Rate, UnitPrice, YenAmount},
};
use sqlx::{postgres::PgRow, PgConnection, Row};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use crate::api::{
    actual_costs::{
        ensure_decimal_fits_yen, validate_branch_code, validate_non_negative_unit_price,
        validate_non_negative_yen, validate_positive_quantity, validate_project_code,
        validate_work_type_format,
    },
    auth::{require_json_content_type, AuthContext, Role},
    ApiError, AppJson, AppState,
};

/// 003 マイグレーション（冪等）。既存DBにはアプリ起動時に適用する（api::schema）。
pub const REVISION_MIGRATION_SQL: &str = include_str!("../../../migrations/003_revision_workflow.sql");

pub const STATUS_DRAFT: &str = "0";
pub const STATUS_APPROVED: &str = "1";
pub const STATUS_REJECTED: &str = "9";

const MAX_BUDGET_LINES: usize = 500;
const MAX_LINE_NO: i32 = 99_999;
const MAX_REASON_CHARS: usize = 200;
const MAX_NOTES_CHARS: usize = 1000;
const EVENTS_LIMIT: i64 = 200;

// ===========================================================================
// 純粋関数（状態遷移・金額・ガード）— 単体試験の対象
// ===========================================================================

/// ワークフロー上の操作
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowAction {
    Edit,
    Delete,
    Approve,
    Reject,
}

/// 現在の状態に対して操作が許されるかを判定し、操作後の状態を返す（Delete は行ごと削除するため '0' を返す）。
/// 承認済み・否認済みの版は一切変更できない（409）。'2'/'3' は本システムでは扱わない（409）。
pub fn transition(current: &str, action: WorkflowAction) -> Result<&'static str, ApiError> {
    match current.trim() {
        STATUS_DRAFT => Ok(match action {
            WorkflowAction::Edit | WorkflowAction::Delete => STATUS_DRAFT,
            WorkflowAction::Approve => STATUS_APPROVED,
            WorkflowAction::Reject => STATUS_REJECTED,
        }),
        STATUS_APPROVED => Err(ApiError::Conflict(
            "承認済みの版は変更・承認・否認・削除できません。改定する場合は新しい案（履歴番号+1）を作成してください"
                .to_string(),
        )),
        STATUS_REJECTED => Err(ApiError::Conflict(
            "否認済みの版は変更・承認・削除できません。新しい案を作成してください".to_string(),
        )),
        other => Err(ApiError::Conflict(format!(
            "状態「{}」（申請中・確認済）は本システムでは扱いません",
            other
        ))),
    }
}

/// 否認理由（必須・前後空白を除いて1〜200文字・改行以外の制御文字不可）
pub fn validate_reject_reason(reason: Option<&str>) -> Result<String, ApiError> {
    let r = reason.map(str::trim).unwrap_or("");
    if r.is_empty() {
        return Err(ApiError::Unprocessable(
            "否認理由を入力してください（1〜200文字）".to_string(),
        ));
    }
    validate_free_text(r, MAX_REASON_CHARS, "否認理由").map(|s| s.unwrap_or_default())
}

/// 承認コメント（任意・200文字以内）
pub fn validate_approve_comment(comment: Option<&str>) -> Result<Option<String>, ApiError> {
    match comment.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(c) => validate_free_text(c, MAX_REASON_CHARS, "承認コメント"),
    }
}

fn validate_free_text(s: &str, max: usize, label: &str) -> Result<Option<String>, ApiError> {
    if s.chars().count() > max {
        return Err(ApiError::Unprocessable(format!("{}は{}文字以内で入力してください", label, max)));
    }
    if s.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ApiError::Unprocessable(format!("{}に制御文字は使用できません", label)));
    }
    if s.is_empty() {
        return Ok(None);
    }
    Ok(Some(s.to_string()))
}

/// 発注額ガード: 改定後の発注額（税抜）がその注文の出来高査定累計を下回ってはならない（422）
pub fn check_order_amount_not_below_assessed(new_amount_tax_ex: i64, accum_assessed_tax_ex: i64) -> Result<(), ApiError> {
    if new_amount_tax_ex < accum_assessed_tax_ex {
        return Err(ApiError::Unprocessable(format!(
            "改定後の発注額（税抜 {}円）が、この注文の出来高査定累計（{}円）を下回るため承認できません",
            new_amount_tax_ex, accum_assessed_tax_ex
        )));
    }
    Ok(())
}

/// 消費税率ガード: 出来高査定がある注文は税率を変えない（累計差額方式の前回累計税額と整合しなくなるため、422）
pub fn check_tax_rate_unchanged_after_assessment(
    approved_tax_rate: Option<Decimal>,
    new_tax_rate: Decimal,
    accum_assessed_tax_ex: i64,
) -> Result<(), ApiError> {
    if let Some(prev) = approved_tax_rate {
        if accum_assessed_tax_ex > 0 && prev != new_tax_rate {
            return Err(ApiError::Unprocessable(
                "出来高査定が登録済みの注文は消費税率を変更できません（累計差額方式の整合のため）".to_string(),
            ));
        }
    }
    Ok(())
}

/// 発注消費税額 = floor(発注額税抜 × 税率)（既存の切捨規則）
pub fn calc_order_tax_amount(order_amount_tax_ex: i64, tax_rate: Decimal) -> Result<i64, ApiError> {
    let v = Decimal::from(order_amount_tax_ex)
        .checked_mul(tax_rate)
        .ok_or_else(|| ApiError::Unprocessable("発注消費税額の計算でオーバーフローが発生しました".to_string()))?
        .floor();
    let n = v
        .to_i64()
        .ok_or_else(|| ApiError::Unprocessable("発注消費税額が整数範囲を超過しています".to_string()))?;
    if n.unsigned_abs() > MAX_YEN_ABS as u64 {
        return Err(ApiError::Unprocessable("発注消費税額が15桁上限を超過しています".to_string()));
    }
    Ok(n)
}

/// 明細金額 = calc::calc_line_amount（数量×単価、小数第1位を四捨五入）。事前に15桁へ収まることを確認する。
pub fn budget_line_amount(qty: Decimal, unit_price: Decimal) -> Result<i64, ApiError> {
    let product = qty
        .checked_mul(unit_price)
        .ok_or_else(|| ApiError::Unprocessable("数量×単価の計算でオーバーフローが発生しました".to_string()))?;
    ensure_decimal_fits_yen(product, "予算明細金額")?;
    Ok(calc::calc_line_amount(Quantity(qty), UnitPrice(unit_price)).0)
}

/// 円金額の合計（15桁上限を確認）
pub fn sum_yen<I: IntoIterator<Item = i64>>(values: I, label: &str) -> Result<i64, ApiError> {
    let mut total: i64 = 0;
    for v in values {
        total = total
            .checked_add(v)
            .filter(|t| t.unsigned_abs() <= MAX_YEN_ABS as u64)
            .ok_or_else(|| ApiError::Unprocessable(format!("{}が15桁上限を超過しています", label)))?;
    }
    Ok(total)
}

/// 明細の行番号を決める。指定済みの行番号は維持し（重複・範囲外は422）、未指定の行には
/// 「指定済みの最大」と「承認済み版の最大」のどちらよりも大きい番号を順に振る（削除した行の番号を再利用しない）。
pub fn assign_line_numbers(requested: &[Option<i32>], reserved_max: i32) -> Result<Vec<i32>, ApiError> {
    let mut used = HashSet::new();
    let mut max_used = reserved_max.max(0);
    for n in requested.iter().flatten() {
        if *n < 1 || *n > MAX_LINE_NO {
            return Err(ApiError::Unprocessable(format!("明細の行番号は1〜{}で指定してください", MAX_LINE_NO)));
        }
        if !used.insert(*n) {
            return Err(ApiError::Unprocessable(format!("明細の行番号 {} が重複しています", n)));
        }
        max_used = max_used.max(*n);
    }
    let mut next = max_used;
    let mut out = Vec::with_capacity(requested.len());
    for r in requested {
        match r {
            Some(n) => out.push(*n),
            None => {
                next += 1;
                if next > MAX_LINE_NO {
                    return Err(ApiError::Unprocessable("明細の行番号が上限を超えました".to_string()));
                }
                out.push(next);
            }
        }
    }
    Ok(out)
}

/// 自動採番: ORD-YYYY-NNN（発注日の年ごとに既存最大+1、999件/年まで）
pub fn next_auto_order_number(year: i32, current_max: Option<&str>) -> Result<String, ApiError> {
    if !(1..=9999).contains(&year) {
        return Err(ApiError::Unprocessable("発注日の年が範囲外です".to_string()));
    }
    let prefix = format!("ORD-{:04}-", year);
    let next = match current_max {
        None => 1,
        Some(s) => {
            let n: u32 = s
                .strip_prefix(&prefix)
                .and_then(|t| t.parse().ok())
                .ok_or(ApiError::Internal)?;
            n + 1
        }
    };
    if next > 999 {
        return Err(ApiError::Unprocessable(format!(
            "{}年の注文番号の自動採番が上限（999件）に達しました。注文番号を入力してください",
            year
        )));
    }
    Ok(format!("{}{:03}", prefix, next))
}

/// 利用者入力の注文番号（1〜12文字、英数字と - _ /）
pub fn validate_order_number(s: &str) -> Result<String, ApiError> {
    let t = s.trim();
    if t.is_empty()
        || t.len() > 12
        || !t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/'))
    {
        return Err(ApiError::Unprocessable(
            "注文番号は英数字と - _ / の1〜12文字で指定してください".to_string(),
        ));
    }
    Ok(t.to_string())
}

/// 新規登録する工事コード（1〜10文字、英数字と - _）
pub fn validate_new_project_code(s: &str) -> Result<String, ApiError> {
    let t = s.trim();
    if t.is_empty() || t.len() > 10 || !t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err(ApiError::Unprocessable(
            "工事コードは英数字と - _ の1〜10文字で指定してください".to_string(),
        ));
    }
    Ok(t.to_string())
}

/// 自己承認の可否（REVISION_ALLOW_SELF_APPROVAL。既定は許可＝テスト段階の方針）
pub fn check_self_approval(allow_self: bool, creator: Option<&str>, approver: &str) -> Result<(), ApiError> {
    if !allow_self && creator == Some(approver) {
        return Err(ApiError::Forbidden(
            "自分が作成した案は承認できません（別の承認権限の利用者が承認してください）".to_string(),
        ));
    }
    Ok(())
}

fn self_approval_allowed() -> bool {
    static ALLOW: OnceLock<bool> = OnceLock::new();
    *ALLOW.get_or_init(|| {
        std::env::var("REVISION_ALLOW_SELF_APPROVAL")
            .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"))
            .unwrap_or(true)
    })
}

/// 予算・発注の改定・承認ができる完成区分か（区分 2/3 は 422）
pub fn ensure_branch_open(completion_status: &str) -> Result<(), ApiError> {
    let st = CompletionStatus::from_code(completion_status).map_err(ApiError::Unprocessable)?;
    if !st.can_accept_cost() {
        return Err(ApiError::Unprocessable(format!(
            "完成区分が「{}」の工事枝番は予算・発注の登録・改定・承認ができません",
            completion_status.trim()
        )));
    }
    Ok(())
}

fn check_decimal_range(v: Decimal, min: Decimal, max: Decimal, max_scale: u32, label: &str, min_exclusive: bool) -> Result<Decimal, ApiError> {
    if v.scale() > max_scale {
        return Err(ApiError::Unprocessable(format!("{}の小数桁数は{}桁以内で指定してください", label, max_scale)));
    }
    let below = if min_exclusive { v <= min } else { v < min };
    if below || v > max {
        return Err(ApiError::Unprocessable(format!(
            "{}は{}{}〜{}の範囲で指定してください",
            label,
            min,
            if min_exclusive { "超" } else { "" },
            max
        )));
    }
    Ok(v)
}

fn required_text(s: &str, max: usize, label: &str) -> Result<String, ApiError> {
    let t = s.trim();
    if t.is_empty() || t.chars().count() > max {
        return Err(ApiError::Unprocessable(format!("{}は1〜{}文字で指定してください", label, max)));
    }
    if t.chars().any(|c| c.is_control()) {
        return Err(ApiError::Unprocessable(format!("{}に制御文字は使用できません", label)));
    }
    Ok(t.to_string())
}

fn optional_text(s: Option<&str>, max: usize, label: &str) -> Result<Option<String>, ApiError> {
    match s.map(str::trim).filter(|t| !t.is_empty()) {
        None => Ok(None),
        Some(t) => required_text(t, max, label).map(Some),
    }
}

fn one_of(value: Option<&str>, default: &str, allowed: &[&str], label: &str) -> Result<String, ApiError> {
    let v = value.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(default);
    if allowed.contains(&v) {
        Ok(v.to_string())
    } else {
        Err(ApiError::Unprocessable(format!("{}は {} のいずれかで指定してください", label, allowed.join(" / "))))
    }
}

fn parse_history_no(s: &str) -> Result<i16, ApiError> {
    s.trim()
        .parse::<i16>()
        .ok()
        .filter(|v| *v >= 0)
        .ok_or_else(|| ApiError::BadRequest("履歴番号は0以上の整数で指定してください".to_string()))
}

// ===========================================================================
// DTO
// ===========================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BudgetLineDto {
    pub line_no: i32,
    pub work_type_code: String,
    pub work_type_name: Option<String>,
    pub cost_element_code: String,
    pub cost_element_name: Option<String>,
    pub item_name: String,
    pub specification: Option<String>,
    pub unit: String,
    pub planned_quantity: Quantity,
    pub planned_unit_price: UnitPrice,
    pub planned_amount: YenAmount,
}

impl BudgetLineDto {
    /// 差分判定に使う内容（名称は表示用のため除く）
    fn same_content(&self, other: &Self) -> bool {
        self.work_type_code == other.work_type_code
            && self.cost_element_code == other.cost_element_code
            && self.item_name == other.item_name
            && self.specification == other.specification
            && self.unit == other.unit
            && self.planned_quantity == other.planned_quantity
            && self.planned_unit_price == other.planned_unit_price
            && self.planned_amount == other.planned_amount
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetVersionDto {
    pub history_no: i16,
    pub status: String,
    pub budget_created_date: NaiveDate,
    pub total_budget_amount: YenAmount,
    pub target_gross_profit_rate: Rate,
    pub notes: Option<String>,
    pub created_by: Option<String>,
    pub lines: Vec<BudgetLineDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionSummaryDto {
    pub history_no: i16,
    pub status: String,
    pub amount: YenAmount,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BudgetLineChangeDto {
    pub line_no: i32,
    pub before: BudgetLineDto,
    pub after: BudgetLineDto,
    pub amount_delta: YenAmount,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BudgetDiffDto {
    pub base_history_no: Option<i16>,
    pub draft_history_no: i16,
    pub total_before: YenAmount,
    pub total_after: YenAmount,
    pub total_delta: YenAmount,
    pub added: Vec<BudgetLineDto>,
    pub removed: Vec<BudgetLineDto>,
    pub changed: Vec<BudgetLineChangeDto>,
}

/// 承認済み版（無ければ空）と案の明細差分。行番号で突き合わせる（行番号は案の編集でも維持される）。
pub fn diff_budget_lines(
    base_history_no: Option<i16>,
    base: &[BudgetLineDto],
    draft_history_no: i16,
    draft: &[BudgetLineDto],
) -> Result<BudgetDiffDto, ApiError> {
    let total_before = sum_yen(base.iter().map(|l| l.planned_amount.0), "承認済み予算の合計")?;
    let total_after = sum_yen(draft.iter().map(|l| l.planned_amount.0), "案の予算合計")?;
    let base_map: BTreeMap<i32, &BudgetLineDto> = base.iter().map(|l| (l.line_no, l)).collect();
    let draft_map: BTreeMap<i32, &BudgetLineDto> = draft.iter().map(|l| (l.line_no, l)).collect();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for (no, d) in &draft_map {
        match base_map.get(no) {
            None => added.push((*d).clone()),
            Some(b) if !b.same_content(d) => changed.push(BudgetLineChangeDto {
                line_no: *no,
                before: (*b).clone(),
                after: (*d).clone(),
                amount_delta: YenAmount(d.planned_amount.0 - b.planned_amount.0),
            }),
            Some(_) => {}
        }
    }
    let removed = base_map
        .iter()
        .filter(|(no, _)| !draft_map.contains_key(no))
        .map(|(_, b)| (*b).clone())
        .collect();
    Ok(BudgetDiffDto {
        base_history_no,
        draft_history_no,
        total_before: YenAmount(total_before),
        total_after: YenAmount(total_after),
        total_delta: YenAmount(total_after - total_before),
        added,
        removed,
        changed,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisionEventDto {
    pub event_no: i64,
    pub occurred_at: DateTime<Utc>,
    pub actor_user_id: String,
    pub actor_role: String,
    pub target_type: String,
    pub action: String,
    pub project_code: Option<String>,
    pub branch_code: Option<String>,
    pub order_number: Option<String>,
    pub history_no: Option<i16>,
    pub reason: Option<String>,
    pub amount_before: Option<YenAmount>,
    pub amount_after: Option<YenAmount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchBudgetDto {
    pub company_code: String,
    pub project_code: String,
    pub project_name: String,
    pub branch_code: String,
    pub branch_name: String,
    pub completion_status: String,
    pub approved: Option<BudgetVersionDto>,
    pub draft: Option<BudgetVersionDto>,
    pub versions: Vec<VersionSummaryDto>,
    pub diff: Option<BudgetDiffDto>,
    pub events: Vec<RevisionEventDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderVersionDto {
    pub order_number: String,
    pub history_no: i16,
    pub status: String,
    pub project_code: String,
    pub branch_code: String,
    pub subcontractor_code: String,
    pub subcontractor_name: Option<String>,
    pub work_type_code: String,
    pub work_type_name: Option<String>,
    pub order_date: NaiveDate,
    pub work_start_date: NaiveDate,
    pub work_end_date: NaiveDate,
    pub order_type: String,
    pub is_unit_price_contract: bool,
    pub order_amount_tax_ex: YenAmount,
    pub order_tax_amount: YenAmount,
    #[serde(with = "rust_decimal::serde::str")]
    pub tax_rate: Decimal,
    pub retainage_rate_num: Rate,
    pub retainage_rate_den: Rate,
    pub safety_assoc_rate_num: Rate,
    pub safety_assoc_rate_den: Rate,
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FieldChangeDto {
    pub field: String,
    pub label: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderDiffDto {
    pub base_history_no: Option<i16>,
    pub draft_history_no: i16,
    pub amount_before: YenAmount,
    pub amount_after: YenAmount,
    pub amount_delta: YenAmount,
    pub changed_fields: Vec<FieldChangeDto>,
}

/// 承認済み版（無ければ新規）と案の項目差分
pub fn diff_order(base: Option<&OrderVersionDto>, draft: &OrderVersionDto) -> OrderDiffDto {
    let fields = |o: &OrderVersionDto| -> Vec<(&'static str, &'static str, String)> {
        vec![
            ("subcontractor_code", "外注先", o.subcontractor_code.clone()),
            ("work_type_code", "工種", o.work_type_code.clone()),
            ("order_date", "発注日", o.order_date.to_string()),
            ("work_start_date", "施工開始", o.work_start_date.to_string()),
            ("work_end_date", "施工終了", o.work_end_date.to_string()),
            ("is_unit_price_contract", "単価契約", o.is_unit_price_contract.to_string()),
            ("order_amount_tax_ex", "発注額（税抜）", o.order_amount_tax_ex.0.to_string()),
            ("order_tax_amount", "消費税額", o.order_tax_amount.0.to_string()),
            ("tax_rate", "消費税率", o.tax_rate.normalize().to_string()),
            ("retainage_rate", "保留金率", format!("{}/{}", o.retainage_rate_num.0.normalize(), o.retainage_rate_den.0.normalize())),
            ("safety_assoc_rate", "安全協力会費率", format!("{}/{}", o.safety_assoc_rate_num.0.normalize(), o.safety_assoc_rate_den.0.normalize())),
        ]
    };
    let after = fields(draft);
    let changed_fields = match base {
        None => after
            .into_iter()
            .map(|(f, l, a)| FieldChangeDto { field: f.to_string(), label: l.to_string(), before: String::new(), after: a })
            .collect(),
        Some(b) => fields(b)
            .into_iter()
            .zip(after)
            .filter(|((_, _, x), (_, _, y))| x != y)
            .map(|((f, l, x), (_, _, y))| FieldChangeDto { field: f.to_string(), label: l.to_string(), before: x, after: y })
            .collect(),
    };
    let before_amt = base.map(|b| b.order_amount_tax_ex.0).unwrap_or(0);
    OrderDiffDto {
        base_history_no: base.map(|b| b.history_no),
        draft_history_no: draft.history_no,
        amount_before: YenAmount(before_amt),
        amount_after: draft.order_amount_tax_ex,
        amount_delta: YenAmount(draft.order_amount_tax_ex.0 - before_amt),
        changed_fields,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderEntryDto {
    pub order_number: String,
    pub approved: Option<OrderVersionDto>,
    pub draft: Option<OrderVersionDto>,
    pub versions: Vec<VersionSummaryDto>,
    pub accum_assessed_amount_tax_ex: YenAmount,
    /// 承認済み最新版の発注額 − 査定累計（承認済み版が無ければ null）
    pub remaining_order_balance: Option<YenAmount>,
    pub diff: Option<OrderDiffDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchOrdersDto {
    pub company_code: String,
    pub project_code: String,
    pub branch_code: String,
    pub completion_status: String,
    pub orders: Vec<OrderEntryDto>,
    pub events: Vec<RevisionEventDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchSummaryDto {
    pub branch_code: String,
    pub branch_name: String,
    pub completion_status: String,
    pub contract_amount_tax_ex: YenAmount,
    pub approved_budget_history_no: Option<i16>,
    pub has_budget_draft: bool,
    pub order_count: i64,
    pub order_draft_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummaryDto {
    pub project_code: String,
    pub project_name: String,
    pub project_short_name: String,
    pub branches: Vec<BranchSummaryDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectListDto {
    pub company_code: String,
    pub projects: Vec<ProjectSummaryDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeNameDto {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkTypeOptionDto {
    pub code: String,
    pub name: String,
    pub hierarchy_level: i16,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevisionOptionsDto {
    pub work_types: Vec<WorkTypeOptionDto>,
    pub cost_elements: Vec<CodeNameDto>,
    pub subcontractors: Vec<CodeNameDto>,
    pub customers: Vec<CodeNameDto>,
    pub employees: Vec<CodeNameDto>,
}

/// 状態を変える操作の共通応答
#[derive(Debug, Clone, Serialize)]
pub struct RevisionMutationResponse {
    pub target_type: &'static str,
    pub action: &'static str,
    pub project_code: Option<String>,
    pub branch_code: Option<String>,
    pub order_number: Option<String>,
    pub history_no: Option<i16>,
    pub status: Option<String>,
    pub amount: Option<YenAmount>,
    pub event_no: i64,
}

// ===========================================================================
// リクエスト
// ===========================================================================

#[derive(Debug, Default, Deserialize)]
pub struct CompanyQuery {
    pub company_code: Option<String>,
}

/// 本文が実質空の操作（案の作成・DELETE）。company_code は任意（指定時は会社境界を照合）
#[derive(Debug, Default, Deserialize)]
pub struct CompanyScopedRequest {
    pub company_code: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ApproveRequest {
    pub company_code: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RejectRequest {
    pub company_code: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BudgetLineInput {
    pub line_no: Option<i32>,
    pub work_type_code: String,
    pub cost_element_code: String,
    pub item_name: String,
    pub specification: Option<String>,
    pub unit: String,
    pub planned_quantity: Quantity,
    pub planned_unit_price: UnitPrice,
    // planned_amount・合計はクライアント値を受け取らない（サーバーが計算する）
}

#[derive(Debug, Deserialize)]
pub struct BudgetDraftUpdateRequest {
    pub company_code: Option<String>,
    pub budget_created_date: Option<NaiveDate>,
    #[serde(default)]
    pub target_gross_profit_rate: Rate,
    pub notes: Option<String>,
    pub lines: Vec<BudgetLineInput>,
}

fn default_tax_rate() -> Decimal {
    Decimal::new(100, 3)
}
fn default_retainage_num() -> Rate {
    Rate(Decimal::new(1000, 2))
}
fn default_retainage_den() -> Rate {
    Rate(Decimal::new(10000, 2))
}
fn default_safety_num() -> Rate {
    Rate(Decimal::new(300, 2))
}
fn default_safety_den() -> Rate {
    Rate(Decimal::new(100000, 2))
}

#[derive(Debug, Deserialize)]
pub struct OrderFieldsInput {
    pub subcontractor_code: String,
    pub work_type_code: String,
    pub order_date: NaiveDate,
    pub work_start_date: NaiveDate,
    pub work_end_date: NaiveDate,
    #[serde(default)]
    pub is_unit_price_contract: bool,
    pub order_amount_tax_ex: YenAmount,
    #[serde(default = "default_tax_rate", with = "rust_decimal::serde::str")]
    pub tax_rate: Decimal,
    #[serde(default = "default_retainage_num")]
    pub retainage_rate_num: Rate,
    #[serde(default = "default_retainage_den")]
    pub retainage_rate_den: Rate,
    #[serde(default = "default_safety_num")]
    pub safety_assoc_rate_num: Rate,
    #[serde(default = "default_safety_den")]
    pub safety_assoc_rate_den: Rate,
}

#[derive(Debug, Deserialize)]
pub struct OrderCreateRequest {
    pub company_code: Option<String>,
    /// 省略・空なら ORD-YYYY-NNN を自動採番
    pub order_number: Option<String>,
    pub project_code: String,
    pub branch_code: String,
    #[serde(flatten)]
    pub fields: OrderFieldsInput,
}

#[derive(Debug, Deserialize)]
pub struct OrderDraftUpdateRequest {
    pub company_code: Option<String>,
    #[serde(flatten)]
    pub fields: OrderFieldsInput,
}

#[derive(Debug, Deserialize)]
pub struct BranchFieldsInput {
    pub branch_name: String,
    pub site_manager_code: String,
    pub supervising_engineer_code: Option<String>,
    pub chief_engineer_code: Option<String>,
    pub client_partner_code: String,
    pub contract_start_date: NaiveDate,
    pub contract_end_date: NaiveDate,
    pub internal_start_date: NaiveDate,
    pub internal_end_date: NaiveDate,
    pub contract_amount_tax_ex: YenAmount,
    #[serde(default)]
    pub contract_tax_amount: YenAmount,
    #[serde(default)]
    pub estimated_total_cost: YenAmount,
}

#[derive(Debug, Deserialize)]
pub struct ProjectCreateRequest {
    pub company_code: Option<String>,
    pub project_code: String,
    pub project_name: String,
    pub project_short_name: String,
    pub construction_type: Option<String>,
    pub doken_type: Option<String>,
    pub honzatsu_type: Option<String>,
    pub kanmin_type1: Option<String>,
    pub kanmin_type2: Option<String>,
    pub contract_method: Option<String>,
    /// 本工事（枝番 000）の契約・工期
    pub main_branch: BranchFieldsInput,
}

#[derive(Debug, Deserialize)]
pub struct BranchCreateRequest {
    pub company_code: Option<String>,
    pub branch_code: String,
    #[serde(flatten)]
    pub fields: BranchFieldsInput,
}

// ===========================================================================
// 入力の検証（DB を使わない部分）
// ===========================================================================

#[derive(Debug, Clone)]
pub struct ValidBudgetLine {
    pub line_no_requested: Option<i32>,
    pub work_type_code: String,
    pub cost_element_code: String,
    pub item_name: String,
    pub specification: Option<String>,
    pub unit: String,
    pub qty: Decimal,
    pub price: Decimal,
    pub amount: i64,
}

pub fn validate_budget_lines(lines: &[BudgetLineInput]) -> Result<Vec<ValidBudgetLine>, ApiError> {
    if lines.len() > MAX_BUDGET_LINES {
        return Err(ApiError::Unprocessable(format!("明細は{}行以内にしてください", MAX_BUDGET_LINES)));
    }
    let mut out = Vec::with_capacity(lines.len());
    for (i, l) in lines.iter().enumerate() {
        let n = i + 1;
        let wt = l.work_type_code.trim().to_string();
        validate_work_type_format(&wt)
            .map_err(|_| ApiError::Unprocessable(format!("{}行目: 工種コードは12桁で指定してください", n)))?;
        let ce = l.cost_element_code.trim().to_string();
        if ce.len() != 4 || !ce.chars().all(|c| c.is_ascii_digit()) {
            return Err(ApiError::Unprocessable(format!("{}行目: 費目コードは4桁の数字で指定してください", n)));
        }
        let item_name = required_text(&l.item_name, 60, &format!("{}行目: 細目名称", n))?;
        let specification = optional_text(l.specification.as_deref(), 60, &format!("{}行目: 規格・仕様", n))?;
        let unit = required_text(&l.unit, 10, &format!("{}行目: 単位", n))?;
        let qty = validate_positive_quantity(l.planned_quantity, &format!("{}行目: 予算数量", n))?;
        let price = validate_non_negative_unit_price(l.planned_unit_price, &format!("{}行目: 予算単価", n))?;
        let amount = budget_line_amount(qty, price)?;
        out.push(ValidBudgetLine {
            line_no_requested: l.line_no,
            work_type_code: wt,
            cost_element_code: ce,
            item_name,
            specification,
            unit,
            qty,
            price,
            amount,
        });
    }
    sum_yen(out.iter().map(|l| l.amount), "予算合計")?;
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct ValidOrderFields {
    pub subcontractor_code: String,
    pub work_type_code: String,
    pub order_date: NaiveDate,
    pub work_start_date: NaiveDate,
    pub work_end_date: NaiveDate,
    pub is_unit_price_contract: bool,
    pub amount: i64,
    pub tax_rate: Decimal,
    pub tax_amount: i64,
    pub retainage_num: Decimal,
    pub retainage_den: Decimal,
    pub safety_num: Decimal,
    pub safety_den: Decimal,
}

pub fn validate_order_fields(f: &OrderFieldsInput) -> Result<ValidOrderFields, ApiError> {
    let sub = f.subcontractor_code.trim().to_string();
    if sub.is_empty() || sub.len() > 8 {
        return Err(ApiError::Unprocessable("外注先コードは1〜8文字で指定してください".to_string()));
    }
    let wt = f.work_type_code.trim().to_string();
    validate_work_type_format(&wt)?;
    if f.work_start_date > f.work_end_date {
        return Err(ApiError::Unprocessable("施工期間の開始日は終了日以前にしてください".to_string()));
    }
    let amount = validate_non_negative_yen(f.order_amount_tax_ex, "発注額（税抜）")?;
    let tax_rate = check_decimal_range(f.tax_rate, Decimal::ZERO, Decimal::ONE, 3, "消費税率", false)?;
    let max_num = Decimal::new(99999, 2);
    let max_den = Decimal::new(9_999_999, 2);
    let retainage_num = check_decimal_range(f.retainage_rate_num.0, Decimal::ZERO, max_num, 2, "保留金率（分子）", false)?;
    let retainage_den = check_decimal_range(f.retainage_rate_den.0, Decimal::ZERO, max_den, 2, "保留金率（分母）", true)?;
    let safety_num = check_decimal_range(f.safety_assoc_rate_num.0, Decimal::ZERO, max_num, 2, "安全協力会費率（分子）", false)?;
    let safety_den = check_decimal_range(f.safety_assoc_rate_den.0, Decimal::ZERO, max_den, 2, "安全協力会費率（分母）", true)?;
    let tax_amount = calc_order_tax_amount(amount, tax_rate)?;
    Ok(ValidOrderFields {
        subcontractor_code: sub,
        work_type_code: wt,
        order_date: f.order_date,
        work_start_date: f.work_start_date,
        work_end_date: f.work_end_date,
        is_unit_price_contract: f.is_unit_price_contract,
        amount,
        tax_rate,
        tax_amount,
        retainage_num,
        retainage_den,
        safety_num,
        safety_den,
    })
}

#[derive(Debug, Clone)]
pub struct ValidBranchFields {
    pub branch_name: String,
    pub site_manager_code: String,
    pub supervising_engineer_code: Option<String>,
    pub chief_engineer_code: Option<String>,
    pub client_partner_code: String,
    pub contract_start_date: NaiveDate,
    pub contract_end_date: NaiveDate,
    pub internal_start_date: NaiveDate,
    pub internal_end_date: NaiveDate,
    pub contract_amount_tax_ex: i64,
    pub contract_tax_amount: i64,
    pub estimated_total_cost: i64,
}

fn partner_code(s: &str, label: &str) -> Result<String, ApiError> {
    let t = s.trim();
    if t.is_empty() || t.len() > 8 {
        return Err(ApiError::Unprocessable(format!("{}は1〜8文字のコードで指定してください", label)));
    }
    Ok(t.to_string())
}

pub fn validate_branch_fields(f: &BranchFieldsInput) -> Result<ValidBranchFields, ApiError> {
    let branch_name = required_text(&f.branch_name, 80, "枝番名称")?;
    let site_manager_code = partner_code(&f.site_manager_code, "現場代理人")?;
    let supervising_engineer_code = match f.supervising_engineer_code.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(partner_code(s, "監理技術者")?),
    };
    let chief_engineer_code = match f.chief_engineer_code.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(partner_code(s, "主任技術者")?),
    };
    let client_partner_code = partner_code(&f.client_partner_code, "発注者")?;
    if f.contract_start_date > f.contract_end_date {
        return Err(ApiError::Unprocessable("契約工期の開始日は終了日以前にしてください".to_string()));
    }
    if f.internal_start_date > f.internal_end_date {
        return Err(ApiError::Unprocessable("社内工期の開始日は終了日以前にしてください".to_string()));
    }
    Ok(ValidBranchFields {
        branch_name,
        site_manager_code,
        supervising_engineer_code,
        chief_engineer_code,
        client_partner_code,
        contract_start_date: f.contract_start_date,
        contract_end_date: f.contract_end_date,
        internal_start_date: f.internal_start_date,
        internal_end_date: f.internal_end_date,
        contract_amount_tax_ex: validate_non_negative_yen(f.contract_amount_tax_ex, "請負金額（税抜）")?,
        contract_tax_amount: validate_non_negative_yen(f.contract_tax_amount, "請負消費税額")?,
        estimated_total_cost: validate_non_negative_yen(f.estimated_total_cost, "見積総原価")?,
    })
}

// ===========================================================================
// 権限
// ===========================================================================

fn require_draft_editor(auth: &AuthContext) -> Result<(), ApiError> {
    if matches!(auth.role, Role::Registrar | Role::Approver) {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "閲覧権限の利用者は予算・発注の案を作成・編集・削除できません（登録・承認権限が必要です）".to_string(),
        ))
    }
}

fn require_approver(auth: &AuthContext, what: &str) -> Result<(), ApiError> {
    if auth.role == Role::Approver {
        Ok(())
    } else {
        Err(ApiError::Forbidden(format!("{}は承認権限の利用者のみ可能です", what)))
    }
}

// ===========================================================================
// DB ヘルパー
// ===========================================================================

async fn advisory_lock(conn: &mut PgConnection, key: &str) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(key)
        .execute(conn)
        .await?;
    Ok(())
}

fn budget_lock_key(company: &str, project: &str, branch: &str) -> String {
    format!("{}:execution_budget:{}:{}", company, project, branch)
}

/// actual_costs.rs の外注出来高登録と同じキー（承認と査定を直列化する）
fn order_lock_key(company: &str, order_number: &str) -> String {
    format!("{}:subcontract_order:{}", company, order_number)
}

#[derive(Default)]
struct NewEvent<'a> {
    target_type: &'static str,
    action: &'static str,
    project_code: Option<&'a str>,
    branch_code: Option<&'a str>,
    order_number: Option<&'a str>,
    history_no: Option<i16>,
    reason: Option<&'a str>,
    amount_before: Option<i64>,
    amount_after: Option<i64>,
}

/// 操作履歴を追記する。event_no は会社ごとに既存最大+1（排他ロック下）。呼出側のトランザクション内で実行する。
async fn record_event(conn: &mut PgConnection, auth: &AuthContext, company: &str, ev: NewEvent<'_>) -> Result<i64, ApiError> {
    advisory_lock(&mut *conn, &format!("{}:revision_events", company)).await?;
    let next: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(event_no), 0) + 1 FROM revision_events WHERE company_code = $1")
        .bind(company)
        .fetch_one(&mut *conn)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO revision_events (
            company_code, event_no, occurred_at, actor_user_id, actor_role, target_type, action,
            project_code, branch_code, order_number, history_no, reason, amount_before, amount_after
        ) VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        "#,
    )
    .bind(company)
    .bind(next)
    .bind(&auth.user_id)
    .bind(auth.role.as_str())
    .bind(ev.target_type)
    .bind(ev.action)
    .bind(ev.project_code)
    .bind(ev.branch_code)
    .bind(ev.order_number)
    .bind(ev.history_no)
    .bind(ev.reason)
    .bind(ev.amount_before.map(Decimal::from))
    .bind(ev.amount_after.map(Decimal::from))
    .execute(&mut *conn)
    .await?;
    Ok(next)
}

struct BranchInfo {
    project_name: String,
    branch_name: String,
    completion_status: String,
}

async fn fetch_branch(conn: &mut PgConnection, company: &str, project: &str, branch: &str) -> Result<BranchInfo, ApiError> {
    let row = sqlx::query(
        r#"
        SELECT pm.project_name, pb.branch_name, pb.completion_status
        FROM project_branches pb
        JOIN project_masters pm ON pm.company_code = pb.company_code AND pm.project_code = pb.project_code
        WHERE pb.company_code = $1 AND pb.project_code = $2 AND pb.branch_code = $3
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| ApiError::NotFound(format!("対象の工事枝番が存在しません: {}-{}", project, branch)))?;
    Ok(BranchInfo {
        project_name: row.try_get("project_name")?,
        branch_name: row.try_get("branch_name")?,
        completion_status: row.try_get::<String, _>("completion_status")?.trim().to_string(),
    })
}

#[derive(Debug, Clone)]
struct VersionRow {
    history_no: i16,
    status: String,
    amount: i64,
}

fn latest_with_status(v: &[VersionRow], status: &str) -> Option<VersionRow> {
    v.iter().filter(|r| r.status == status).max_by_key(|r| r.history_no).cloned()
}

fn next_history_no(v: &[VersionRow]) -> Result<i16, ApiError> {
    match v.iter().map(|r| r.history_no).max() {
        None => Ok(0),
        Some(m) => m
            .checked_add(1)
            .ok_or_else(|| ApiError::Unprocessable("履歴番号が上限に達しました".to_string())),
    }
}

async fn budget_versions(conn: &mut PgConnection, company: &str, project: &str, branch: &str) -> Result<Vec<VersionRow>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT budget_history_no, approval_status, CAST(total_budget_amount AS BIGINT) AS amount
        FROM execution_budgets
        WHERE company_code = $1 AND project_code = $2 AND branch_code = $3
        ORDER BY budget_history_no
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(VersionRow {
                history_no: r.try_get("budget_history_no")?,
                status: r.try_get::<String, _>("approval_status")?.trim().to_string(),
                amount: r.try_get("amount")?,
            })
        })
        .collect()
}

async fn order_versions(conn: &mut PgConnection, company: &str, order_number: &str) -> Result<Vec<VersionRow>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT order_history_no, order_status, CAST(order_amount_tax_ex AS BIGINT) AS amount
        FROM subcontract_orders
        WHERE company_code = $1 AND order_number = $2
        ORDER BY order_history_no
        "#,
    )
    .bind(company)
    .bind(order_number)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(VersionRow {
                history_no: r.try_get("order_history_no")?,
                status: r.try_get::<String, _>("order_status")?.trim().to_string(),
                amount: r.try_get("amount")?,
            })
        })
        .collect()
}

async fn budget_lines(conn: &mut PgConnection, company: &str, project: &str, branch: &str, history_no: i16) -> Result<Vec<BudgetLineDto>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT d.line_no, d.work_type_code, wt.work_type_name, d.cost_element_code, ce.cost_element_name,
               d.item_name, d.specification, d.unit, d.planned_quantity, d.planned_unit_price,
               CAST(d.planned_amount AS BIGINT) AS planned_amount
        FROM execution_budget_details d
        LEFT JOIN work_types wt ON wt.company_code = d.company_code AND wt.work_type_code = d.work_type_code
        LEFT JOIN cost_elements ce ON ce.company_code = d.company_code AND ce.cost_element_code = d.cost_element_code
        WHERE d.company_code = $1 AND d.project_code = $2 AND d.branch_code = $3 AND d.budget_history_no = $4
        ORDER BY d.line_no
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .bind(history_no)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(BudgetLineDto {
                line_no: r.try_get("line_no")?,
                work_type_code: r.try_get("work_type_code")?,
                work_type_name: r.try_get("work_type_name")?,
                cost_element_code: r.try_get::<String, _>("cost_element_code")?.trim().to_string(),
                cost_element_name: r.try_get("cost_element_name")?,
                item_name: r.try_get("item_name")?,
                specification: r.try_get("specification")?,
                unit: r.try_get("unit")?,
                planned_quantity: Quantity(r.try_get("planned_quantity")?),
                planned_unit_price: UnitPrice(r.try_get("planned_unit_price")?),
                planned_amount: YenAmount(r.try_get("planned_amount")?),
            })
        })
        .collect()
}

/// 案を作成した利用者（操作履歴の最新の create）。自己承認の判定と画面表示に使う。
enum DraftKey<'a> {
    Budget { project: &'a str, branch: &'a str },
    Order { order_number: &'a str },
}

async fn creator_of(conn: &mut PgConnection, company: &str, key: DraftKey<'_>, history_no: i16) -> Result<Option<String>, ApiError> {
    let q = match key {
        DraftKey::Budget { project, branch } => sqlx::query_scalar(
            "SELECT actor_user_id FROM revision_events WHERE company_code = $1 AND target_type = 'budget' AND action = 'create' AND history_no = $2 AND project_code = $3 AND branch_code = $4 ORDER BY event_no DESC LIMIT 1",
        )
        .bind(company)
        .bind(history_no)
        .bind(project)
        .bind(branch),
        DraftKey::Order { order_number } => sqlx::query_scalar(
            "SELECT actor_user_id FROM revision_events WHERE company_code = $1 AND target_type = 'order' AND action = 'create' AND history_no = $2 AND order_number = $3 ORDER BY event_no DESC LIMIT 1",
        )
        .bind(company)
        .bind(history_no)
        .bind(order_number),
    };
    Ok(q.fetch_optional(&mut *conn).await?)
}

async fn branch_events(conn: &mut PgConnection, company: &str, project: &str, branch: &str) -> Result<Vec<RevisionEventDto>, ApiError> {
    let rows = sqlx::query(
        r#"
        SELECT event_no, occurred_at, actor_user_id, actor_role, target_type, action,
               project_code, branch_code, order_number, history_no, reason,
               CAST(amount_before AS BIGINT) AS amount_before, CAST(amount_after AS BIGINT) AS amount_after
        FROM revision_events
        WHERE company_code = $1 AND project_code = $2 AND branch_code = $3
        ORDER BY event_no DESC
        LIMIT $4
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .bind(EVENTS_LIMIT)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(RevisionEventDto {
                event_no: r.try_get("event_no")?,
                occurred_at: r.try_get("occurred_at")?,
                actor_user_id: r.try_get("actor_user_id")?,
                actor_role: r.try_get("actor_role")?,
                target_type: r.try_get("target_type")?,
                action: r.try_get("action")?,
                project_code: r.try_get("project_code")?,
                branch_code: r.try_get::<Option<String>, _>("branch_code")?.map(|s| s.trim().to_string()),
                order_number: r.try_get("order_number")?,
                history_no: r.try_get("history_no")?,
                reason: r.try_get("reason")?,
                amount_before: r.try_get::<Option<i64>, _>("amount_before")?.map(YenAmount),
                amount_after: r.try_get::<Option<i64>, _>("amount_after")?.map(YenAmount),
            })
        })
        .collect()
}

/// 自社マスタに存在しない工種・費目があれば 422
async fn verify_masters_exist(conn: &mut PgConnection, company: &str, work_types: &[String], cost_elements: &[String]) -> Result<(), ApiError> {
    let wt_unique: Vec<String> = work_types.iter().cloned().collect::<HashSet<_>>().into_iter().collect();
    if !wt_unique.is_empty() {
        let found: Vec<String> = sqlx::query_scalar("SELECT work_type_code FROM work_types WHERE company_code = $1 AND work_type_code = ANY($2)")
            .bind(company)
            .bind(&wt_unique)
            .fetch_all(&mut *conn)
            .await?;
        let found: HashSet<String> = found.into_iter().collect();
        if let Some(missing) = wt_unique.iter().find(|c| !found.contains(*c)) {
            return Err(ApiError::Unprocessable(format!("工種コード {} は自社の工種マスタにありません", missing)));
        }
    }
    let ce_unique: Vec<String> = cost_elements.iter().cloned().collect::<HashSet<_>>().into_iter().collect();
    if !ce_unique.is_empty() {
        let found: Vec<String> = sqlx::query_scalar("SELECT TRIM(cost_element_code) FROM cost_elements WHERE company_code = $1 AND cost_element_code = ANY($2)")
            .bind(company)
            .bind(&ce_unique)
            .fetch_all(&mut *conn)
            .await?;
        let found: HashSet<String> = found.into_iter().collect();
        if let Some(missing) = ce_unique.iter().find(|c| !found.contains(*c)) {
            return Err(ApiError::Unprocessable(format!("費目コード {} は自社の費目マスタにありません", missing)));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum PartnerRole {
    Customer,
    Subcontractor,
    Employee,
}

/// 取引先が存在し、削除されておらず、指定の役割フラグを持つこと（違えば 422）
async fn require_partner_role(conn: &mut PgConnection, company: &str, code: &str, role: PartnerRole, label: &str) -> Result<(), ApiError> {
    let row = sqlx::query(
        "SELECT is_customer, is_subcontractor, is_employee, is_deleted FROM business_partners WHERE company_code = $1 AND partner_code = $2",
    )
    .bind(company)
    .bind(code)
    .fetch_optional(&mut *conn)
    .await?;
    let ok = match row {
        None => false,
        Some(r) => {
            let deleted: bool = r.try_get("is_deleted")?;
            let flag: bool = match role {
                PartnerRole::Customer => r.try_get("is_customer")?,
                PartnerRole::Subcontractor => r.try_get("is_subcontractor")?,
                PartnerRole::Employee => r.try_get("is_employee")?,
            };
            flag && !deleted
        }
    };
    if ok {
        Ok(())
    } else {
        let kind = match role {
            PartnerRole::Customer => "発注者（得意先）",
            PartnerRole::Subcontractor => "外注先",
            PartnerRole::Employee => "社員",
        };
        Err(ApiError::Unprocessable(format!("{}（{}）は有効な{}ではありません", label, code, kind)))
    }
}

async fn require_work_type(conn: &mut PgConnection, company: &str, code: &str) -> Result<(), ApiError> {
    verify_masters_exist(conn, company, &[code.to_string()], &[]).await
}

async fn accum_assessed(conn: &mut PgConnection, company: &str, order_number: &str) -> Result<i64, ApiError> {
    Ok(sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(curr_assessed_amount_tax_ex), 0) AS BIGINT) FROM progress_assessments WHERE company_code = $1 AND order_number = $2",
    )
    .bind(company)
    .bind(order_number)
    .fetch_one(&mut *conn)
    .await?)
}

const ORDER_SELECT: &str = r#"
    SELECT o.order_number, o.order_history_no, o.order_status, o.project_code, o.branch_code,
           o.subcontractor_code, bp.partner_name AS subcontractor_name,
           o.work_type_code, wt.work_type_name,
           o.order_date, o.work_start_date, o.work_end_date, o.order_type, o.is_unit_price_contract,
           CAST(o.order_amount_tax_ex AS BIGINT) AS order_amount_tax_ex,
           CAST(o.order_tax_amount AS BIGINT) AS order_tax_amount,
           o.tax_rate, o.retainage_rate_num, o.retainage_rate_den, o.safety_assoc_rate_num, o.safety_assoc_rate_den
    FROM subcontract_orders o
    LEFT JOIN business_partners bp ON bp.company_code = o.company_code AND bp.partner_code = o.subcontractor_code
    LEFT JOIN work_types wt ON wt.company_code = o.company_code AND wt.work_type_code = o.work_type_code
"#;

fn order_from_row(r: &PgRow) -> Result<OrderVersionDto, ApiError> {
    Ok(OrderVersionDto {
        order_number: r.try_get("order_number")?,
        history_no: r.try_get("order_history_no")?,
        status: r.try_get::<String, _>("order_status")?.trim().to_string(),
        project_code: r.try_get("project_code")?,
        branch_code: r.try_get::<String, _>("branch_code")?.trim().to_string(),
        subcontractor_code: r.try_get("subcontractor_code")?,
        subcontractor_name: r.try_get("subcontractor_name")?,
        work_type_code: r.try_get("work_type_code")?,
        work_type_name: r.try_get("work_type_name")?,
        order_date: r.try_get("order_date")?,
        work_start_date: r.try_get("work_start_date")?,
        work_end_date: r.try_get("work_end_date")?,
        order_type: r.try_get::<String, _>("order_type")?.trim().to_string(),
        is_unit_price_contract: r.try_get("is_unit_price_contract")?,
        order_amount_tax_ex: YenAmount(r.try_get("order_amount_tax_ex")?),
        order_tax_amount: YenAmount(r.try_get("order_tax_amount")?),
        tax_rate: r.try_get("tax_rate")?,
        retainage_rate_num: Rate(r.try_get("retainage_rate_num")?),
        retainage_rate_den: Rate(r.try_get("retainage_rate_den")?),
        safety_assoc_rate_num: Rate(r.try_get("safety_assoc_rate_num")?),
        safety_assoc_rate_den: Rate(r.try_get("safety_assoc_rate_den")?),
        created_by: None,
    })
}

async fn fetch_order_version(conn: &mut PgConnection, company: &str, order_number: &str, history_no: i16) -> Result<Option<OrderVersionDto>, ApiError> {
    let sql = format!("{} WHERE o.company_code = $1 AND o.order_number = $2 AND o.order_history_no = $3", ORDER_SELECT);
    let row = sqlx::query(&sql)
        .bind(company)
        .bind(order_number)
        .bind(history_no)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(order_from_row).transpose()
}

/// 読み取り用の一貫したスナップショット（REPEATABLE READ・読み取り専用）
async fn begin_read(state: &AppState) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// DELETE の本文: Content-Type: application/json は必須（CSRF 方針）。本文は空でもよく、
/// 空でなければ JSON オブジェクト（company_code は任意）として解釈する。
fn parse_delete_body(headers: &HeaderMap, body: &Bytes) -> Result<CompanyScopedRequest, ApiError> {
    require_json_content_type(headers)?;
    if body.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(CompanyScopedRequest::default());
    }
    serde_json::from_slice::<CompanyScopedRequest>(body)
        .map_err(|e| ApiError::BadRequest(format!("JSONリクエストの形式が不正です: {}", e)))
}

fn check_path_codes(project: &str, branch: &str) -> Result<(), ApiError> {
    validate_project_code(project)?;
    validate_branch_code(branch)
}

// ===========================================================================
// 取得 API
// ===========================================================================

/// GET /api/v1/projects — 工事と枝番の一覧（予算・発注の状態付き）
pub async fn list_projects(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<CompanyQuery>,
) -> Result<Json<ProjectListDto>, ApiError> {
    let company = auth.resolve_company(q.company_code.as_deref())?;
    let mut tx = begin_read(&state).await?;
    let rows = sqlx::query(
        r#"
        SELECT pm.project_code, pm.project_name, pm.project_short_name,
               pb.branch_code, pb.branch_name, pb.completion_status,
               CAST(pb.current_contract_amount_tax_ex AS BIGINT) AS contract_amount_tax_ex,
               (SELECT MAX(eb.budget_history_no) FROM execution_budgets eb
                 WHERE eb.company_code = pb.company_code AND eb.project_code = pb.project_code
                   AND eb.branch_code = pb.branch_code AND eb.approval_status = '1') AS approved_budget_history_no,
               EXISTS (SELECT 1 FROM execution_budgets eb
                 WHERE eb.company_code = pb.company_code AND eb.project_code = pb.project_code
                   AND eb.branch_code = pb.branch_code AND eb.approval_status = '0') AS has_budget_draft,
               (SELECT COUNT(DISTINCT so.order_number) FROM subcontract_orders so
                 WHERE so.company_code = pb.company_code AND so.project_code = pb.project_code
                   AND so.branch_code = pb.branch_code) AS order_count,
               (SELECT COUNT(*) FROM subcontract_orders so
                 WHERE so.company_code = pb.company_code AND so.project_code = pb.project_code
                   AND so.branch_code = pb.branch_code AND so.order_status = '0') AS order_draft_count
        FROM project_masters pm
        LEFT JOIN project_branches pb ON pb.company_code = pm.company_code AND pb.project_code = pm.project_code
        WHERE pm.company_code = $1
        ORDER BY pm.project_code, pb.branch_code
        "#,
    )
    .bind(&company)
    .fetch_all(&mut *tx)
    .await?;
    let mut projects: Vec<ProjectSummaryDto> = Vec::new();
    for r in rows {
        let code: String = r.try_get("project_code")?;
        if projects.last().map(|p| p.project_code != code).unwrap_or(true) {
            projects.push(ProjectSummaryDto {
                project_code: code.clone(),
                project_name: r.try_get("project_name")?,
                project_short_name: r.try_get("project_short_name")?,
                branches: Vec::new(),
            });
        }
        let branch_code: Option<String> = r.try_get("branch_code")?;
        if let (Some(branch_code), Some(p)) = (branch_code, projects.last_mut()) {
            p.branches.push(BranchSummaryDto {
                branch_code: branch_code.trim().to_string(),
                branch_name: r.try_get("branch_name")?,
                completion_status: r.try_get::<String, _>("completion_status")?.trim().to_string(),
                contract_amount_tax_ex: YenAmount(r.try_get("contract_amount_tax_ex")?),
                approved_budget_history_no: r.try_get("approved_budget_history_no")?,
                has_budget_draft: r.try_get("has_budget_draft")?,
                order_count: r.try_get("order_count")?,
                order_draft_count: r.try_get("order_draft_count")?,
            });
        }
    }
    tx.commit().await?;
    Ok(Json(ProjectListDto { company_code: company, projects }))
}

/// GET /api/v1/revision-options — 入力フォーム用の自社マスタ（工種・費目・外注先・発注者・社員）
pub async fn get_revision_options(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<CompanyQuery>,
) -> Result<Json<RevisionOptionsDto>, ApiError> {
    let company = auth.resolve_company(q.company_code.as_deref())?;
    let mut tx = begin_read(&state).await?;
    let wt_rows = sqlx::query(
        "SELECT work_type_code, work_type_name, hierarchy_level FROM work_types WHERE company_code = $1 ORDER BY work_type_code",
    )
    .bind(&company)
    .fetch_all(&mut *tx)
    .await?;
    let mut work_types = Vec::with_capacity(wt_rows.len());
    for r in wt_rows {
        work_types.push(WorkTypeOptionDto {
            code: r.try_get("work_type_code")?,
            name: r.try_get("work_type_name")?,
            hierarchy_level: r.try_get("hierarchy_level")?,
        });
    }
    let ce_rows = sqlx::query("SELECT cost_element_code, cost_element_name FROM cost_elements WHERE company_code = $1 ORDER BY cost_element_code")
        .bind(&company)
        .fetch_all(&mut *tx)
        .await?;
    let mut cost_elements = Vec::with_capacity(ce_rows.len());
    for r in ce_rows {
        cost_elements.push(CodeNameDto {
            code: r.try_get::<String, _>("cost_element_code")?.trim().to_string(),
            name: r.try_get("cost_element_name")?,
        });
    }
    let mut lists: Vec<Vec<CodeNameDto>> = Vec::new();
    // 列名は固定の3つだけ（利用者入力を SQL に埋め込まない）
    for flag in ["is_subcontractor", "is_customer", "is_employee"] {
        let sql = format!(
            "SELECT partner_code, partner_name FROM business_partners WHERE company_code = $1 AND {} = TRUE AND is_deleted = FALSE ORDER BY partner_code",
            flag
        );
        let rows = sqlx::query(&sql).bind(&company).fetch_all(&mut *tx).await?;
        let mut v = Vec::with_capacity(rows.len());
        for r in rows {
            v.push(CodeNameDto { code: r.try_get("partner_code")?, name: r.try_get("partner_name")? });
        }
        lists.push(v);
    }
    tx.commit().await?;
    let employees = lists.pop().unwrap_or_default();
    let customers = lists.pop().unwrap_or_default();
    let subcontractors = lists.pop().unwrap_or_default();
    Ok(Json(RevisionOptionsDto { work_types, cost_elements, subcontractors, customers, employees }))
}

async fn load_branch_budget(conn: &mut PgConnection, company: &str, project: &str, branch: &str) -> Result<BranchBudgetDto, ApiError> {
    let info = fetch_branch(&mut *conn, company, project, branch).await?;
    let header_rows = sqlx::query(
        r#"
        SELECT budget_history_no, approval_status, budget_created_date,
               CAST(total_budget_amount AS BIGINT) AS total_budget_amount, target_gross_profit_rate, notes
        FROM execution_budgets
        WHERE company_code = $1 AND project_code = $2 AND branch_code = $3
        ORDER BY budget_history_no
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .fetch_all(&mut *conn)
    .await?;
    let mut headers: Vec<BudgetVersionDto> = Vec::with_capacity(header_rows.len());
    for r in &header_rows {
        headers.push(BudgetVersionDto {
            history_no: r.try_get("budget_history_no")?,
            status: r.try_get::<String, _>("approval_status")?.trim().to_string(),
            budget_created_date: r.try_get("budget_created_date")?,
            total_budget_amount: YenAmount(r.try_get("total_budget_amount")?),
            target_gross_profit_rate: Rate(r.try_get("target_gross_profit_rate")?),
            notes: r.try_get("notes")?,
            created_by: None,
            lines: Vec::new(),
        });
    }
    let versions = headers
        .iter()
        .map(|h| VersionSummaryDto { history_no: h.history_no, status: h.status.clone(), amount: h.total_budget_amount })
        .collect();
    let pick = |status: &str| headers.iter().filter(|h| h.status == status).max_by_key(|h| h.history_no).cloned();
    let mut approved = pick(STATUS_APPROVED);
    let mut draft = pick(STATUS_DRAFT);
    for v in [approved.as_mut(), draft.as_mut()].into_iter().flatten() {
        v.lines = budget_lines(&mut *conn, company, project, branch, v.history_no).await?;
        v.created_by = creator_of(&mut *conn, company, DraftKey::Budget { project, branch }, v.history_no).await?;
    }
    let diff = match &draft {
        None => None,
        Some(d) => Some(diff_budget_lines(
            approved.as_ref().map(|a| a.history_no),
            approved.as_ref().map(|a| a.lines.as_slice()).unwrap_or(&[]),
            d.history_no,
            &d.lines,
        )?),
    };
    let events = branch_events(&mut *conn, company, project, branch).await?;
    Ok(BranchBudgetDto {
        company_code: company.to_string(),
        project_code: project.to_string(),
        project_name: info.project_name,
        branch_code: branch.to_string(),
        branch_name: info.branch_name,
        completion_status: info.completion_status,
        approved,
        draft,
        versions,
        diff,
        events,
    })
}

/// GET /api/v1/projects/:project_code/branches/:branch_code/budget
pub async fn get_branch_budget(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch)): Path<(String, String)>,
    Query(q): Query<CompanyQuery>,
) -> Result<Json<BranchBudgetDto>, ApiError> {
    let company = auth.resolve_company(q.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let mut tx = begin_read(&state).await?;
    let dto = load_branch_budget(&mut tx, &company, &project, &branch).await?;
    tx.commit().await?;
    Ok(Json(dto))
}

/// GET /api/v1/projects/:project_code/branches/:branch_code/orders
pub async fn get_branch_orders(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch)): Path<(String, String)>,
    Query(q): Query<CompanyQuery>,
) -> Result<Json<BranchOrdersDto>, ApiError> {
    let company = auth.resolve_company(q.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let mut tx = begin_read(&state).await?;
    let info = fetch_branch(&mut tx, &company, &project, &branch).await?;
    let sql = format!(
        "{} WHERE o.company_code = $1 AND o.project_code = $2 AND o.branch_code = $3 ORDER BY o.order_number, o.order_history_no",
        ORDER_SELECT
    );
    let rows = sqlx::query(&sql)
        .bind(&company)
        .bind(&project)
        .bind(&branch)
        .fetch_all(&mut *tx)
        .await?;
    let mut grouped: BTreeMap<String, Vec<OrderVersionDto>> = BTreeMap::new();
    for r in &rows {
        let o = order_from_row(r)?;
        grouped.entry(o.order_number.clone()).or_default().push(o);
    }
    let numbers: Vec<String> = grouped.keys().cloned().collect();
    let accum_rows = sqlx::query(
        r#"
        SELECT order_number, CAST(COALESCE(SUM(curr_assessed_amount_tax_ex), 0) AS BIGINT) AS accum
        FROM progress_assessments
        WHERE company_code = $1 AND order_number = ANY($2)
        GROUP BY order_number
        "#,
    )
    .bind(&company)
    .bind(&numbers)
    .fetch_all(&mut *tx)
    .await?;
    let mut accum: HashMap<String, i64> = HashMap::new();
    for r in accum_rows {
        accum.insert(r.try_get("order_number")?, r.try_get("accum")?);
    }
    let mut orders = Vec::with_capacity(grouped.len());
    for (number, versions) in grouped {
        let summary = versions
            .iter()
            .map(|v| VersionSummaryDto { history_no: v.history_no, status: v.status.clone(), amount: v.order_amount_tax_ex })
            .collect();
        let pick = |status: &str| versions.iter().filter(|v| v.status == status).max_by_key(|v| v.history_no).cloned();
        let mut approved = pick(STATUS_APPROVED);
        let mut draft = pick(STATUS_DRAFT);
        for v in [approved.as_mut(), draft.as_mut()].into_iter().flatten() {
            v.created_by = creator_of(&mut tx, &company, DraftKey::Order { order_number: &number }, v.history_no).await?;
        }
        let acc = accum.get(&number).copied().unwrap_or(0);
        let remaining = approved.as_ref().map(|a| YenAmount(a.order_amount_tax_ex.0 - acc));
        let diff = draft.as_ref().map(|d| diff_order(approved.as_ref(), d));
        orders.push(OrderEntryDto {
            order_number: number,
            approved,
            draft,
            versions: summary,
            accum_assessed_amount_tax_ex: YenAmount(acc),
            remaining_order_balance: remaining,
            diff,
        });
    }
    let events = branch_events(&mut tx, &company, &project, &branch).await?;
    tx.commit().await?;
    Ok(Json(BranchOrdersDto {
        company_code: company,
        project_code: project,
        branch_code: branch,
        completion_status: info.completion_status,
        orders,
        events,
    }))
}

// ===========================================================================
// 実行予算: 案の作成・編集・削除・承認・否認
// ===========================================================================

/// POST /api/v1/projects/:project_code/branches/:branch_code/budget/drafts
/// 最新の承認済み版（明細含む）を複写して history_no+1・状態'0'の案を作る。版が無い枝番は history_no=0 の空の案。
pub async fn create_budget_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch)): Path<(String, String)>,
    AppJson(req): AppJson<CompanyScopedRequest>,
) -> Result<(StatusCode, Json<RevisionMutationResponse>), ApiError> {
    require_draft_editor(&auth)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &budget_lock_key(&company, &project, &branch)).await?;
    let info = fetch_branch(&mut tx, &company, &project, &branch).await?;
    ensure_branch_open(&info.completion_status)?;
    let versions = budget_versions(&mut tx, &company, &project, &branch).await?;
    if let Some(d) = latest_with_status(&versions, STATUS_DRAFT) {
        return Err(ApiError::Conflict(format!(
            "この枝番には未承認の予算案（履歴番号 {}）が既にあります。案は同時に1つまでです",
            d.history_no
        )));
    }
    let new_h = next_history_no(&versions)?;
    let approved = latest_with_status(&versions, STATUS_APPROVED);
    // 複写元: 最新の承認済み版。承認済みが無く否認済みの版だけがある場合はその最新版を複写する。
    let source = approved.clone().or_else(|| versions.iter().max_by_key(|v| v.history_no).cloned());
    match &source {
        Some(src) => {
            sqlx::query(
                r#"
                INSERT INTO execution_budgets (company_code, project_code, branch_code, budget_history_no, budget_created_date,
                    total_budget_amount, target_gross_profit_rate, approval_status, notes)
                SELECT company_code, project_code, branch_code, $5, CURRENT_DATE, total_budget_amount, target_gross_profit_rate, '0', notes
                FROM execution_budgets
                WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4
                "#,
            )
            .bind(&company)
            .bind(&project)
            .bind(&branch)
            .bind(src.history_no)
            .bind(new_h)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO execution_budget_details (company_code, project_code, branch_code, budget_history_no, line_no,
                    work_type_code, cost_element_code, item_name, specification, unit,
                    planned_quantity, planned_unit_price, planned_amount)
                SELECT company_code, project_code, branch_code, $5, line_no,
                    work_type_code, cost_element_code, item_name, specification, unit,
                    planned_quantity, planned_unit_price, planned_amount
                FROM execution_budget_details
                WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4
                "#,
            )
            .bind(&company)
            .bind(&project)
            .bind(&branch)
            .bind(src.history_no)
            .bind(new_h)
            .execute(&mut *tx)
            .await?;
        }
        None => {
            sqlx::query(
                r#"
                INSERT INTO execution_budgets (company_code, project_code, branch_code, budget_history_no, budget_created_date,
                    total_budget_amount, target_gross_profit_rate, approval_status, notes)
                VALUES ($1, $2, $3, $4, CURRENT_DATE, 0, 0.00, '0', NULL)
                "#,
            )
            .bind(&company)
            .bind(&project)
            .bind(&branch)
            .bind(new_h)
            .execute(&mut *tx)
            .await?;
        }
    }
    // 案の合計は明細から求め直す（複写元ヘッダの値をそのまま信用しない）
    let total: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(planned_amount), 0) AS BIGINT) FROM execution_budget_details WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4",
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .bind(new_h)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE execution_budgets SET total_budget_amount = $5 WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 AND approval_status = '0'",
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .bind(new_h)
    .bind(Decimal::from(total))
    .execute(&mut *tx)
    .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "budget",
            action: "create",
            project_code: Some(&project),
            branch_code: Some(&branch),
            history_no: Some(new_h),
            amount_before: approved.as_ref().map(|a| a.amount),
            amount_after: Some(total),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(RevisionMutationResponse {
            target_type: "budget",
            action: "create",
            project_code: Some(project),
            branch_code: Some(branch),
            order_number: None,
            history_no: Some(new_h),
            status: Some(STATUS_DRAFT.to_string()),
            amount: Some(YenAmount(total)),
            event_no,
        }),
    ))
}

/// 対象の版を FOR UPDATE で取得し、操作が許されるか判定する（無ければ 404）
async fn lock_budget_version(
    conn: &mut PgConnection,
    company: &str,
    project: &str,
    branch: &str,
    history_no: i16,
    action: WorkflowAction,
) -> Result<(String, i64), ApiError> {
    let row = sqlx::query(
        r#"
        SELECT approval_status, CAST(total_budget_amount AS BIGINT) AS amount
        FROM execution_budgets
        WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4
        FOR UPDATE
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .bind(history_no)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| ApiError::NotFound(format!("予算の版（履歴番号 {}）が存在しません", history_no)))?;
    let status: String = row.try_get::<String, _>("approval_status")?.trim().to_string();
    let next = transition(&status, action)?;
    Ok((next.to_string(), row.try_get("amount")?))
}

/// PUT /api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no
/// ヘッダ項目と明細（追加・変更・削除）を本文の内容で置き換える。明細金額・合計はサーバーが計算する。
pub async fn update_budget_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch, h)): Path<(String, String, String)>,
    AppJson(req): AppJson<BudgetDraftUpdateRequest>,
) -> Result<Json<RevisionMutationResponse>, ApiError> {
    require_draft_editor(&auth)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let history_no = parse_history_no(&h)?;
    let rate = check_decimal_range(req.target_gross_profit_rate.0, Decimal::from(-100), Decimal::from(100), 2, "目標粗利率", false)?;
    let notes = match req.notes.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(n) => validate_free_text(n, MAX_NOTES_CHARS, "予算注記")?,
    };
    let lines = validate_budget_lines(&req.lines)?;

    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &budget_lock_key(&company, &project, &branch)).await?;
    let info = fetch_branch(&mut tx, &company, &project, &branch).await?;
    let (_, before_total) = lock_budget_version(&mut tx, &company, &project, &branch, history_no, WorkflowAction::Edit).await?;
    ensure_branch_open(&info.completion_status)?;
    verify_masters_exist(
        &mut tx,
        &company,
        &lines.iter().map(|l| l.work_type_code.clone()).collect::<Vec<_>>(),
        &lines.iter().map(|l| l.cost_element_code.clone()).collect::<Vec<_>>(),
    )
    .await?;
    // 行番号: 指定は維持、未指定は承認済み版の最大行番号より後ろに振る
    let reserved_max: i32 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(d.line_no), 0) FROM execution_budget_details d
        WHERE d.company_code = $1 AND d.project_code = $2 AND d.branch_code = $3
          AND d.budget_history_no = (SELECT MAX(budget_history_no) FROM execution_budgets
                                      WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND approval_status = '1')
        "#,
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .fetch_one(&mut *tx)
    .await?;
    let numbers = assign_line_numbers(&lines.iter().map(|l| l.line_no_requested).collect::<Vec<_>>(), reserved_max)?;
    let total = sum_yen(lines.iter().map(|l| l.amount), "予算合計")?;

    sqlx::query("DELETE FROM execution_budget_details WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4")
        .bind(&company)
        .bind(&project)
        .bind(&branch)
        .bind(history_no)
        .execute(&mut *tx)
        .await?;
    for (l, no) in lines.iter().zip(numbers) {
        sqlx::query(
            r#"
            INSERT INTO execution_budget_details (company_code, project_code, branch_code, budget_history_no, line_no,
                work_type_code, cost_element_code, item_name, specification, unit,
                planned_quantity, planned_unit_price, planned_amount)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            "#,
        )
        .bind(&company)
        .bind(&project)
        .bind(&branch)
        .bind(history_no)
        .bind(no)
        .bind(&l.work_type_code)
        .bind(&l.cost_element_code)
        .bind(&l.item_name)
        .bind(&l.specification)
        .bind(&l.unit)
        .bind(l.qty)
        .bind(l.price)
        .bind(Decimal::from(l.amount))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        r#"
        UPDATE execution_budgets
           SET total_budget_amount = $5, target_gross_profit_rate = $6, notes = $7,
               budget_created_date = COALESCE($8, budget_created_date)
         WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 AND approval_status = '0'
        "#,
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .bind(history_no)
    .bind(Decimal::from(total))
    .bind(rate)
    .bind(&notes)
    .bind(req.budget_created_date)
    .execute(&mut *tx)
    .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "budget",
            action: "update",
            project_code: Some(&project),
            branch_code: Some(&branch),
            history_no: Some(history_no),
            amount_before: Some(before_total),
            amount_after: Some(total),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(RevisionMutationResponse {
        target_type: "budget",
        action: "update",
        project_code: Some(project),
        branch_code: Some(branch),
        order_number: None,
        history_no: Some(history_no),
        status: Some(STATUS_DRAFT.to_string()),
        amount: Some(YenAmount(total)),
        event_no,
    }))
}

/// DELETE /api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no（未承認の案だけ）
pub async fn delete_budget_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch, h)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    require_draft_editor(&auth)?;
    let req = parse_delete_body(&headers, &body)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let history_no = parse_history_no(&h)?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &budget_lock_key(&company, &project, &branch)).await?;
    fetch_branch(&mut tx, &company, &project, &branch).await?;
    let (_, before_total) = lock_budget_version(&mut tx, &company, &project, &branch, history_no, WorkflowAction::Delete).await?;
    sqlx::query("DELETE FROM execution_budget_details WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4")
        .bind(&company)
        .bind(&project)
        .bind(&branch)
        .bind(history_no)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM execution_budgets WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 AND approval_status = '0'")
        .bind(&company)
        .bind(&project)
        .bind(&branch)
        .bind(history_no)
        .execute(&mut *tx)
        .await?;
    record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "budget",
            action: "delete",
            project_code: Some(&project),
            branch_code: Some(&branch),
            history_no: Some(history_no),
            amount_before: Some(before_total),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no/approve
pub async fn approve_budget_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch, h)): Path<(String, String, String)>,
    AppJson(req): AppJson<ApproveRequest>,
) -> Result<Json<RevisionMutationResponse>, ApiError> {
    require_approver(&auth, "予算案の承認")?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let history_no = parse_history_no(&h)?;
    let comment = validate_approve_comment(req.comment.as_deref())?;

    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &budget_lock_key(&company, &project, &branch)).await?;
    let info = fetch_branch(&mut tx, &company, &project, &branch).await?;
    lock_budget_version(&mut tx, &company, &project, &branch, history_no, WorkflowAction::Approve).await?;
    let versions = budget_versions(&mut tx, &company, &project, &branch).await?;
    let approved = latest_with_status(&versions, STATUS_APPROVED);
    if let Some(a) = approved.as_ref().filter(|a| a.history_no > history_no) {
        return Err(ApiError::Conflict(format!(
            "より新しい承認済みの版（履歴番号 {}）があるため、この案は承認できません",
            a.history_no
        )));
    }
    ensure_branch_open(&info.completion_status)?;
    let creator = creator_of(&mut tx, &company, DraftKey::Budget { project: &project, branch: &branch }, history_no).await?;
    check_self_approval(self_approval_allowed(), creator.as_deref(), &auth.user_id)?;

    // 総額は明細の 数量×単価（calc_line_amount）の合計をサーバーで計算する
    let rows = sqlx::query(
        "SELECT line_no, planned_quantity, planned_unit_price, CAST(planned_amount AS BIGINT) AS planned_amount FROM execution_budget_details WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 ORDER BY line_no",
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .bind(history_no)
    .fetch_all(&mut *tx)
    .await?;
    if rows.is_empty() {
        return Err(ApiError::Unprocessable("明細が0件の予算案は承認できません".to_string()));
    }
    let mut amounts = Vec::with_capacity(rows.len());
    for r in &rows {
        let line_no: i32 = r.try_get("line_no")?;
        let amount = budget_line_amount(r.try_get("planned_quantity")?, r.try_get("planned_unit_price")?)?;
        let stored: i64 = r.try_get("planned_amount")?;
        if stored != amount {
            // 案の明細金額が規則と異なれば規則どおりに直す（案は未承認のため UPDATE 可）
            sqlx::query("UPDATE execution_budget_details SET planned_amount = $6 WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 AND line_no = $5")
                .bind(&company)
                .bind(&project)
                .bind(&branch)
                .bind(history_no)
                .bind(line_no)
                .bind(Decimal::from(amount))
                .execute(&mut *tx)
                .await?;
        }
        amounts.push(amount);
    }
    let total = sum_yen(amounts, "予算合計")?;
    let updated = sqlx::query(
        "UPDATE execution_budgets SET total_budget_amount = $5, approval_status = '1' WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 AND approval_status = '0'",
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .bind(history_no)
    .bind(Decimal::from(total))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(ApiError::Conflict("予算案の状態が変わったため承認できませんでした".to_string()));
    }
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "budget",
            action: "approve",
            project_code: Some(&project),
            branch_code: Some(&branch),
            history_no: Some(history_no),
            reason: comment.as_deref(),
            amount_before: approved.as_ref().map(|a| a.amount),
            amount_after: Some(total),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(RevisionMutationResponse {
        target_type: "budget",
        action: "approve",
        project_code: Some(project),
        branch_code: Some(branch),
        order_number: None,
        history_no: Some(history_no),
        status: Some(STATUS_APPROVED.to_string()),
        amount: Some(YenAmount(total)),
        event_no,
    }))
}

/// POST /api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no/reject
pub async fn reject_budget_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((project, branch, h)): Path<(String, String, String)>,
    AppJson(req): AppJson<RejectRequest>,
) -> Result<Json<RevisionMutationResponse>, ApiError> {
    require_approver(&auth, "予算案の否認")?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    check_path_codes(&project, &branch)?;
    let history_no = parse_history_no(&h)?;
    let reason = validate_reject_reason(req.reason.as_deref())?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &budget_lock_key(&company, &project, &branch)).await?;
    fetch_branch(&mut tx, &company, &project, &branch).await?;
    let (_, amount) = lock_budget_version(&mut tx, &company, &project, &branch, history_no, WorkflowAction::Reject).await?;
    sqlx::query(
        "UPDATE execution_budgets SET approval_status = '9' WHERE company_code = $1 AND project_code = $2 AND branch_code = $3 AND budget_history_no = $4 AND approval_status = '0'",
    )
    .bind(&company)
    .bind(&project)
    .bind(&branch)
    .bind(history_no)
    .execute(&mut *tx)
    .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "budget",
            action: "reject",
            project_code: Some(&project),
            branch_code: Some(&branch),
            history_no: Some(history_no),
            reason: Some(&reason),
            amount_before: Some(amount),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(RevisionMutationResponse {
        target_type: "budget",
        action: "reject",
        project_code: Some(project),
        branch_code: Some(branch),
        order_number: None,
        history_no: Some(history_no),
        status: Some(STATUS_REJECTED.to_string()),
        amount: Some(YenAmount(amount)),
        event_no,
    }))
}

// ===========================================================================
// 外注発注: 新規・改定案の作成・編集・削除・承認・否認
// ===========================================================================

/// 発注の案に書き込む前の共通検証（外注先・工種・承認済み版との整合・査定累計ガード）
async fn validate_order_against_db(
    conn: &mut PgConnection,
    company: &str,
    order_number: &str,
    f: &ValidOrderFields,
    approved: Option<&OrderVersionDto>,
) -> Result<i64, ApiError> {
    if let Some(a) = approved {
        if a.subcontractor_code != f.subcontractor_code || a.work_type_code != f.work_type_code {
            return Err(ApiError::Unprocessable(
                "承認済みの注文の改定では外注先・工種は変更できません（別の注文として登録してください）".to_string(),
            ));
        }
    }
    require_partner_role(&mut *conn, company, &f.subcontractor_code, PartnerRole::Subcontractor, "外注先").await?;
    require_work_type(&mut *conn, company, &f.work_type_code).await?;
    let acc = accum_assessed(&mut *conn, company, order_number).await?;
    check_order_amount_not_below_assessed(f.amount, acc)?;
    check_tax_rate_unchanged_after_assessment(approved.map(|a| a.tax_rate), f.tax_rate, acc)?;
    Ok(acc)
}

fn order_mutation(action: &'static str, project: Option<String>, branch: Option<String>, number: String, h: i16, status: &str, amount: i64, event_no: i64) -> RevisionMutationResponse {
    RevisionMutationResponse {
        target_type: "order",
        action,
        project_code: project,
        branch_code: branch,
        order_number: Some(number),
        history_no: Some(h),
        status: Some(status.to_string()),
        amount: Some(YenAmount(amount)),
        event_no,
    }
}

/// POST /api/v1/orders — 新しい注文の案（履歴番号0・状態'0'）
pub async fn create_order(
    State(state): State<AppState>,
    auth: AuthContext,
    AppJson(req): AppJson<OrderCreateRequest>,
) -> Result<(StatusCode, Json<RevisionMutationResponse>), ApiError> {
    require_draft_editor(&auth)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    check_path_codes(&req.project_code, &req.branch_code)?;
    let f = validate_order_fields(&req.fields)?;
    let manual = match req.order_number.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(validate_order_number(s)?),
    };

    let mut tx = state.pool.begin().await?;
    // 注文番号の採番・重複確認は会社単位で直列化する
    advisory_lock(&mut tx, &format!("{}:subcontract_order_number", company)).await?;
    let order_number = match manual {
        Some(n) => {
            let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM subcontract_orders WHERE company_code = $1 AND order_number = $2 LIMIT 1")
                .bind(&company)
                .bind(&n)
                .fetch_optional(&mut *tx)
                .await?;
            if exists.is_some() {
                return Err(ApiError::Conflict(format!("注文番号 {} は既に使われています", n)));
            }
            n
        }
        None => {
            let year = f.order_date.year();
            let pattern = format!("^ORD-{:04}-[0-9]{{3}}$", year);
            let max: Option<String> = sqlx::query_scalar("SELECT MAX(order_number) FROM subcontract_orders WHERE company_code = $1 AND order_number ~ $2")
                .bind(&company)
                .bind(&pattern)
                .fetch_one(&mut *tx)
                .await?;
            next_auto_order_number(year, max.as_deref())?
        }
    };
    advisory_lock(&mut tx, &order_lock_key(&company, &order_number)).await?;
    let info = fetch_branch(&mut tx, &company, &req.project_code, &req.branch_code).await?;
    ensure_branch_open(&info.completion_status)?;
    validate_order_against_db(&mut tx, &company, &order_number, &f, None).await?;
    sqlx::query(
        r#"
        INSERT INTO subcontract_orders (
            company_code, order_number, order_history_no, project_code, branch_code, subcontractor_code, work_type_code,
            order_date, work_start_date, work_end_date, order_type, is_unit_price_contract,
            order_amount_tax_ex, order_tax_amount, tax_rate, retainage_rate_num, retainage_rate_den,
            safety_assoc_rate_num, safety_assoc_rate_den, order_status
        ) VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, '1', $10, $11, $12, $13, $14, $15, $16, $17, '0')
        "#,
    )
    .bind(&company)
    .bind(&order_number)
    .bind(&req.project_code)
    .bind(&req.branch_code)
    .bind(&f.subcontractor_code)
    .bind(&f.work_type_code)
    .bind(f.order_date)
    .bind(f.work_start_date)
    .bind(f.work_end_date)
    .bind(f.is_unit_price_contract)
    .bind(Decimal::from(f.amount))
    .bind(Decimal::from(f.tax_amount))
    .bind(f.tax_rate)
    .bind(f.retainage_num)
    .bind(f.retainage_den)
    .bind(f.safety_num)
    .bind(f.safety_den)
    .execute(&mut *tx)
    .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "order",
            action: "create",
            project_code: Some(&req.project_code),
            branch_code: Some(&req.branch_code),
            order_number: Some(&order_number),
            history_no: Some(0),
            amount_after: Some(f.amount),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(order_mutation("create", Some(req.project_code), Some(req.branch_code), order_number, 0, STATUS_DRAFT, f.amount, event_no)),
    ))
}

/// POST /api/v1/orders/:order_number/drafts — 改定案（最新の承認済み版を複写して履歴番号+1）
pub async fn create_order_revision(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(order_number): Path<String>,
    AppJson(req): AppJson<CompanyScopedRequest>,
) -> Result<(StatusCode, Json<RevisionMutationResponse>), ApiError> {
    require_draft_editor(&auth)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    let order_number = validate_order_number(&order_number).map_err(|_| ApiError::NotFound("注文が存在しません".to_string()))?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &order_lock_key(&company, &order_number)).await?;
    let versions = order_versions(&mut tx, &company, &order_number).await?;
    if versions.is_empty() {
        return Err(ApiError::NotFound(format!("注文 {} が存在しません", order_number)));
    }
    if let Some(d) = latest_with_status(&versions, STATUS_DRAFT) {
        return Err(ApiError::Conflict(format!(
            "この注文には未承認の案（履歴番号 {}）が既にあります。案は同時に1つまでです",
            d.history_no
        )));
    }
    let approved = latest_with_status(&versions, STATUS_APPROVED);
    let source = approved.clone().or_else(|| versions.iter().max_by_key(|v| v.history_no).cloned()).ok_or(ApiError::Internal)?;
    let src = fetch_order_version(&mut tx, &company, &order_number, source.history_no).await?.ok_or(ApiError::Internal)?;
    let info = fetch_branch(&mut tx, &company, &src.project_code, &src.branch_code).await?;
    ensure_branch_open(&info.completion_status)?;
    let new_h = next_history_no(&versions)?;
    sqlx::query(
        r#"
        INSERT INTO subcontract_orders (
            company_code, order_number, order_history_no, project_code, branch_code, subcontractor_code, work_type_code,
            order_date, work_start_date, work_end_date, order_type, is_unit_price_contract,
            order_amount_tax_ex, order_tax_amount, tax_rate, retainage_rate_num, retainage_rate_den,
            safety_assoc_rate_num, safety_assoc_rate_den, order_status)
        SELECT company_code, order_number, $4, project_code, branch_code, subcontractor_code, work_type_code,
            order_date, work_start_date, work_end_date, order_type, is_unit_price_contract,
            order_amount_tax_ex, order_tax_amount, tax_rate, retainage_rate_num, retainage_rate_den,
            safety_assoc_rate_num, safety_assoc_rate_den, '0'
        FROM subcontract_orders
        WHERE company_code = $1 AND order_number = $2 AND order_history_no = $3
        "#,
    )
    .bind(&company)
    .bind(&order_number)
    .bind(source.history_no)
    .bind(new_h)
    .execute(&mut *tx)
    .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "order",
            action: "create",
            project_code: Some(&src.project_code),
            branch_code: Some(&src.branch_code),
            order_number: Some(&order_number),
            history_no: Some(new_h),
            amount_before: approved.as_ref().map(|a| a.amount),
            amount_after: Some(src.order_amount_tax_ex.0),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(order_mutation("create", Some(src.project_code), Some(src.branch_code), order_number, new_h, STATUS_DRAFT, src.order_amount_tax_ex.0, event_no)),
    ))
}

/// 注文の版をロックして状態を判定する（無ければ 404）
async fn lock_order_version(
    conn: &mut PgConnection,
    company: &str,
    order_number: &str,
    history_no: i16,
    action: WorkflowAction,
) -> Result<OrderVersionDto, ApiError> {
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT order_status FROM subcontract_orders WHERE company_code = $1 AND order_number = $2 AND order_history_no = $3 FOR UPDATE",
    )
    .bind(company)
    .bind(order_number)
    .bind(history_no)
    .fetch_optional(&mut *conn)
    .await?;
    let status = exists.ok_or_else(|| ApiError::NotFound(format!("注文 {} の版（履歴番号 {}）が存在しません", order_number, history_no)))?;
    transition(&status, action)?;
    fetch_order_version(conn, company, order_number, history_no).await?.ok_or(ApiError::Internal)
}

async fn approved_order(conn: &mut PgConnection, company: &str, order_number: &str) -> Result<Option<OrderVersionDto>, ApiError> {
    let versions = order_versions(&mut *conn, company, order_number).await?;
    match latest_with_status(&versions, STATUS_APPROVED) {
        None => Ok(None),
        Some(a) => fetch_order_version(conn, company, order_number, a.history_no).await,
    }
}

/// PUT /api/v1/orders/:order_number/drafts/:history_no
pub async fn update_order_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((order_number, h)): Path<(String, String)>,
    AppJson(req): AppJson<OrderDraftUpdateRequest>,
) -> Result<Json<RevisionMutationResponse>, ApiError> {
    require_draft_editor(&auth)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    let order_number = validate_order_number(&order_number).map_err(|_| ApiError::NotFound("注文が存在しません".to_string()))?;
    let history_no = parse_history_no(&h)?;
    let f = validate_order_fields(&req.fields)?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &order_lock_key(&company, &order_number)).await?;
    let current = lock_order_version(&mut tx, &company, &order_number, history_no, WorkflowAction::Edit).await?;
    let info = fetch_branch(&mut tx, &company, &current.project_code, &current.branch_code).await?;
    ensure_branch_open(&info.completion_status)?;
    let approved = approved_order(&mut tx, &company, &order_number).await?;
    validate_order_against_db(&mut tx, &company, &order_number, &f, approved.as_ref()).await?;
    sqlx::query(
        r#"
        UPDATE subcontract_orders
           SET subcontractor_code = $4, work_type_code = $5, order_date = $6, work_start_date = $7, work_end_date = $8,
               is_unit_price_contract = $9, order_amount_tax_ex = $10, order_tax_amount = $11, tax_rate = $12,
               retainage_rate_num = $13, retainage_rate_den = $14, safety_assoc_rate_num = $15, safety_assoc_rate_den = $16
         WHERE company_code = $1 AND order_number = $2 AND order_history_no = $3 AND order_status = '0'
        "#,
    )
    .bind(&company)
    .bind(&order_number)
    .bind(history_no)
    .bind(&f.subcontractor_code)
    .bind(&f.work_type_code)
    .bind(f.order_date)
    .bind(f.work_start_date)
    .bind(f.work_end_date)
    .bind(f.is_unit_price_contract)
    .bind(Decimal::from(f.amount))
    .bind(Decimal::from(f.tax_amount))
    .bind(f.tax_rate)
    .bind(f.retainage_num)
    .bind(f.retainage_den)
    .bind(f.safety_num)
    .bind(f.safety_den)
    .execute(&mut *tx)
    .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "order",
            action: "update",
            project_code: Some(&current.project_code),
            branch_code: Some(&current.branch_code),
            order_number: Some(&order_number),
            history_no: Some(history_no),
            amount_before: Some(current.order_amount_tax_ex.0),
            amount_after: Some(f.amount),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(order_mutation("update", Some(current.project_code), Some(current.branch_code), order_number, history_no, STATUS_DRAFT, f.amount, event_no)))
}

/// DELETE /api/v1/orders/:order_number/drafts/:history_no（未承認の案だけ）
pub async fn delete_order_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((order_number, h)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    require_draft_editor(&auth)?;
    let req = parse_delete_body(&headers, &body)?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    let order_number = validate_order_number(&order_number).map_err(|_| ApiError::NotFound("注文が存在しません".to_string()))?;
    let history_no = parse_history_no(&h)?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &order_lock_key(&company, &order_number)).await?;
    let current = lock_order_version(&mut tx, &company, &order_number, history_no, WorkflowAction::Delete).await?;
    sqlx::query("DELETE FROM subcontract_orders WHERE company_code = $1 AND order_number = $2 AND order_history_no = $3 AND order_status = '0'")
        .bind(&company)
        .bind(&order_number)
        .bind(history_no)
        .execute(&mut *tx)
        .await?;
    record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "order",
            action: "delete",
            project_code: Some(&current.project_code),
            branch_code: Some(&current.branch_code),
            order_number: Some(&order_number),
            history_no: Some(history_no),
            amount_before: Some(current.order_amount_tax_ex.0),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/orders/:order_number/drafts/:history_no/approve
pub async fn approve_order_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((order_number, h)): Path<(String, String)>,
    AppJson(req): AppJson<ApproveRequest>,
) -> Result<Json<RevisionMutationResponse>, ApiError> {
    require_approver(&auth, "発注案の承認")?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    let order_number = validate_order_number(&order_number).map_err(|_| ApiError::NotFound("注文が存在しません".to_string()))?;
    let history_no = parse_history_no(&h)?;
    let comment = validate_approve_comment(req.comment.as_deref())?;
    let mut tx = state.pool.begin().await?;
    // 外注出来高の登録（actual_costs.rs）と同じキーでロックし、査定累計の読み取りと承認を直列化する
    advisory_lock(&mut tx, &order_lock_key(&company, &order_number)).await?;
    let draft = lock_order_version(&mut tx, &company, &order_number, history_no, WorkflowAction::Approve).await?;
    let approved = approved_order(&mut tx, &company, &order_number).await?;
    if let Some(a) = approved.as_ref().filter(|a| a.history_no > history_no) {
        return Err(ApiError::Conflict(format!(
            "より新しい承認済みの版（履歴番号 {}）があるため、この案は承認できません",
            a.history_no
        )));
    }
    let info = fetch_branch(&mut tx, &company, &draft.project_code, &draft.branch_code).await?;
    ensure_branch_open(&info.completion_status)?;
    let creator = creator_of(&mut tx, &company, DraftKey::Order { order_number: &order_number }, history_no).await?;
    check_self_approval(self_approval_allowed(), creator.as_deref(), &auth.user_id)?;
    // 案の内容を承認時点の規則で再検証する（承認後に出来高査定が増えていても発注額が下回らないこと）
    let f = ValidOrderFields {
        subcontractor_code: draft.subcontractor_code.clone(),
        work_type_code: draft.work_type_code.clone(),
        order_date: draft.order_date,
        work_start_date: draft.work_start_date,
        work_end_date: draft.work_end_date,
        is_unit_price_contract: draft.is_unit_price_contract,
        amount: draft.order_amount_tax_ex.0,
        tax_rate: draft.tax_rate,
        tax_amount: calc_order_tax_amount(draft.order_amount_tax_ex.0, draft.tax_rate)?,
        retainage_num: draft.retainage_rate_num.0,
        retainage_den: draft.retainage_rate_den.0,
        safety_num: draft.safety_assoc_rate_num.0,
        safety_den: draft.safety_assoc_rate_den.0,
    };
    validate_order_against_db(&mut tx, &company, &order_number, &f, approved.as_ref()).await?;
    let updated = sqlx::query(
        "UPDATE subcontract_orders SET order_tax_amount = $4, order_status = '1' WHERE company_code = $1 AND order_number = $2 AND order_history_no = $3 AND order_status = '0'",
    )
    .bind(&company)
    .bind(&order_number)
    .bind(history_no)
    .bind(Decimal::from(f.tax_amount))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(ApiError::Conflict("発注案の状態が変わったため承認できませんでした".to_string()));
    }
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "order",
            action: "approve",
            project_code: Some(&draft.project_code),
            branch_code: Some(&draft.branch_code),
            order_number: Some(&order_number),
            history_no: Some(history_no),
            reason: comment.as_deref(),
            amount_before: approved.as_ref().map(|a| a.order_amount_tax_ex.0),
            amount_after: Some(f.amount),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(order_mutation("approve", Some(draft.project_code), Some(draft.branch_code), order_number, history_no, STATUS_APPROVED, f.amount, event_no)))
}

/// POST /api/v1/orders/:order_number/drafts/:history_no/reject
pub async fn reject_order_draft(
    State(state): State<AppState>,
    auth: AuthContext,
    Path((order_number, h)): Path<(String, String)>,
    AppJson(req): AppJson<RejectRequest>,
) -> Result<Json<RevisionMutationResponse>, ApiError> {
    require_approver(&auth, "発注案の否認")?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    let order_number = validate_order_number(&order_number).map_err(|_| ApiError::NotFound("注文が存在しません".to_string()))?;
    let history_no = parse_history_no(&h)?;
    let reason = validate_reject_reason(req.reason.as_deref())?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &order_lock_key(&company, &order_number)).await?;
    let draft = lock_order_version(&mut tx, &company, &order_number, history_no, WorkflowAction::Reject).await?;
    sqlx::query("UPDATE subcontract_orders SET order_status = '9' WHERE company_code = $1 AND order_number = $2 AND order_history_no = $3 AND order_status = '0'")
        .bind(&company)
        .bind(&order_number)
        .bind(history_no)
        .execute(&mut *tx)
        .await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "order",
            action: "reject",
            project_code: Some(&draft.project_code),
            branch_code: Some(&draft.branch_code),
            order_number: Some(&order_number),
            history_no: Some(history_no),
            reason: Some(&reason),
            amount_before: Some(draft.order_amount_tax_ex.0),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(order_mutation("reject", Some(draft.project_code), Some(draft.branch_code), order_number, history_no, STATUS_REJECTED, draft.order_amount_tax_ex.0, event_no)))
}

// ===========================================================================
// 工事・枝番の登録（approver のみ: 契約額・工期は原価管理の基準値のため）
// ===========================================================================

async fn validate_branch_partners(conn: &mut PgConnection, company: &str, b: &ValidBranchFields) -> Result<(), ApiError> {
    require_partner_role(&mut *conn, company, &b.client_partner_code, PartnerRole::Customer, "発注者").await?;
    require_partner_role(&mut *conn, company, &b.site_manager_code, PartnerRole::Employee, "現場代理人").await?;
    if let Some(c) = &b.supervising_engineer_code {
        require_partner_role(&mut *conn, company, c, PartnerRole::Employee, "監理技術者").await?;
    }
    if let Some(c) = &b.chief_engineer_code {
        require_partner_role(&mut *conn, company, c, PartnerRole::Employee, "主任技術者").await?;
    }
    Ok(())
}

async fn insert_branch(conn: &mut PgConnection, company: &str, project: &str, branch: &str, b: &ValidBranchFields) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO project_branches (
            company_code, project_code, branch_code, branch_name, completion_status, revenue_recognition_method,
            managing_dept_code, site_manager_code, supervising_engineer_code, chief_engineer_code,
            contract_start_date, contract_end_date, internal_start_date, internal_end_date,
            client_partner_code, current_contract_amount_tax_ex, current_contract_tax_amount, estimated_total_cost, approval_status
        ) VALUES ($1, $2, $3, $4, '0', '0', '0000', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '1')
        "#,
    )
    .bind(company)
    .bind(project)
    .bind(branch)
    .bind(&b.branch_name)
    .bind(&b.site_manager_code)
    .bind(&b.supervising_engineer_code)
    .bind(&b.chief_engineer_code)
    .bind(b.contract_start_date)
    .bind(b.contract_end_date)
    .bind(b.internal_start_date)
    .bind(b.internal_end_date)
    .bind(&b.client_partner_code)
    .bind(Decimal::from(b.contract_amount_tax_ex))
    .bind(Decimal::from(b.contract_tax_amount))
    .bind(Decimal::from(b.estimated_total_cost))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// POST /api/v1/projects — 工事と本工事枝番 000 を登録する
pub async fn create_project(
    State(state): State<AppState>,
    auth: AuthContext,
    AppJson(req): AppJson<ProjectCreateRequest>,
) -> Result<(StatusCode, Json<RevisionMutationResponse>), ApiError> {
    require_approver(&auth, "工事の登録")?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    let project = validate_new_project_code(&req.project_code)?;
    let project_name = required_text(&req.project_name, 120, "工事名称")?;
    let short_name = required_text(&req.project_short_name, 40, "工事略称")?;
    let construction_type = req.construction_type.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("0001").to_string();
    if construction_type.len() != 4 || !construction_type.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::Unprocessable("工事種別コードは4桁の数字で指定してください".to_string()));
    }
    let doken = one_of(req.doken_type.as_deref(), "1", &["1", "2", "9"], "土建区分")?;
    let honzatsu = one_of(req.honzatsu_type.as_deref(), "1", &["1", "2"], "本雑区分")?;
    let kanmin1 = one_of(req.kanmin_type1.as_deref(), "2", &["1", "2"], "官民区分1")?;
    let kanmin2 = one_of(req.kanmin_type2.as_deref(), "9", &["1", "2", "3", "4", "5", "9"], "官民区分2")?;
    let method = one_of(req.contract_method.as_deref(), "1", &["1", "2", "7", "8", "9"], "受注方法")?;
    let main = validate_branch_fields(&req.main_branch)?;

    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &format!("{}:project:{}", company, project)).await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM project_masters WHERE company_code = $1 AND project_code = $2")
        .bind(&company)
        .bind(&project)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_some() {
        return Err(ApiError::Conflict(format!("工事コード {} は既に登録されています", project)));
    }
    validate_branch_partners(&mut tx, &company, &main).await?;
    // 受注形態は単独（'1'）のみ。JV は本フェーズの対象外（CONVENTIONS §1）。
    sqlx::query(
        r#"
        INSERT INTO project_masters (company_code, project_code, project_name, project_short_name, construction_type,
            doken_type, honzatsu_type, kanmin_type1, kanmin_type2, order_format, contract_method, is_common_cost)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '1', $10, FALSE)
        "#,
    )
    .bind(&company)
    .bind(&project)
    .bind(&project_name)
    .bind(&short_name)
    .bind(&construction_type)
    .bind(&doken)
    .bind(&honzatsu)
    .bind(&kanmin1)
    .bind(&kanmin2)
    .bind(&method)
    .execute(&mut *tx)
    .await?;
    insert_branch(&mut tx, &company, &project, "000", &main).await?;
    record_event(&mut tx, &auth, &company, NewEvent { target_type: "project", action: "create", project_code: Some(&project), ..Default::default() }).await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "branch",
            action: "create",
            project_code: Some(&project),
            branch_code: Some("000"),
            amount_after: Some(main.contract_amount_tax_ex),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(RevisionMutationResponse {
            target_type: "project",
            action: "create",
            project_code: Some(project),
            branch_code: Some("000".to_string()),
            order_number: None,
            history_no: None,
            status: None,
            amount: Some(YenAmount(main.contract_amount_tax_ex)),
            event_no,
        }),
    ))
}

/// POST /api/v1/projects/:project_code/branches — 追加工事枝番 001〜999 を登録する
pub async fn create_branch(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(project): Path<String>,
    AppJson(req): AppJson<BranchCreateRequest>,
) -> Result<(StatusCode, Json<RevisionMutationResponse>), ApiError> {
    require_approver(&auth, "工事枝番の登録")?;
    let company = auth.resolve_company(req.company_code.as_deref())?;
    validate_project_code(&project)?;
    let branch = req.branch_code.trim().to_string();
    validate_branch_code(&branch)?;
    if branch == "000" {
        return Err(ApiError::Unprocessable(
            "本工事枝番 000 は工事の登録時に作成されます。追加工事は 001〜999 で指定してください".to_string(),
        ));
    }
    let b = validate_branch_fields(&req.fields)?;
    let mut tx = state.pool.begin().await?;
    advisory_lock(&mut tx, &format!("{}:project:{}", company, project)).await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM project_masters WHERE company_code = $1 AND project_code = $2")
        .bind(&company)
        .bind(&project)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound(format!("工事 {} が存在しません", project)));
    }
    let dup: Option<i32> = sqlx::query_scalar("SELECT 1 FROM project_branches WHERE company_code = $1 AND project_code = $2 AND branch_code = $3")
        .bind(&company)
        .bind(&project)
        .bind(&branch)
        .fetch_optional(&mut *tx)
        .await?;
    if dup.is_some() {
        return Err(ApiError::Conflict(format!("工事枝番 {}-{} は既に登録されています", project, branch)));
    }
    validate_branch_partners(&mut tx, &company, &b).await?;
    insert_branch(&mut tx, &company, &project, &branch, &b).await?;
    let event_no = record_event(
        &mut tx,
        &auth,
        &company,
        NewEvent {
            target_type: "branch",
            action: "create",
            project_code: Some(&project),
            branch_code: Some(&branch),
            amount_after: Some(b.contract_amount_tax_ex),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(RevisionMutationResponse {
            target_type: "branch",
            action: "create",
            project_code: Some(project),
            branch_code: Some(branch),
            order_number: None,
            history_no: None,
            status: None,
            amount: Some(YenAmount(b.contract_amount_tax_ex)),
            event_no,
        }),
    ))
}

// ===========================================================================
// 単体試験
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn line(no: i32, qty: Decimal, price: Decimal, item: &str) -> BudgetLineDto {
        BudgetLineDto {
            line_no: no,
            work_type_code: "002000100010".to_string(),
            work_type_name: None,
            cost_element_code: "0300".to_string(),
            cost_element_name: None,
            item_name: item.to_string(),
            specification: None,
            unit: "式".to_string(),
            planned_quantity: Quantity(qty),
            planned_unit_price: UnitPrice(price),
            planned_amount: YenAmount(budget_line_amount(qty, price).unwrap()),
        }
    }

    #[test]
    fn workflow_transitions() {
        use WorkflowAction::*;
        assert_eq!(transition("0", Edit).unwrap(), "0");
        assert_eq!(transition("0", Delete).unwrap(), "0");
        assert_eq!(transition("0", Approve).unwrap(), "1");
        assert_eq!(transition("0", Reject).unwrap(), "9");
        // 承認済み・否認済みは何もできない（409）。'2'/'3' は扱わない。
        for st in ["1", "9", "2", "3"] {
            for a in [Edit, Delete, Approve, Reject] {
                assert!(matches!(transition(st, a), Err(ApiError::Conflict(_))), "{} {:?}", st, a);
            }
        }
        assert_eq!(transition("0 ", Approve).unwrap(), "1", "CHAR(1) の空白は無視");
    }

    #[test]
    fn reject_reason_is_required_and_bounded() {
        assert!(matches!(validate_reject_reason(None), Err(ApiError::Unprocessable(_))));
        assert!(matches!(validate_reject_reason(Some("   ")), Err(ApiError::Unprocessable(_))));
        assert_eq!(validate_reject_reason(Some("  数量根拠が不足  ")).unwrap(), "数量根拠が不足");
        assert!(validate_reject_reason(Some(&"あ".repeat(200))).is_ok());
        assert!(matches!(validate_reject_reason(Some(&"あ".repeat(201))), Err(ApiError::Unprocessable(_))));
        assert!(validate_reject_reason(Some("1行目\n2行目")).is_ok());
        assert!(matches!(validate_reject_reason(Some("bell\u{7}")), Err(ApiError::Unprocessable(_))));
        assert_eq!(validate_approve_comment(Some("  ")).unwrap(), None);
        assert!(validate_approve_comment(Some(&"x".repeat(201))).is_err());
    }

    #[test]
    fn budget_line_amount_uses_round_half_up_and_server_total() {
        // 数量×単価の小数第1位を四捨五入（calc_line_amount）
        assert_eq!(budget_line_amount(dec!(1.005), dec!(100.500)).unwrap(), 101); // 101.0025
        assert_eq!(budget_line_amount(dec!(3), dec!(0.500)).unwrap(), 2); // 1.5 → 2
        assert_eq!(budget_line_amount(dec!(1), dec!(0.499)).unwrap(), 0);
        assert_eq!(budget_line_amount(dec!(200.000), dec!(20000.000)).unwrap(), 4_000_000);
        assert!(matches!(
            budget_line_amount(dec!(999999999999.999), dec!(999999999999.999)),
            Err(ApiError::Unprocessable(_))
        ));
        assert_eq!(sum_yen([1, 2, 3], "t").unwrap(), 6);
        assert!(sum_yen([MAX_YEN_ABS, 1], "t").is_err());
        // クライアントが planned_amount を送っても受け取らない（入力型に存在しない）
        let input: BudgetLineInput = serde_json::from_value(serde_json::json!({
            "work_type_code": "002000100010", "cost_element_code": "0300", "item_name": "型枠",
            "unit": "式", "planned_quantity": "2.000", "planned_unit_price": "1500.250", "planned_amount": 1
        }))
        .unwrap();
        let v = validate_budget_lines(&[input]).unwrap();
        assert_eq!(v[0].amount, 3001); // 3000.5 → 3001
    }

    #[test]
    fn budget_line_validation_rejects_bad_input() {
        let ok = serde_json::json!({ "work_type_code": "002000100010", "cost_element_code": "0300", "item_name": "a", "unit": "式", "planned_quantity": "1", "planned_unit_price": "1" });
        let bad = |patch: serde_json::Value| {
            let mut v = ok.clone();
            for (k, val) in patch.as_object().unwrap() {
                v[k] = val.clone();
            }
            let l: BudgetLineInput = serde_json::from_value(v).unwrap();
            validate_budget_lines(&[l])
        };
        assert!(bad(serde_json::json!({})).is_ok());
        assert!(bad(serde_json::json!({ "work_type_code": "0020" })).is_err());
        assert!(bad(serde_json::json!({ "cost_element_code": "03" })).is_err());
        assert!(bad(serde_json::json!({ "item_name": " " })).is_err());
        assert!(bad(serde_json::json!({ "planned_quantity": "0" })).is_err());
        assert!(bad(serde_json::json!({ "planned_quantity": "1.0001" })).is_err());
        assert!(bad(serde_json::json!({ "planned_unit_price": "-1" })).is_err());
    }

    #[test]
    fn line_numbers_are_kept_and_new_ones_follow_approved_max() {
        assert_eq!(assign_line_numbers(&[Some(1), None, Some(3), None], 6).unwrap(), vec![1, 7, 3, 8]);
        assert_eq!(assign_line_numbers(&[None, None], 0).unwrap(), vec![1, 2]);
        assert_eq!(assign_line_numbers(&[Some(10), None], 2).unwrap(), vec![10, 11]);
        assert!(assign_line_numbers(&[Some(1), Some(1)], 0).is_err());
        assert!(assign_line_numbers(&[Some(0)], 0).is_err());
    }

    #[test]
    fn budget_diff_detects_added_changed_removed_and_total_delta() {
        let base = vec![line(1, dec!(1), dec!(1000), "足場"), line(2, dec!(1), dec!(2000), "土工"), line(3, dec!(1), dec!(500), "諸経費")];
        let draft = vec![line(1, dec!(1), dec!(1000), "足場"), line(2, dec!(2), dec!(2000), "土工"), line(4, dec!(1), dec!(700), "追加")];
        let d = diff_budget_lines(Some(0), &base, 1, &draft).unwrap();
        assert_eq!(d.total_before, YenAmount(3500));
        assert_eq!(d.total_after, YenAmount(5700));
        assert_eq!(d.total_delta, YenAmount(2200));
        assert_eq!(d.added.iter().map(|l| l.line_no).collect::<Vec<_>>(), vec![4]);
        assert_eq!(d.removed.iter().map(|l| l.line_no).collect::<Vec<_>>(), vec![3]);
        assert_eq!(d.changed.len(), 1);
        assert_eq!(d.changed[0].line_no, 2);
        assert_eq!(d.changed[0].amount_delta, YenAmount(2000));
        // 承認済み版が無い（新規予算）なら全行が追加
        let n = diff_budget_lines(None, &[], 0, &draft).unwrap();
        assert_eq!(n.added.len(), 3);
        assert_eq!(n.total_delta, n.total_after);
    }

    #[test]
    fn order_amount_guard_and_tax() {
        assert!(check_order_amount_not_below_assessed(3_000_000, 3_000_000).is_ok());
        assert!(check_order_amount_not_below_assessed(3_000_001, 3_000_000).is_ok());
        assert!(matches!(check_order_amount_not_below_assessed(2_999_999, 3_000_000), Err(ApiError::Unprocessable(_))));
        assert!(check_order_amount_not_below_assessed(0, 0).is_ok());
        // 税額は切捨
        assert_eq!(calc_order_tax_amount(10_000_000, dec!(0.100)).unwrap(), 1_000_000);
        assert_eq!(calc_order_tax_amount(12_345, dec!(0.100)).unwrap(), 1_234);
        assert_eq!(calc_order_tax_amount(999, dec!(0.080)).unwrap(), 79);
        // 査定済みの注文は税率を変えない
        assert!(check_tax_rate_unchanged_after_assessment(Some(dec!(0.100)), dec!(0.1), 100).is_ok());
        assert!(check_tax_rate_unchanged_after_assessment(Some(dec!(0.100)), dec!(0.080), 100).is_err());
        assert!(check_tax_rate_unchanged_after_assessment(Some(dec!(0.100)), dec!(0.080), 0).is_ok());
        assert!(check_tax_rate_unchanged_after_assessment(None, dec!(0.080), 100).is_ok());
    }

    #[test]
    fn order_number_rules_and_self_approval() {
        assert_eq!(next_auto_order_number(2026, None).unwrap(), "ORD-2026-001");
        assert_eq!(next_auto_order_number(2026, Some("ORD-2026-002")).unwrap(), "ORD-2026-003");
        assert_eq!(next_auto_order_number(2026, Some("ORD-2026-002")).unwrap().len(), 12, "VARCHAR(12) に収まる");
        assert!(matches!(next_auto_order_number(2026, Some("ORD-2026-999")), Err(ApiError::Unprocessable(_))));
        assert_eq!(validate_order_number(" 2026-04-0012 ").unwrap(), "2026-04-0012");
        assert!(validate_order_number("ORD 1").is_err());
        assert!(validate_order_number("ORD-2026-0001").is_err());
        assert!(validate_new_project_code("PRJ-2026-B").is_ok());
        assert!(validate_new_project_code("PRJ 2026").is_err());
        assert!(check_self_approval(true, Some("u1"), "u1").is_ok());
        assert!(matches!(check_self_approval(false, Some("u1"), "u1"), Err(ApiError::Forbidden(_))));
        assert!(check_self_approval(false, Some("u1"), "u2").is_ok());
        assert!(check_self_approval(false, None, "u2").is_ok());
        assert!(ensure_branch_open("0").is_ok());
        assert!(ensure_branch_open("1").is_ok());
        assert!(matches!(ensure_branch_open("2"), Err(ApiError::Unprocessable(_))));
        assert!(matches!(ensure_branch_open("3"), Err(ApiError::Unprocessable(_))));
    }

    #[test]
    fn order_and_branch_field_validation() {
        let base = serde_json::json!({
            "subcontractor_code": "SUB-0001", "work_type_code": "002000100010",
            "order_date": "2026-04-10", "work_start_date": "2026-04-15", "work_end_date": "2026-10-31",
            "order_amount_tax_ex": 10000000
        });
        let parse = |v: serde_json::Value| -> OrderFieldsInput { serde_json::from_value(v).unwrap() };
        let f = validate_order_fields(&parse(base.clone())).unwrap();
        assert_eq!(f.tax_rate, dec!(0.100));
        assert_eq!(f.tax_amount, 1_000_000);
        assert_eq!((f.retainage_num, f.retainage_den, f.safety_num, f.safety_den), (dec!(10.00), dec!(100.00), dec!(3.00), dec!(1000.00)));
        let with = |k: &str, v: serde_json::Value| {
            let mut x = base.clone();
            x[k] = v;
            validate_order_fields(&parse(x))
        };
        assert!(with("work_end_date", serde_json::json!("2026-04-01")).is_err());
        assert!(with("order_amount_tax_ex", serde_json::json!(-1)).is_err());
        assert!(with("tax_rate", serde_json::json!("1.5")).is_err());
        assert!(with("tax_rate", serde_json::json!("0.1001")).is_err());
        assert!(with("retainage_rate_den", serde_json::json!("0")).is_err());
        assert!(with("safety_assoc_rate_num", serde_json::json!("-1")).is_err());
        // フラット形式（flatten）の作成要求も読める
        let mut create = base.clone();
        create["project_code"] = serde_json::json!("PRJ-2026-A");
        create["branch_code"] = serde_json::json!("000");
        create["tax_rate"] = serde_json::json!("0.080");
        let req: OrderCreateRequest = serde_json::from_value(create).unwrap();
        assert_eq!(req.fields.tax_rate, dec!(0.080));
        assert!(req.order_number.is_none());

        let branch = serde_json::json!({
            "branch_name": "本工事", "site_manager_code": "EMP-0001", "client_partner_code": "CLI-0001",
            "contract_start_date": "2026-04-01", "contract_end_date": "2026-12-20",
            "internal_start_date": "2026-04-05", "internal_end_date": "2026-12-10", "contract_amount_tax_ex": 1000
        });
        let pb = |v: serde_json::Value| -> BranchFieldsInput { serde_json::from_value(v).unwrap() };
        assert!(validate_branch_fields(&pb(branch.clone())).is_ok());
        let mut late = branch.clone();
        late["contract_end_date"] = serde_json::json!("2026-03-31");
        assert!(validate_branch_fields(&pb(late)).is_err());
        let mut internal = branch.clone();
        internal["internal_start_date"] = serde_json::json!("2026-12-11");
        assert!(validate_branch_fields(&pb(internal)).is_err());
        let mut neg = branch;
        neg["contract_amount_tax_ex"] = serde_json::json!(-5);
        assert!(validate_branch_fields(&pb(neg)).is_err());
    }

    #[test]
    fn delete_body_requires_json_content_type_and_allows_empty_body() {
        use axum::http::{header, HeaderValue};
        let mut h = HeaderMap::new();
        assert!(matches!(parse_delete_body(&h, &Bytes::new()), Err(ApiError::BadRequest(_))));
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(parse_delete_body(&h, &Bytes::new()).unwrap().company_code.is_none());
        assert_eq!(parse_delete_body(&h, &Bytes::from_static(b"{\"company_code\":\"9001\"}")).unwrap().company_code.as_deref(), Some("9001"));
        assert!(matches!(parse_delete_body(&h, &Bytes::from_static(b"a=1")), Err(ApiError::BadRequest(_))));
    }
}
