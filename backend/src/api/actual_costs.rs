use axum::{extract::State, http::StatusCode, Json};
use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use sirius_reborn_backend::domain::calc::{self, MAX_YEN_ABS};
use sirius_reborn_backend::domain::types::{
    AssessmentCalcInput, CompletionStatus, CostRegistrationResponse, EasyDailyReportRequest,
    EasyDirectCostRequest, EasyEquipmentMovementRequest, EasySubcontractProgressRequest, Quantity,
    Rate, UnitPrice, YenAmount,
};
use sqlx::{Postgres, Row, Transaction};

use crate::api::{auth::AuthContext, ApiError, AppJson, AppState};

#[derive(Clone, Copy)]
pub(crate) enum SlipKind {
    Assessment,
    DirectCost,
    DailyReport,
    EquipmentMovement,
}

impl SlipKind {
    fn lock_tag(self) -> &'static str {
        match self {
            Self::Assessment => "progress_assessments",
            Self::DirectCost => "direct_cost_entries",
            Self::DailyReport => "site_daily_reports",
            Self::EquipmentMovement => "equipment_site_movements",
        }
    }

    fn max_query_sql(self) -> &'static str {
        match self {
            Self::Assessment => {
                "SELECT MAX(assessment_no) AS max_no FROM progress_assessments WHERE company_code = $1 AND assessment_no ~ '^[0-9]{12}$'"
            }
            Self::DirectCost => {
                "SELECT MAX(entry_no) AS max_no FROM direct_cost_entries WHERE company_code = $1 AND entry_no ~ '^[0-9]{12}$'"
            }
            Self::DailyReport => {
                "SELECT MAX(report_no) AS max_no FROM site_daily_reports WHERE company_code = $1 AND report_no ~ '^[0-9]{12}$'"
            }
            Self::EquipmentMovement => {
                "SELECT MAX(movement_slip_no) AS max_no FROM equipment_site_movements WHERE company_code = $1 AND movement_slip_no ~ '^[0-9]{12}$'"
            }
        }
    }
}

