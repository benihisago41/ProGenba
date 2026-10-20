use axum::{
    extract::{Query, State},
    Json,
};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::Deserialize;
use sirius_reborn_backend::domain::{
    calc::MAX_YEN_ABS,
    types::{
        CompletionStatus, CostElementBreakdown, EmployeeLookupDto, EquipmentLookupDto, LookupsDto,
        ProjectBranchKey, ProjectCostCockpitDto, QuickItemTemplateDto, Rate,
        SubcontractOrderSummaryDto, SupplierLookupDto, UnitPrice, WorkTypeCostRow,
        WorkTypeLookupDto, YenAmount,
    },
};
use sqlx::Row;
use std::collections::{BTreeMap, HashMap};

use crate::api::{ApiError, AppState};

#[derive(Debug, Deserialize)]
pub struct CockpitQuery {
    pub company_code: Option<String>,
    pub project_code: Option<String>,
    pub branch_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LookupsQuery {
    pub company_code: Option<String>,
}

#[derive(Default)]
struct WtAccum {
    budget: i64,
    ordered: i64,
    actual: i64,
}

fn normalize_company(code: Option<&str>) -> Result<String, ApiError> {
    let c = code.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("0000");
    if c.len() != 4 || !c.is_ascii() {
        return Err(ApiError::Unprocessable(
            "company_codeは4文字で指定してください".to_string(),
        ));
    }
    Ok(c.to_string())
}

fn checked_add_yen(a: i64, b: i64) -> Result<i64, ApiError> {
    let sum = a
        .checked_add(b)
        .ok_or_else(|| ApiError::Unprocessable("金額集計でオーバーフローが発生しました".to_string()))?;
    if sum.unsigned_abs() > MAX_YEN_ABS as u64 {
        return Err(ApiError::Unprocessable(
            "金額集計結果が15桁上限を超過しました".to_string(),
        ));
    }
    Ok(sum)
}

fn add_wt(
    map: &mut HashMap<(String, String), BTreeMap<String, WtAccum>>,
    proj: &str,
    br: &str,
    wt: &str,
    b: i64,
    o: i64,
    a: i64,
) -> Result<(), ApiError> {
    let entry = map
        .entry((proj.to_string(), br.to_string()))
        .or_default()
        .entry(wt.to_string())
        .or_default();
    entry.budget = checked_add_yen(entry.budget, b)?;
    entry.ordered = checked_add_yen(entry.ordered, o)?;
    entry.actual = checked_add_yen(entry.actual, a)?;
    Ok(())
}

fn calc_percent_rate(numerator: i64, denominator: i64) -> Result<Rate, ApiError> {
    if denominator <= 0 {
        return Ok(Rate(Decimal::new(0, 2)));
    }
    let pct = Decimal::from(numerator)
        .checked_mul(Decimal::from(100))
        .and_then(|v| v.checked_div(Decimal::from(denominator)))
        .ok_or_else(|| ApiError::Unprocessable("比率計算でオーバーフローが発生しました".to_string()))?
        .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
    Ok(Rate(pct))
}

pub async fn get_cockpit(
    State(state): State<AppState>,
    Query(q): Query<CockpitQuery>,
) -> Result<Json<Vec<ProjectCostCockpitDto>>, ApiError> {
    let company_code = normalize_company(q.company_code.as_deref())?;
    let project_filter = q
        .project_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let branch_filter = q
        .branch_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // 1. 工事枝番一覧
    let branch_rows = sqlx::query(
        r#"
        SELECT pb.project_code, pb.branch_code, pm.project_name, pb.branch_name,
               pb.completion_status, pb.supervising_engineer_code,
               CAST(pb.current_contract_amount_tax_ex AS BIGINT) AS contract_amount_tax_ex
        FROM project_branches pb
        JOIN project_masters pm
          ON pm.company_code = pb.company_code AND pm.project_code = pb.project_code
        WHERE pb.company_code = $1
          AND ($2::VARCHAR IS NULL OR pb.project_code = $2)
          AND ($3::VARCHAR IS NULL OR pb.branch_code = $3)
        ORDER BY pb.project_code, pb.branch_code
        "#,
    )
    .bind(&company_code)
    .bind(project_filter)
    .bind(branch_filter)
    .fetch_all(&state.pool)
    .await?;

    // 2. 工種辞書
    let wt_rows = sqlx::query(
        "SELECT work_type_code, work_type_name FROM work_types WHERE company_code = $1",
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut wt_names = HashMap::with_capacity(wt_rows.len());
    for r in wt_rows {
        let code: String = r.try_get("work_type_code")?;
        let name: String = r.try_get("work_type_name")?;
        wt_names.insert(code, name);
    }

    // 3. 最新承認済実行予算の履歴番号と工種別明細合計
    let latest_budget_rows = sqlx::query(
        r#"
        SELECT project_code, branch_code, MAX(budget_history_no) AS latest_history_no
        FROM execution_budgets
        WHERE company_code = $1 AND approval_status = '1'
        GROUP BY project_code, branch_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut latest_hist_map: HashMap<(String, String), i16> = HashMap::new();
    for r in latest_budget_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let h: i16 = r.try_get("latest_history_no")?;
        latest_hist_map.insert((p, b), h);
    }

    let budget_wt_rows = sqlx::query(
        r#"
        WITH latest_b AS (
            SELECT company_code, project_code, branch_code, MAX(budget_history_no) AS budget_history_no
            FROM execution_budgets
            WHERE company_code = $1 AND approval_status = '1'
            GROUP BY company_code, project_code, branch_code
        )
        SELECT d.project_code, d.branch_code, d.work_type_code,
               CAST(COALESCE(SUM(d.planned_amount), 0) AS BIGINT) AS budget_amount
        FROM execution_budget_details d
        JOIN latest_b lb
          ON lb.company_code = d.company_code
         AND lb.project_code = d.project_code
         AND lb.branch_code = d.branch_code
         AND lb.budget_history_no = d.budget_history_no
        GROUP BY d.project_code, d.branch_code, d.work_type_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut wt_map: HashMap<(String, String), BTreeMap<String, WtAccum>> = HashMap::new();
    let mut budget_total_map: HashMap<(String, String), i64> = HashMap::new();
    for r in budget_wt_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let wt: String = r.try_get("work_type_code")?;
        let amt: i64 = r.try_get("budget_amount")?;
        add_wt(&mut wt_map, &p, &b, &wt, amt, 0, 0)?;
        let tot = budget_total_map.entry((p, b)).or_insert(0);
        *tot = checked_add_yen(*tot, amt)?;
    }

    // 4. 最新承認済下請注文書（工種別発注額）
    let sub_order_rows = sqlx::query(
        r#"
        WITH latest_o AS (
            SELECT DISTINCT ON (company_code, order_number)
                   project_code, branch_code, work_type_code, order_amount_tax_ex
            FROM subcontract_orders
            WHERE company_code = $1 AND order_status = '1'
            ORDER BY company_code, order_number, order_history_no DESC
        )
        SELECT project_code, branch_code, work_type_code,
               CAST(COALESCE(SUM(order_amount_tax_ex), 0) AS BIGINT) AS ordered_amount
        FROM latest_o
        GROUP BY project_code, branch_code, work_type_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut sub_ordered_map: HashMap<(String, String), i64> = HashMap::new();
    for r in sub_order_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let wt: String = r.try_get("work_type_code")?;
        let amt: i64 = r.try_get("ordered_amount")?;
        add_wt(&mut wt_map, &p, &b, &wt, 0, amt, 0)?;
        let tot = sub_ordered_map.entry((p, b)).or_insert(0);
        *tot = checked_add_yen(*tot, amt)?;
    }

    // 5. 外注出来高査定（実発生原価：30 外注費）
    let assess_rows = sqlx::query(
        r#"
        SELECT project_code, branch_code, work_type_code,
               CAST(COALESCE(SUM(curr_assessed_amount_tax_ex), 0) AS BIGINT) AS actual_amount
        FROM progress_assessments
        WHERE company_code = $1
        GROUP BY project_code, branch_code, work_type_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut sub_actual_map: HashMap<(String, String), i64> = HashMap::new();
    for r in assess_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let wt: String = r.try_get("work_type_code")?;
        let amt: i64 = r.try_get("actual_amount")?;
        add_wt(&mut wt_map, &p, &b, &wt, 0, 0, amt)?;
        let tot = sub_actual_map.entry((p, b)).or_insert(0);
        *tot = checked_add_yen(*tot, amt)?;
    }

    // 6. 材料費・現場経費（発注確定かつ実発生原価：0100 材料 / 0400 経費）
    let direct_rows = sqlx::query(
        r#"
        SELECT project_code, branch_code, work_type_code, cost_element_code,
               CAST(COALESCE(SUM(amount_tax_ex), 0) AS BIGINT) AS actual_amount
        FROM direct_cost_entries
        WHERE company_code = $1
        GROUP BY project_code, branch_code, work_type_code, cost_element_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut mat_map: HashMap<(String, String), i64> = HashMap::new();
    let mut exp_map: HashMap<(String, String), i64> = HashMap::new();
    for r in direct_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let wt: String = r.try_get("work_type_code")?;
        let elem: String = r.try_get("cost_element_code")?;
        let amt: i64 = r.try_get("actual_amount")?;
        add_wt(&mut wt_map, &p, &b, &wt, 0, amt, amt)?;
        if elem.trim() == "0100" {
            let tot = mat_map.entry((p, b)).or_insert(0);
            *tot = checked_add_yen(*tot, amt)?;
        } else {
            let tot = exp_map.entry((p, b)).or_insert(0);
            *tot = checked_add_yen(*tot, amt)?;
        }
    }

    // 7. 現場日報・労務費（発注確定かつ実発生原価：20 労務費）
    let labor_rows = sqlx::query(
        r#"
        SELECT project_code, branch_code, work_type_code,
               CAST(COALESCE(SUM(calculated_labor_cost), 0) AS BIGINT) AS actual_amount
        FROM site_daily_reports
        WHERE company_code = $1
        GROUP BY project_code, branch_code, work_type_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut labor_map: HashMap<(String, String), i64> = HashMap::new();
    for r in labor_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let wt: String = r.try_get("work_type_code")?;
        let amt: i64 = r.try_get("actual_amount")?;
        add_wt(&mut wt_map, &p, &b, &wt, 0, amt, amt)?;
        let tot = labor_map.entry((p, b)).or_insert(0);
        *tot = checked_add_yen(*tot, amt)?;
    }

    // 8. 資機材移動・機械損料（発注確定かつ実発生原価：50 機械損料）
    let equip_rows = sqlx::query(
        r#"
        SELECT dest_project_code AS project_code, dest_branch_code AS branch_code, work_type_code,
               CAST(COALESCE(SUM(calculated_equip_cost), 0) AS BIGINT) AS actual_amount
        FROM equipment_site_movements
        WHERE company_code = $1
        GROUP BY dest_project_code, dest_branch_code, work_type_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut equip_map: HashMap<(String, String), i64> = HashMap::new();
    for r in equip_rows {
        let p: String = r.try_get("project_code")?;
        let b: String = r.try_get("branch_code")?;
        let wt: String = r.try_get("work_type_code")?;
        let amt: i64 = r.try_get("actual_amount")?;
        add_wt(&mut wt_map, &p, &b, &wt, 0, amt, amt)?;
        let tot = equip_map.entry((p, b)).or_insert(0);
        *tot = checked_add_yen(*tot, amt)?;
    }

    // 9. DTO組立
    let mut result = Vec::with_capacity(branch_rows.len());
    for r in branch_rows {
        let project_code: String = r.try_get("project_code")?;
        let branch_code: String = r.try_get("branch_code")?;
        let project_name: String = r.try_get("project_name")?;
        let branch_name: String = r.try_get("branch_name")?;
        let status_str: String = r.try_get("completion_status")?;
        let completion_status =
            CompletionStatus::from_code(&status_str).map_err(ApiError::Unprocessable)?;
        let sup_eng: Option<String> = r.try_get("supervising_engineer_code")?;
        let contract_tax_ex: i64 = r.try_get("contract_amount_tax_ex")?;

        let k = (project_code.clone(), branch_code.clone());
        let latest_budget_history_no = latest_hist_map.get(&k).copied().unwrap_or(0);
        let execution_budget_amount = budget_total_map.get(&k).copied().unwrap_or(0);

        let sub_ordered = sub_ordered_map.get(&k).copied().unwrap_or(0);
        let material_cost = mat_map.get(&k).copied().unwrap_or(0);
        let labor_cost = labor_map.get(&k).copied().unwrap_or(0);
        let subcontract_cost = sub_actual_map.get(&k).copied().unwrap_or(0);
        let expense_cost = exp_map.get(&k).copied().unwrap_or(0);
        let equipment_cost = equip_map.get(&k).copied().unwrap_or(0);

        let direct_and_other = checked_add_yen(material_cost, expense_cost)
            .and_then(|v| checked_add_yen(v, labor_cost))
            .and_then(|v| checked_add_yen(v, equipment_cost))?;

        let ordered_committed_amount = checked_add_yen(sub_ordered, direct_and_other)?;
        let actual_occurred_cost = checked_add_yen(subcontract_cost, direct_and_other)?;

        let forecast_final_cost = execution_budget_amount
            .max(ordered_committed_amount)
            .max(actual_occurred_cost);
        let forecast_gross_profit = contract_tax_ex
            .checked_sub(forecast_final_cost)
            .ok_or_else(|| ApiError::Unprocessable("粗利計算でオーバーフローが発生しました".to_string()))?;
        let forecast_profit_rate = calc_percent_rate(forecast_gross_profit, contract_tax_ex)?;

        let is_budget_exceeded = actual_occurred_cost > execution_budget_amount
            || ordered_committed_amount > execution_budget_amount;
        let has_supervising_eng = sup_eng.as_deref().map(str::trim).is_some_and(|s| !s.is_empty());
        let requires_supervising_engineer_warning =
            sub_ordered >= 45_000_000 && !has_supervising_eng;

        let mut by_work_type = Vec::new();
        if let Some(wt_entries) = wt_map.get(&k) {
            for (wt_code, acc) in wt_entries {
                if acc.budget == 0 && acc.ordered == 0 && acc.actual == 0 {
                    continue;
                }
                let remaining = acc
                    .budget
                    .checked_sub(acc.actual)
                    .ok_or_else(|| ApiError::Unprocessable("予算残計算でオーバーフローが発生しました".to_string()))?;
                let rate = calc_percent_rate(acc.actual, acc.budget)?;
                let wt_name = wt_names
                    .get(wt_code)
                    .cloned()
                    .unwrap_or_else(|| wt_code.clone());
                by_work_type.push(WorkTypeCostRow {
                    work_type_code: wt_code.clone(),
                    work_type_name: wt_name,
                    budget_amount: YenAmount(acc.budget),
                    ordered_amount: YenAmount(acc.ordered),
                    actual_cost: YenAmount(acc.actual),
                    remaining_budget: YenAmount(remaining),
                    consumption_rate_percent: rate,
                });
            }
        }

        result.push(ProjectCostCockpitDto {
            key: ProjectBranchKey {
                company_code: company_code.clone(),
                project_code,
                branch_code,
            },
            project_name,
            branch_name,
            completion_status,
            contract_amount_tax_ex: YenAmount(contract_tax_ex),
            latest_budget_history_no,
            execution_budget_amount: YenAmount(execution_budget_amount),
            ordered_committed_amount: YenAmount(ordered_committed_amount),
            actual_occurred_cost: YenAmount(actual_occurred_cost),
            forecast_final_cost: YenAmount(forecast_final_cost),
            forecast_gross_profit: YenAmount(forecast_gross_profit),
            forecast_profit_rate,
            is_budget_exceeded,
            requires_supervising_engineer_warning,
            actual_breakdown: CostElementBreakdown {
                material_cost: YenAmount(material_cost),
                labor_cost: YenAmount(labor_cost),
                subcontract_cost: YenAmount(subcontract_cost),
                expense_cost: YenAmount(expense_cost),
                equipment_cost: YenAmount(equipment_cost),
                total_cost: YenAmount(actual_occurred_cost),
            },
            by_work_type,
        });
    }

    Ok(Json(result))
}

pub async fn get_lookups(
    State(state): State<AppState>,
    Query(q): Query<LookupsQuery>,
) -> Result<Json<LookupsDto>, ApiError> {
    let company_code = normalize_company(q.company_code.as_deref())?;

    // 1. quick_templates
    let tpl_rows = sqlx::query(
        r#"
        SELECT template_code, item_label, work_type_code, cost_element_code,
               default_unit, default_unit_price
        FROM quick_item_templates
        WHERE company_code = $1
        ORDER BY template_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut quick_templates = Vec::with_capacity(tpl_rows.len());
    for r in tpl_rows {
        quick_templates.push(QuickItemTemplateDto {
            template_code: r.try_get("template_code")?,
            item_label: r.try_get("item_label")?,
            work_type_code: r.try_get("work_type_code")?,
            cost_element_code: r.try_get::<String, _>("cost_element_code")?.trim().to_string(),
            default_unit: r.try_get("default_unit")?,
            default_unit_price: UnitPrice(r.try_get("default_unit_price")?),
        });
    }

    // 2. subcontract_orders (最新承認済履歴 + 全履歴の査定累計SUM)
    let ord_rows = sqlx::query(
        r#"
        WITH latest_o AS (
            SELECT DISTINCT ON (company_code, order_number)
                   company_code, order_number, order_history_no, project_code, branch_code,
                   subcontractor_code, work_type_code, order_amount_tax_ex,
                   tax_rate, retainage_rate_num, retainage_rate_den,
                   safety_assoc_rate_num, safety_assoc_rate_den
            FROM subcontract_orders
            WHERE company_code = $1 AND order_status = '1'
            ORDER BY company_code, order_number, order_history_no DESC
        ),
        assess_sum AS (
            SELECT company_code, order_number,
                   CAST(COALESCE(SUM(curr_assessed_amount_tax_ex), 0) AS BIGINT) AS accum_ex,
                   CAST(COALESCE(SUM(curr_assessed_tax_amount), 0) AS BIGINT) AS accum_tax
            FROM progress_assessments
            WHERE company_code = $1
            GROUP BY company_code, order_number
        )
        SELECT lo.order_number, lo.order_history_no, lo.project_code, lo.branch_code,
               lo.subcontractor_code, bp.partner_name AS subcontractor_name,
               lo.work_type_code, wt.work_type_name,
               CAST(lo.order_amount_tax_ex AS BIGINT) AS order_amount_tax_ex,
               COALESCE(a.accum_ex, 0) AS accum_assessed_amount_tax_ex,
               COALESCE(a.accum_tax, 0) AS accum_assessed_tax_amount,
               lo.tax_rate, lo.retainage_rate_num, lo.retainage_rate_den,
               lo.safety_assoc_rate_num, lo.safety_assoc_rate_den
        FROM latest_o lo
        JOIN business_partners bp
          ON bp.company_code = lo.company_code
         AND bp.partner_code = lo.subcontractor_code
         AND bp.is_deleted = FALSE
         AND bp.is_subcontractor = TRUE
        JOIN work_types wt
          ON wt.company_code = lo.company_code AND wt.work_type_code = lo.work_type_code
        LEFT JOIN assess_sum a
          ON a.company_code = lo.company_code AND a.order_number = lo.order_number
        ORDER BY lo.order_number
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;

    let mut subcontract_orders = Vec::with_capacity(ord_rows.len());
    for r in ord_rows {
        let order_amt: i64 = r.try_get("order_amount_tax_ex")?;
        let accum_ex: i64 = r.try_get("accum_assessed_amount_tax_ex")?;
        let accum_tax: i64 = r.try_get("accum_assessed_tax_amount")?;
        let rem = order_amt
            .checked_sub(accum_ex)
            .ok_or_else(|| ApiError::Unprocessable("発注残高の計算でオーバーフローが発生しました".to_string()))?;
        subcontract_orders.push(SubcontractOrderSummaryDto {
            order_number: r.try_get("order_number")?,
            order_history_no: r.try_get("order_history_no")?,
            project_code: r.try_get("project_code")?,
            branch_code: r.try_get("branch_code")?,
            subcontractor_code: r.try_get("subcontractor_code")?,
            subcontractor_name: r.try_get("subcontractor_name")?,
            work_type_code: r.try_get("work_type_code")?,
            work_type_name: r.try_get("work_type_name")?,
            order_amount_tax_ex: YenAmount(order_amt),
            accum_assessed_amount_tax_ex: YenAmount(accum_ex),
            accum_assessed_tax_amount: YenAmount(accum_tax),
            remaining_order_balance: YenAmount(rem),
            tax_rate: r.try_get("tax_rate")?,
            retainage_rate_num: Rate(r.try_get("retainage_rate_num")?),
            retainage_rate_den: Rate(r.try_get("retainage_rate_den")?),
            safety_assoc_rate_num: Rate(r.try_get("safety_assoc_rate_num")?),
            safety_assoc_rate_den: Rate(r.try_get("safety_assoc_rate_den")?),
        });
    }

    // 3. work_types (hierarchy_level = 3)
    let wt_rows = sqlx::query(
        r#"
        SELECT work_type_code, work_type_name
        FROM work_types
        WHERE company_code = $1 AND hierarchy_level = 3
        ORDER BY work_type_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut work_types = Vec::with_capacity(wt_rows.len());
    for r in wt_rows {
        work_types.push(WorkTypeLookupDto {
            work_type_code: r.try_get("work_type_code")?,
            work_type_name: r.try_get("work_type_name")?,
        });
    }

    // 4. employees (is_employee = TRUE AND is_deleted = FALSE)
    let emp_rows = sqlx::query(
        r#"
        SELECT partner_code, partner_name, CAST(standard_daily_wage AS BIGINT) AS standard_daily_wage
        FROM business_partners
        WHERE company_code = $1 AND is_employee = TRUE AND is_deleted = FALSE
        ORDER BY partner_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut employees = Vec::with_capacity(emp_rows.len());
    for r in emp_rows {
        employees.push(EmployeeLookupDto {
            employee_code: r.try_get("partner_code")?,
            employee_name: r.try_get("partner_name")?,
            standard_daily_wage: YenAmount(r.try_get("standard_daily_wage")?),
        });
    }

    // 5. suppliers (is_supplier = TRUE AND is_deleted = FALSE)
    let sup_rows = sqlx::query(
        r#"
        SELECT partner_code, partner_name
        FROM business_partners
        WHERE company_code = $1 AND is_supplier = TRUE AND is_deleted = FALSE
        ORDER BY partner_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut suppliers = Vec::with_capacity(sup_rows.len());
    for r in sup_rows {
        suppliers.push(SupplierLookupDto {
            partner_code: r.try_get("partner_code")?,
            partner_name: r.try_get("partner_name")?,
        });
    }

    // 6. equipments
    let eq_rows = sqlx::query(
        r#"
        SELECT equipment_code, equipment_name, unit, daily_rent_price
        FROM construction_equipment_masters
        WHERE company_code = $1
        ORDER BY equipment_code
        "#,
    )
    .bind(&company_code)
    .fetch_all(&state.pool)
    .await?;
    let mut equipments = Vec::with_capacity(eq_rows.len());
    for r in eq_rows {
        equipments.push(EquipmentLookupDto {
            equipment_code: r.try_get("equipment_code")?,
            equipment_name: r.try_get("equipment_name")?,
            unit: r.try_get("unit")?,
            daily_rent_price: UnitPrice(r.try_get("daily_rent_price")?),
        });
    }

    Ok(Json(LookupsDto {
        quick_templates,
        subcontract_orders,
        work_types,
        employees,
        suppliers,
        equipments,
    }))
}