pub(crate) fn validate_company_code(code: &str) -> Result<(), ApiError> {
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::Unprocessable(
            "会社コードは4文字の英数字で指定してください".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_project_code(code: &str) -> Result<(), ApiError> {
    let trimmed = code.trim();
    if trimmed.is_empty() || code.len() > 10 {
        return Err(ApiError::Unprocessable(
            "工事コードは1〜10文字で指定してください".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_branch_code(code: &str) -> Result<(), ApiError> {
    if code.len() != 3 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::Unprocessable(
            "工事枝番は3桁の数字で指定してください".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_work_type_format(code: &str) -> Result<(), ApiError> {
    if code.chars().count() != 12 {
        return Err(ApiError::Unprocessable(
            "工種コードは厳密に12桁で指定してください".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_non_negative_yen(val: YenAmount, label: &str) -> Result<i64, ApiError> {
    if val.0 < 0 {
        return Err(ApiError::Unprocessable(format!(
            "{}に負数は指定できません",
            label
        )));
    }
    if val.0 > MAX_YEN_ABS {
        return Err(ApiError::Unprocessable(format!(
            "{}が15桁上限を超過しています",
            label
        )));
    }
    Ok(val.0)
}

pub(crate) fn validate_positive_quantity(qty: Quantity, label: &str) -> Result<Decimal, ApiError> {
    if qty.0 <= Decimal::ZERO {
        return Err(ApiError::Unprocessable(format!(
            "{}は0より大きい値を指定してください",
            label
        )));
    }
    if qty.0.scale() > 3 {
        return Err(ApiError::Unprocessable(format!(
            "{}の小数桁数は3桁以内で指定してください",
            label
        )));
    }
    if qty.0.trunc().abs() > Decimal::from(999_999_999_999i64) {
        return Err(ApiError::Unprocessable(format!(
            "{}が上限を超過しています",
            label
        )));
    }
    Ok(qty.0)
}

pub(crate) fn validate_non_negative_unit_price(
    price: UnitPrice,
    label: &str,
) -> Result<Decimal, ApiError> {
    if price.0 < Decimal::ZERO {
        return Err(ApiError::Unprocessable(format!(
            "{}に負数は指定できません",
            label
        )));
    }
    if price.0.scale() > 3 {
        return Err(ApiError::Unprocessable(format!(
            "{}の小数桁数は3桁以内で指定してください",
            label
        )));
    }
    if price.0.trunc().abs() > Decimal::from(999_999_999_999i64) {
        return Err(ApiError::Unprocessable(format!(
            "{}が上限を超過しています",
            label
        )));
    }
    Ok(price.0)
}

pub(crate) fn validate_year_month(ym: &str) -> Result<NaiveDate, ApiError> {
    if ym.len() != 6 || !ym.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::Unprocessable(
            "査定年月はYYYYMM形式（6桁数字）で指定してください".to_string(),
        ));
    }
    let year: i32 = ym[0..4]
        .parse()
        .map_err(|_| ApiError::Unprocessable("査定年月の年が不正です".to_string()))?;
    let month: u32 = ym[4..6]
        .parse()
        .map_err(|_| ApiError::Unprocessable("査定年月の月が不正です".to_string()))?;
    if !(1..=12).contains(&month) || !(1..=9999).contains(&year) {
        return Err(ApiError::Unprocessable(
            "査定年月が有効範囲外です".to_string(),
        ));
    }
    if year == 9999 && month == 12 {
        return NaiveDate::from_ymd_opt(9999, 12, 31)
            .ok_or_else(|| ApiError::Unprocessable("査定月末日の算出に失敗しました".to_string()));
    }
    let next_month_first = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .ok_or_else(|| ApiError::Unprocessable("査定年月日の算出に失敗しました".to_string()))?;

    next_month_first
        .pred_opt()
        .ok_or_else(|| ApiError::Unprocessable("査定月末日の算出に失敗しました".to_string()))
}

pub(crate) fn ensure_decimal_fits_yen(val: Decimal, label: &str) -> Result<i64, ApiError> {
    let rounded = val.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    let n = rounded.to_i64().ok_or_else(|| {
        ApiError::Unprocessable(format!("{}が整数範囲を超過しています", label))
    })?;
    if n.unsigned_abs() > MAX_YEN_ABS as u64 {
        return Err(ApiError::Unprocessable(format!(
            "{}が15桁上限を超過しています",
            label
        )));
    }
    Ok(n)
}

pub(crate) async fn guard_project_branch(
    tx: &mut Transaction<'_, Postgres>,
    auth: &AuthContext,
    company_code: &str,
    project_code: &str,
    branch_code: &str,
    reference_date: NaiveDate,
) -> Result<Vec<String>, ApiError> {
    let row = sqlx::query(
        r#"
        SELECT completion_status, internal_end_date
        FROM project_branches
        WHERE company_code = $1 AND project_code = $2 AND branch_code = $3
        FOR UPDATE
        "#,
    )
    .bind(company_code)
    .bind(project_code)
    .bind(branch_code)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        ApiError::NotFound(format!(
            "対象の工事枝番が存在しません: {}-{}",
            project_code, branch_code
        ))
    })?;

    let status_str: String = row.try_get("completion_status")?;
    let internal_end_date: NaiveDate = row.try_get("internal_end_date")?;
    let status = CompletionStatus::from_code(&status_str).map_err(ApiError::Unprocessable)?;

    if !status.can_accept_cost() {
        return Err(ApiError::Unprocessable(format!(
            "完成区分がロック済（{}）のため、新規の原価登録はできません",
            status_str.trim()
        )));
    }

    // 区分2/3は全役割で 422（上で判定済み）。区分1は承認権限のみ登録可、登録権限は 403。
    // Err で戻ると呼出側のトランザクションは commit されずロールバックされる。
    if status == CompletionStatus::Completed {
        auth.require_completed_registration()?;
    }

    let mut warnings = Vec::new();
    if status == CompletionStatus::Completed {
        warnings.push("完成区分が「完成(1)」の工事に対する原価登録です。".to_string());
    }
    if reference_date > internal_end_date {
        warnings.push(format!(
            "発生日({})が社内工期終了日({})を超過しています。",
            reference_date, internal_end_date
        ));
    }

    Ok(warnings)
}

pub(crate) async fn verify_work_type_exists(
    tx: &mut Transaction<'_, Postgres>,
    company_code: &str,
    work_type_code: &str,
) -> Result<(), ApiError> {
    validate_work_type_format(work_type_code)?;
    let exists = sqlx::query(
        "SELECT 1 FROM work_types WHERE company_code = $1 AND work_type_code = $2",
    )
    .bind(company_code)
    .bind(work_type_code)
    .fetch_optional(&mut **tx)
    .await?;

    if exists.is_none() {
        return Err(ApiError::NotFound(format!(
            "指定された工種コードが存在しません: {}",
            work_type_code
        )));
    }
    Ok(())
}

pub(crate) async fn allocate_slip_no(
    tx: &mut Transaction<'_, Postgres>,
    company_code: &str,
    kind: SlipKind,
) -> Result<String, ApiError> {
    let lock_key = format!("{}:{}", company_code, kind.lock_tag());
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&lock_key)
        .execute(&mut **tx)
        .await?;

    let row = sqlx::query(kind.max_query_sql())
        .bind(company_code)
        .fetch_one(&mut **tx)
        .await?;

    let max_no: Option<String> = row.try_get("max_no")?;
    let next_num: u64 = match max_no {
        Some(s) => {
            let current: u64 = s.trim().parse().map_err(|_| ApiError::Internal)?;
            current.checked_add(1).ok_or_else(|| {
                ApiError::Unprocessable("伝票番号が12桁上限に達しました".to_string())
            })?
        }
        None => 1,
    };

    if next_num > 999_999_999_999 {
        return Err(ApiError::Unprocessable(
            "伝票番号が12桁上限（999999999999）を超過しました".to_string(),
        ));
    }

    Ok(format!("{:012}", next_num))
}

/// POST /api/v1/costs/subcontract-progress
pub async fn submit_subcontract_progress(
    State(state): State<AppState>,
    auth: AuthContext,
    AppJson(req): AppJson<EasySubcontractProgressRequest>,
) -> Result<(StatusCode, Json<CostRegistrationResponse>), ApiError> {
    // 権限（registrar 以上）→ 形式 → 会社境界の順に判定。以降の問い合わせはセッションの会社のみを使う
    auth.require_cost_registration()?;
    validate_company_code(&req.company_code)?;
    let company_code = auth.resolve_company(Some(&req.company_code))?;
    if req.order_number.trim().is_empty() || req.order_number.len() > 12 {
        return Err(ApiError::Unprocessable(
            "注文番号は1〜12文字で指定してください".to_string(),
        ));
    }
    if req.order_history_no < 0 {
        return Err(ApiError::Unprocessable(
            "注文履歴番号に負数は指定できません".to_string(),
        ));
    }
    let closing_date = validate_year_month(&req.assessment_year_month)?;
    validate_non_negative_yen(req.curr_assessed_amount_tax_ex, "今回査定税抜額")?;
    validate_non_negative_yen(req.fixed_deductions, "定額控除額")?;
    validate_non_negative_yen(req.chargeback_offset, "立替相殺額")?;

    let mut tx = state.pool.begin().await?;

    // 会社＋注文番号単位の排他ロック
    let order_lock_key = format!(
        "{}:subcontract_order:{}",
        company_code, req.order_number
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&order_lock_key)
        .execute(&mut *tx)
        .await?;

    // 最新承認済注文書を FOR UPDATE で取得
    let order_row = sqlx::query(
        r#"
        SELECT
            order_history_no,
            project_code,
            branch_code,
            subcontractor_code,
            work_type_code,
            CAST(order_amount_tax_ex AS BIGINT) AS order_amount_tax_ex,
            tax_rate,
            retainage_rate_num,
            retainage_rate_den,
            safety_assoc_rate_num,
            safety_assoc_rate_den
        FROM subcontract_orders
        WHERE company_code = $1 AND order_number = $2 AND order_status = '1'
        ORDER BY order_history_no DESC
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(&company_code)
    .bind(&req.order_number)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        ApiError::NotFound(format!(
            "承認済の下請注文書が存在しません: {}",
            req.order_number
        ))
    })?;

    let latest_history_no: i16 = order_row.try_get("order_history_no")?;
    if latest_history_no != req.order_history_no {
        return Err(ApiError::Conflict(format!(
            "注文書履歴が更新されています（要求: {}, 最新: {}）。最新履歴を再取得してください",
            req.order_history_no, latest_history_no
        )));
    }

    let project_code: String = order_row.try_get("project_code")?;
    let branch_code: String = order_row.try_get("branch_code")?;
    let subcontractor_code: String = order_row.try_get("subcontractor_code")?;
    let work_type_code: String = order_row.try_get("work_type_code")?;
    let order_amount_tax_ex: i64 = order_row.try_get("order_amount_tax_ex")?;
    let tax_rate: Decimal = order_row.try_get("tax_rate")?;
    let retainage_rate_num: Decimal = order_row.try_get("retainage_rate_num")?;
    let retainage_rate_den: Decimal = order_row.try_get("retainage_rate_den")?;
    let safety_assoc_rate_num: Decimal = order_row.try_get("safety_assoc_rate_num")?;
    let safety_assoc_rate_den: Decimal = order_row.try_get("safety_assoc_rate_den")?;

    // 外注先の存在・ロール・削除状態確認
    let sub_row = sqlx::query(
        r#"
        SELECT is_subcontractor, is_deleted
        FROM business_partners
        WHERE company_code = $1 AND partner_code = $2
        "#,
    )
    .bind(&company_code)
    .bind(&subcontractor_code)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        ApiError::NotFound(format!(
            "外注先取引先が存在しません: {}",
            subcontractor_code
        ))
    })?;

    let is_subcontractor: bool = sub_row.try_get("is_subcontractor")?;
    let is_deleted: bool = sub_row.try_get("is_deleted")?;
    if is_deleted || !is_subcontractor {
        return Err(ApiError::Unprocessable(format!(
            "指定された取引先は有効な外注先ではありません: {}",
            subcontractor_code
        )));
    }

    // 工事枝番の完成区分・工期ガード
    let warnings = guard_project_branch(
        &mut tx,
        &auth,
        &company_code,
        &project_code,
        &branch_code,
        closing_date,
    )
    .await?;

    // 過去査定累計を注文番号全履歴から集計
    let prev_row = sqlx::query(
        r#"
        SELECT
            CAST(COALESCE(SUM(curr_assessed_amount_tax_ex), 0) AS BIGINT) AS prev_accum_ex,
            CAST(COALESCE(SUM(curr_assessed_tax_amount), 0) AS BIGINT) AS prev_accum_tax
        FROM progress_assessments
        WHERE company_code = $1 AND order_number = $2
        "#,
    )
    .bind(&company_code)
    .bind(&req.order_number)
    .fetch_one(&mut *tx)
    .await?;

    let prev_accum_ex: i64 = prev_row.try_get("prev_accum_ex")?;
    let prev_accum_tax: i64 = prev_row.try_get("prev_accum_tax")?;

    let calc_input = AssessmentCalcInput {
        order_amount_tax_ex: YenAmount(order_amount_tax_ex),
        prev_accum_assessed_tax_ex: YenAmount(prev_accum_ex),
        prev_accum_tax_amount: YenAmount(prev_accum_tax),
        curr_assessed_tax_ex: req.curr_assessed_amount_tax_ex,
        tax_rate,
        retainage_rate_num: Rate(retainage_rate_num),
        retainage_rate_den: Rate(retainage_rate_den),
        safety_assoc_rate_num: Rate(safety_assoc_rate_num),
        safety_assoc_rate_den: Rate(safety_assoc_rate_den),
        fixed_deductions: req.fixed_deductions,
        chargeback_offset: req.chargeback_offset,
    };

    let calc_out =
        calc::calc_subcontract_assessment(&calc_input).map_err(ApiError::Unprocessable)?;

    // 累計進捗率(%) = 累計査定税抜額 / 契約税抜額 * 100（契約0は0.00）
    let progress_rate_percent = if order_amount_tax_ex > 0 {
        let accum_dec = Decimal::from(calc_out.accum_assessed_amount_tax_ex.0);
        let order_dec = Decimal::from(order_amount_tax_ex);
        accum_dec
            .checked_mul(Decimal::from(100))
            .and_then(|v| v.checked_div(order_dec))
            .ok_or_else(|| ApiError::Unprocessable("進捗率の計算に失敗しました".to_string()))?
            .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
    } else {
        Decimal::ZERO
    };

    let assessment_no = allocate_slip_no(&mut tx, &company_code, SlipKind::Assessment).await?;

    sqlx::query(
        r#"
        INSERT INTO progress_assessments (
            company_code,
            assessment_no,
            order_number,
            order_history_no,
            subcontractor_code,
            project_code,
            branch_code,
            work_type_code,
            assessment_year_month,
            assessment_closing_date,
            progress_rate_percent,
            curr_assessed_amount_tax_ex,
            curr_assessed_tax_amount,
            accum_assessed_amount_tax_ex,
            accum_assessed_tax_amount,
            curr_retainage_deduction,
            curr_safety_assoc_deduction,
            curr_fixed_deductions,
            curr_chargeback_offset,
            net_payment_amount
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )
        "#,
    )
    .bind(&company_code)
    .bind(&assessment_no)
    .bind(&req.order_number)
    .bind(latest_history_no)
    .bind(&subcontractor_code)
    .bind(&project_code)
    .bind(&branch_code)
    .bind(&work_type_code)
    .bind(&req.assessment_year_month)
    .bind(closing_date)
    .bind(progress_rate_percent)
    .bind(calc_out.curr_assessed_amount_tax_ex.0)
    .bind(calc_out.curr_assessed_tax_amount.0)
    .bind(calc_out.accum_assessed_amount_tax_ex.0)
    .bind(calc_out.accum_assessed_tax_amount.0)
    .bind(calc_out.curr_retainage_deduction.0)
    .bind(calc_out.curr_safety_assoc_deduction.0)
    .bind(req.fixed_deductions.0)
    .bind(req.chargeback_offset.0)
    .bind(calc_out.net_payment_amount.0)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(CostRegistrationResponse {
            document_no: assessment_no,
            warnings,
        }),
    ))
}

/// POST /api/v1/costs/direct-entry
pub async fn submit_direct_cost(
    State(state): State<AppState>,
    auth: AuthContext,
    AppJson(req): AppJson<EasyDirectCostRequest>,
) -> Result<(StatusCode, Json<CostRegistrationResponse>), ApiError> {
    // 権限（registrar 以上）→ 形式 → 会社境界の順に判定。以降の問い合わせはセッションの会社のみを使う
    auth.require_cost_registration()?;
    validate_company_code(&req.company_code)?;
    let company_code = auth.resolve_company(Some(&req.company_code))?;
    validate_project_code(&req.project_code)?;
    validate_branch_code(&req.branch_code)?;

    let cost_elem = req.cost_element_code.trim();
    if cost_elem != "0100" && cost_elem != "0400" {
        return Err(ApiError::Unprocessable(
            "費目コードは '0100'(材料費) または '0400'(現場経費) のみ指定可能です".to_string(),
        ));
    }

    let item_name = req.item_name.trim();
    if item_name.is_empty() || item_name.chars().count() > 80 {
        return Err(ApiError::Unprocessable(
            "品目名は1〜80文字で指定してください".to_string(),
        ));
    }

    let specification = match req.specification.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(s) if s.chars().count() > 60 => {
            return Err(ApiError::Unprocessable(
                "規格・仕様は60文字以内で指定してください".to_string(),
            ));
        }
        Some(s) => Some(s.to_string()),
    };

    let unit = req.unit.trim();
    if unit.is_empty() || unit.chars().count() > 10 {
        return Err(ApiError::Unprocessable(
            "単位は1〜10文字で指定してください".to_string(),
        ));
    }

    let qty_dec = validate_positive_quantity(req.quantity, "数量")?;
    let price_dec = validate_non_negative_unit_price(req.unit_price, "単価")?;
    let product = qty_dec.checked_mul(price_dec).ok_or_else(|| {
        ApiError::Unprocessable("数量×単価の計算でオーバーフローが発生しました".to_string())
    })?;
    ensure_decimal_fits_yen(product, "明細金額")?;
    let amount_tax_ex = calc::calc_line_amount(req.quantity, req.unit_price);

    let vendor_code = match req.vendor_partner_code.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(v) if v.len() > 8 => {
            return Err(ApiError::Unprocessable(
                "仕入先コードは8文字以内で指定してください".to_string(),
            ));
        }
        Some(v) => Some(v.to_string()),
    };

    let mut tx = state.pool.begin().await?;

    let warnings = guard_project_branch(
        &mut tx,
        &auth,
        &company_code,
        &req.project_code,
        &req.branch_code,
        req.occurred_date,
    )
    .await?;

    verify_work_type_exists(&mut tx, &company_code, &req.work_type_code).await?;

    let elem_exists = sqlx::query(
        "SELECT 1 FROM cost_elements WHERE company_code = $1 AND cost_element_code = $2",
    )
    .bind(&company_code)
    .bind(cost_elem)
    .fetch_optional(&mut *tx)
    .await?;
    if elem_exists.is_none() {
        return Err(ApiError::NotFound(format!(
            "指定された費目コードが存在しません: {}",
            cost_elem
        )));
    }

    if let Some(ref vc) = vendor_code {
        let v_row = sqlx::query(
            r#"
            SELECT is_supplier, is_deleted
            FROM business_partners
            WHERE company_code = $1 AND partner_code = $2
            "#,
        )
        .bind(&company_code)
        .bind(vc)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("指定された仕入先が存在しません: {}", vc)))?;

        let is_supplier: bool = v_row.try_get("is_supplier")?;
        let is_deleted: bool = v_row.try_get("is_deleted")?;
        if is_deleted || !is_supplier {
            return Err(ApiError::Unprocessable(format!(
                "指定された取引先は有効な仕入先ではありません: {}",
                vc
            )));
        }
    }

    let entry_no = allocate_slip_no(&mut tx, &company_code, SlipKind::DirectCost).await?;

    sqlx::query(
        r#"
        INSERT INTO direct_cost_entries (
            company_code,
            entry_no,
            project_code,
            branch_code,
            occurred_date,
            vendor_partner_code,
            work_type_code,
            cost_element_code,
            item_name,
            specification,
            quantity,
            unit,
            unit_price,
            amount_tax_ex,
            notes
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15
        )
        "#,
    )
    .bind(&company_code)
    .bind(&entry_no)
    .bind(&req.project_code)
    .bind(&req.branch_code)
    .bind(req.occurred_date)
    .bind(vendor_code)
    .bind(&req.work_type_code)
    .bind(cost_elem)
    .bind(item_name)
    .bind(specification)
    .bind(qty_dec)
    .bind(unit)
    .bind(price_dec)
    .bind(amount_tax_ex.0)
    .bind(req.notes)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(CostRegistrationResponse {
            document_no: entry_no,
            warnings,
        }),
    ))
}

/// POST /api/v1/costs/daily-report
pub async fn submit_daily_report(
    State(state): State<AppState>,
    auth: AuthContext,
    AppJson(req): AppJson<EasyDailyReportRequest>,
) -> Result<(StatusCode, Json<CostRegistrationResponse>), ApiError> {
    // 権限（registrar 以上）→ 形式 → 会社境界の順に判定。以降の問い合わせはセッションの会社のみを使う
    auth.require_cost_registration()?;
    validate_company_code(&req.company_code)?;
    let company_code = auth.resolve_company(Some(&req.company_code))?;
    validate_project_code(&req.project_code)?;
    validate_branch_code(&req.branch_code)?;

    let emp_code = req.employee_code.trim();
    if emp_code.is_empty() || emp_code.len() > 8 {
        return Err(ApiError::Unprocessable(
            "社員コードは1〜8文字で指定してください".to_string(),
        ));
    }

    let work_hours_dec = validate_positive_quantity(req.work_hours, "作業時間")?;
    if work_hours_dec > Decimal::from(24) {
        return Err(ApiError::Unprocessable(
            "作業時間は24時間以内で指定してください".to_string(),
        ));
    }

    let work_summary = match req.work_summary.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(s) if s.chars().count() > 120 => {
            return Err(ApiError::Unprocessable(
                "作業概要は120文字以内で指定してください".to_string(),
            ));
        }
        Some(s) => Some(s.to_string()),
    };

    let mut tx = state.pool.begin().await?;

    let warnings = guard_project_branch(
        &mut tx,
        &auth,
        &company_code,
        &req.project_code,
        &req.branch_code,
        req.work_date,
    )
    .await?;

    verify_work_type_exists(&mut tx, &company_code, &req.work_type_code).await?;

    let emp_row = sqlx::query(
        r#"
        SELECT is_employee, is_deleted, CAST(standard_daily_wage AS BIGINT) AS standard_daily_wage
        FROM business_partners
        WHERE company_code = $1 AND partner_code = $2
        "#,
    )
    .bind(&company_code)
    .bind(emp_code)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        ApiError::NotFound(format!("指定された社員・作業員が存在しません: {}", emp_code))
    })?;

    let is_employee: bool = emp_row.try_get("is_employee")?;
    let is_deleted: bool = emp_row.try_get("is_deleted")?;
    if is_deleted || !is_employee {
        return Err(ApiError::Unprocessable(format!(
            "指定された取引先は有効な社員・作業員ではありません: {}",
            emp_code
        )));
    }

    let standard_daily_wage: i64 = emp_row.try_get("standard_daily_wage")?;
    validate_non_negative_yen(YenAmount(standard_daily_wage), "標準日額労務単価")?;

    let raw_labor = Decimal::from(standard_daily_wage)
        .checked_mul(work_hours_dec)
        .and_then(|v| v.checked_div(Decimal::from(8)))
        .ok_or_else(|| {
            ApiError::Unprocessable("労務費の計算でオーバーフローが発生しました".to_string())
        })?;
    ensure_decimal_fits_yen(raw_labor, "概算労務原価")?;
    let calculated_labor_cost =
        calc::calc_daily_labor_cost(YenAmount(standard_daily_wage), req.work_hours);

    let report_no = allocate_slip_no(&mut tx, &company_code, SlipKind::DailyReport).await?;

    sqlx::query(
        r#"
        INSERT INTO site_daily_reports (
            company_code,
            report_no,
            work_date,
            employee_code,
            project_code,
            branch_code,
            work_type_code,
            work_hours,
            calculated_labor_cost,
            work_summary
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )
        "#,
    )
    .bind(&company_code)
    .bind(&report_no)
    .bind(req.work_date)
    .bind(emp_code)
    .bind(&req.project_code)
    .bind(&req.branch_code)
    .bind(&req.work_type_code)
    .bind(work_hours_dec)
    .bind(calculated_labor_cost.0)
    .bind(work_summary)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(CostRegistrationResponse {
            document_no: report_no,
            warnings,
        }),
    ))
}

/// POST /api/v1/costs/equipment-movement
pub async fn submit_equipment_movement(
    State(state): State<AppState>,
    auth: AuthContext,
    AppJson(req): AppJson<EasyEquipmentMovementRequest>,
) -> Result<(StatusCode, Json<CostRegistrationResponse>), ApiError> {
    // 権限（registrar 以上）→ 形式 → 会社境界の順に判定。以降の問い合わせはセッションの会社のみを使う
    auth.require_cost_registration()?;
    validate_company_code(&req.company_code)?;
    let company_code = auth.resolve_company(Some(&req.company_code))?;
    validate_project_code(&req.dest_project_code)?;
    validate_branch_code(&req.dest_branch_code)?;

    let equip_code = req.equipment_code.trim();
    if equip_code.is_empty() || equip_code.len() > 10 {
        return Err(ApiError::Unprocessable(
            "資機材コードは1〜10文字で指定してください".to_string(),
        ));
    }

    let qty_dec = validate_positive_quantity(req.quantity, "数量")?;
    if req.usage_days <= 0 {
        return Err(ApiError::Unprocessable(
            "使用日数は1以上の整数で指定してください".to_string(),
        ));
    }
    let freight_val = validate_non_negative_yen(req.freight_fee, "運賃")?;
    let maint_val = validate_non_negative_yen(req.maintenance_fee, "整備費")?;

    let mut tx = state.pool.begin().await?;

    let warnings = guard_project_branch(
        &mut tx,
        &auth,
        &company_code,
        &req.dest_project_code,
        &req.dest_branch_code,
        req.movement_date,
    )
    .await?;

    verify_work_type_exists(&mut tx, &company_code, &req.work_type_code).await?;

    let eq_row = sqlx::query(
        r#"
        SELECT daily_rent_price
        FROM construction_equipment_masters
        WHERE company_code = $1 AND equipment_code = $2
        "#,
    )
    .bind(&company_code)
    .bind(equip_code)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        ApiError::NotFound(format!(
            "指定された仮設資機材が存在しません: {}",
            equip_code
        ))
    })?;

    let daily_rent_price: Decimal = eq_row.try_get("daily_rent_price")?;
    validate_non_negative_unit_price(UnitPrice(daily_rent_price), "日額損料単価")?;

    let rent_raw = qty_dec
        .checked_mul(daily_rent_price)
        .and_then(|v| v.checked_mul(Decimal::from(req.usage_days)))
        .ok_or_else(|| {
            ApiError::Unprocessable("損料計算でオーバーフローが発生しました".to_string())
        })?;
    let rent_yen = ensure_decimal_fits_yen(rent_raw, "損料金額")?;
    let total_check = rent_yen
        .checked_add(freight_val)
        .and_then(|v| v.checked_add(maint_val))
        .ok_or_else(|| {
            ApiError::Unprocessable("機械損料合計の計算でオーバーフローが発生しました".to_string())
        })?;
    if total_check.unsigned_abs() > MAX_YEN_ABS as u64 {
        return Err(ApiError::Unprocessable(
            "機械損料合計が15桁上限を超過しています".to_string(),
        ));
    }

    let calculated_equip_cost = calc::calc_equipment_movement_cost(
        req.quantity,
        UnitPrice(daily_rent_price),
        req.usage_days,
        req.freight_fee,
        req.maintenance_fee,
    );

    let movement_slip_no =
        allocate_slip_no(&mut tx, &company_code, SlipKind::EquipmentMovement).await?;

    sqlx::query(
        r#"
        INSERT INTO equipment_site_movements (
            company_code,
            movement_slip_no,
            equipment_code,
            dest_project_code,
            dest_branch_code,
            work_type_code,
            movement_date,
            movement_type,
            quantity,
            usage_days,
            freight_fee,
            maintenance_fee,
            calculated_equip_cost
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, '02', $8, $9, $10, $11, $12
        )
        "#,
    )
    .bind(&company_code)
    .bind(&movement_slip_no)
    .bind(equip_code)
    .bind(&req.dest_project_code)
    .bind(&req.dest_branch_code)
    .bind(&req.work_type_code)
    .bind(req.movement_date)
    .bind(qty_dec)
    .bind(req.usage_days)
    .bind(freight_val)
    .bind(maint_val)
    .bind(calculated_equip_cost.0)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(CostRegistrationResponse {
            document_no: movement_slip_no,
            warnings,
        }),
    ))
}
