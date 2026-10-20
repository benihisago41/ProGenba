// ============================================================================
// backend/src/domain/calc.rs — 決定論的・工事原価計算エンジン
// ※f32 / f64 の使用は全面禁止。すべての計算は Decimal および YenAmount(i64) で行う。
// ============================================================================

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};

use crate::domain::types::{
    AllocatedLaborCost, AssessmentCalcInput, AssessmentCalcOutput, Quantity, SiteWorkHours,
    UnitPrice, YenAmount,
};

/// DB NUMERIC(15,0) の最大絶対値（999,999,999,999,999円）
pub const MAX_YEN_ABS: i64 = 999_999_999_999_999;

fn validate_yen_15_digits(amount: i64, label: &str) -> Result<i64, String> {
    if amount.unsigned_abs() > MAX_YEN_ABS as u64 {
        return Err(format!("{}が15桁上限を超えています: {}", label, amount));
    }
    Ok(amount)
}

fn validate_non_negative_yen(amount: YenAmount, label: &str) -> Result<i64, String> {
    if amount.0 < 0 {
        return Err(format!("{}に負数は指定できません: {}", label, amount.0));
    }
    validate_yen_15_digits(amount.0, label)
}

fn decimal_floor_to_i64(val: Decimal, label: &str) -> Result<i64, String> {
    let floored = val.floor();
    let n = floored
        .to_i64()
        .ok_or_else(|| format!("{}の整数変換でオーバーフローが発生しました", label))?;
    validate_yen_15_digits(n, label)
}

/// 明細金額の算出（小数第1位を四捨五入 `MidpointAwayFromZero` して整数円 `YenAmount` に変換）
///
/// # 前提条件 (Preconditions)
/// - 呼び出し側（APIバリデーション層）にて、`qty.0 * unit_price.0` の積が
///   DB `NUMERIC(15,0)` の範囲（`±999,999,999,999,999` 円）内に収まることを確認してから呼び出すこと。
/// - 内部では `checked_mul` を使用し、万が一のオーバーフロー時はパニックにより不正値の混入を防止する。
pub fn calc_line_amount(qty: Quantity, unit_price: UnitPrice) -> YenAmount {
    let product = qty
        .0
        .checked_mul(unit_price.0)
        .expect("calc_line_amount: 数量×単価の乗算でオーバーフローが発生しました");
    let rounded = product.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    let yen = rounded
        .to_i64()
        .expect("calc_line_amount: Decimalからi64への変換に失敗しました");
    assert!(
        yen.unsigned_abs() <= MAX_YEN_ABS as u64,
        "calc_line_amount: 金額がDB NUMERIC(15,0)の範囲を超過しました"
    );
    YenAmount(yen)
}

/// 下請出来高査定および控除計算パイプライン（CONVENTIONS.md §3.2）
///
/// - 消費税は累計差額方式・端数切捨で算出する。
/// - 保留金・安全協力会費は今回査定税抜額に対する端数切捨で算出する。
/// - 工事台帳へ計上する外注実発生原価は、控除前の `curr_assessed_tax_ex`（税抜出来高）とする。
pub fn calc_subcontract_assessment(
    input: &AssessmentCalcInput,
) -> Result<AssessmentCalcOutput, String> {
    // 1. 金額の非負・15桁範囲チェック
    let order_tax_ex = validate_non_negative_yen(input.order_amount_tax_ex, "発注契約税抜額")?;
    let prev_accum_tax_ex =
        validate_non_negative_yen(input.prev_accum_assessed_tax_ex, "前回迄査定累計税抜額")?;
    let prev_accum_tax =
        validate_non_negative_yen(input.prev_accum_tax_amount, "前回迄消費税累計額")?;
    let curr_tax_ex = validate_non_negative_yen(input.curr_assessed_tax_ex, "今回査定税抜額")?;
    let fixed_deductions = validate_non_negative_yen(input.fixed_deductions, "定額控除額")?;
    let chargeback_offset = validate_non_negative_yen(input.chargeback_offset, "立替相殺額")?;

    if prev_accum_tax_ex > order_tax_ex {
        return Err("前回迄査定累計税抜額が発注契約税抜額を超過しています".to_string());
    }

    // 2. 率の検証（税率 >= 0, 分子 >= 0, 分母 > 0）
    if input.tax_rate < Decimal::ZERO {
        return Err("消費税率に負数は指定できません".to_string());
    }
    if input.retainage_rate_num.0 < Decimal::ZERO {
        return Err("保留金率の分子に負数は指定できません".to_string());
    }
    if input.retainage_rate_den.0 <= Decimal::ZERO {
        return Err("保留金率の分母は正数である必要があります".to_string());
    }
    if input.safety_assoc_rate_num.0 < Decimal::ZERO {
        return Err("安全協力会費率の分子に負数は指定できません".to_string());
    }
    if input.safety_assoc_rate_den.0 <= Decimal::ZERO {
        return Err("安全協力会費率の分母は正数である必要があります".to_string());
    }

    // 前回累計消費税の妥当性検証
    let expected_prev_max_tax = Decimal::from(prev_accum_tax_ex)
        .checked_mul(input.tax_rate)
        .ok_or_else(|| "前回累計消費税の検証でオーバーフローが発生しました".to_string())?;
    let expected_prev_tax_floor = decimal_floor_to_i64(expected_prev_max_tax, "前回累計消費税上限")?;
    if prev_accum_tax > expected_prev_tax_floor {
        return Err("前回迄消費税累計額が不正です".to_string());
    }

    // 3. 累計査定税抜額・発注残高チェック
    let accum_assessed_amount_tax_ex = prev_accum_tax_ex
        .checked_add(curr_tax_ex)
        .ok_or_else(|| "累計査定税抜額の加算でオーバーフローが発生しました".to_string())?;
    validate_yen_15_digits(accum_assessed_amount_tax_ex, "累計査定税抜額")?;

    if accum_assessed_amount_tax_ex > order_tax_ex {
        return Err(format!(
            "累計査定税抜額({})が発注契約税抜額({})を超過しています",
            accum_assessed_amount_tax_ex, order_tax_ex
        ));
    }

    let remaining_order_balance = order_tax_ex
        .checked_sub(accum_assessed_amount_tax_ex)
        .ok_or_else(|| "発注残高の減算でオーバーフローが発生しました".to_string())?;

    // 4. 消費税額（累計差額方式・端数切捨）
    let accum_tax_dec = Decimal::from(accum_assessed_amount_tax_ex)
        .checked_mul(input.tax_rate)
        .ok_or_else(|| "累計消費税計算でオーバーフローが発生しました".to_string())?;
    let accum_assessed_tax_amount = decimal_floor_to_i64(accum_tax_dec, "累計消費税額")?;

    let curr_assessed_tax_amount = accum_assessed_tax_amount
        .checked_sub(prev_accum_tax)
        .ok_or_else(|| "今回消費税額の減算でオーバーフローが発生しました".to_string())?;
    if curr_assessed_tax_amount < 0 {
        return Err("今回消費税額が負数となりました（前回累計税額が不整合です）".to_string());
    }

    // 5. 保留金控除額（端数切捨）
    let curr_dec = Decimal::from(curr_tax_ex);
    let retainage_dec = curr_dec
        .checked_mul(input.retainage_rate_num.0)
        .ok_or_else(|| "保留金乗算でオーバーフローが発生しました".to_string())?
        .checked_div(input.retainage_rate_den.0)
        .ok_or_else(|| "保留金除算に失敗しました".to_string())?;
    let curr_retainage_deduction = decimal_floor_to_i64(retainage_dec, "保留金控除額")?;

    // 6. 安全協力会費控除額（端数切捨）
    let safety_dec = curr_dec
        .checked_mul(input.safety_assoc_rate_num.0)
        .ok_or_else(|| "安全協力会費乗算でオーバーフローが発生しました".to_string())?
        .checked_div(input.safety_assoc_rate_den.0)
        .ok_or_else(|| "安全協力会費除算に失敗しました".to_string())?;
    let curr_safety_assoc_deduction = decimal_floor_to_i64(safety_dec, "安全協力会費控除額")?;

    // 7. 総控除額および差引支払実額
    let total_deduction_amount = curr_retainage_deduction
        .checked_add(curr_safety_assoc_deduction)
        .and_then(|v| v.checked_add(fixed_deductions))
        .and_then(|v| v.checked_add(chargeback_offset))
        .ok_or_else(|| "総控除額の合算でオーバーフローが発生しました".to_string())?;
    validate_yen_15_digits(total_deduction_amount, "総控除額")?;

    let gross_payable = curr_tax_ex
        .checked_add(curr_assessed_tax_amount)
        .ok_or_else(|| "今回税込査定額の合算でオーバーフローが発生しました".to_string())?;
    validate_yen_15_digits(gross_payable, "今回税込査定額")?;

    if total_deduction_amount > gross_payable {
        return Err(format!(
            "総控除額({})が今回税込査定額({})を超過しています",
            total_deduction_amount, gross_payable
        ));
    }

    let net_payment_amount = gross_payable
        .checked_sub(total_deduction_amount)
        .ok_or_else(|| "差引支払実額の計算でオーバーフローが発生しました".to_string())?;

    Ok(AssessmentCalcOutput {
        curr_assessed_amount_tax_ex: YenAmount(curr_tax_ex),
        curr_assessed_tax_amount: YenAmount(curr_assessed_tax_amount),
        accum_assessed_amount_tax_ex: YenAmount(accum_assessed_amount_tax_ex),
        accum_assessed_tax_amount: YenAmount(accum_assessed_tax_amount),
        curr_retainage_deduction: YenAmount(curr_retainage_deduction),
        curr_safety_assoc_deduction: YenAmount(curr_safety_assoc_deduction),
        total_deduction_amount: YenAmount(total_deduction_amount),
        net_payment_amount: YenAmount(net_payment_amount),
        remaining_order_balance: YenAmount(remaining_order_balance),
    })
}

/// 労務費（直営・出面日報）月次按分アルゴリズム（CONVENTIONS.md §3.3）
///
/// - 各現場の基礎配賦額を `floor(total_wage * hours_i / total_hours)` で算出する。
/// - 端数差額 `delta` は `hours` が最大の現場（同数の場合は先頭）に加算し、合計を `total_wage` と完全一致させる。
pub fn allocate_monthly_labor_cost(
    total_wage: YenAmount,
    sites: &[SiteWorkHours],
) -> Result<Vec<AllocatedLaborCost>, String> {
    if sites.is_empty() {
        return Err("按分対象の現場リストが空です".to_string());
    }
    let wage = validate_non_negative_yen(total_wage, "月次確定賃金総額")?;

    let mut total_hours = Decimal::ZERO;
    let mut max_hours = Decimal::ZERO;
    let mut max_index: usize = 0;

    for (idx, site) in sites.iter().enumerate() {
        if site.hours.0 < Decimal::ZERO {
            return Err(format!(
                "現場従事工数に負数は指定できません: {}",
                site.hours.0
            ));
        }
        total_hours = total_hours
            .checked_add(site.hours.0)
            .ok_or_else(|| "総工数の合算でオーバーフローが発生しました".to_string())?;

        // 同数の場合は最初に出現したインデックスを維持するため厳密な `>` で比較
        if idx == 0 || site.hours.0 > max_hours {
            max_hours = site.hours.0;
            max_index = idx;
        }
    }

    if total_hours <= Decimal::ZERO {
        return Err("総工数が0以下のため労務費を按分できません".to_string());
    }

    let wage_dec = Decimal::from(wage);
    let mut allocated_list = Vec::with_capacity(sites.len());
    let mut sum_base: i64 = 0;

    for site in sites {
        let base_cost = if site.hours.0.is_zero() || wage == 0 {
            0
        } else {
            let ratio_val = wage_dec
                .checked_mul(site.hours.0)
                .ok_or_else(|| "労務費按分の乗算でオーバーフローが発生しました".to_string())?
                .checked_div(total_hours)
                .ok_or_else(|| "労務費按分の除算に失敗しました".to_string())?;
            decimal_floor_to_i64(ratio_val, "基礎配賦額")?
        };

        sum_base = sum_base
            .checked_add(base_cost)
            .ok_or_else(|| "基礎配賦額の合算でオーバーフローが発生しました".to_string())?;

        allocated_list.push(AllocatedLaborCost {
            branch_key: site.branch_key.clone(),
            work_type_code: site.work_type_code.clone(),
            hours: site.hours,
            allocated_cost: YenAmount(base_cost),
        });
    }

    let delta = wage
        .checked_sub(sum_base)
        .ok_or_else(|| "端数差額の算出でオーバーフローが発生しました".to_string())?;

    let adjusted = allocated_list[max_index]
        .allocated_cost
        .0
        .checked_add(delta)
        .ok_or_else(|| "端数差額の加算でオーバーフローが発生しました".to_string())?;
    validate_yen_15_digits(adjusted, "端数調整後配賦額")?;
    allocated_list[max_index].allocated_cost = YenAmount(adjusted);

    // 合計完全一致の検証
    let final_sum = allocated_list.iter().try_fold(0i64, |acc, item| {
        acc.checked_add(item.allocated_cost.0)
            .ok_or_else(|| "最終配賦合計の検証でオーバーフローが発生しました".to_string())
    })?;
    if final_sum != wage {
        return Err("配賦後の合計金額が月次賃金総額と一致しません".to_string());
    }

    Ok(allocated_list)
}

/// 日次出面日報の概算労務原価算出（CONVENTIONS.md §3.3-4）
///
/// `round_half_up(standard_daily_wage * (work_hours / 8), 0)`
///
/// # 前提条件 (Preconditions)
/// - 呼び出し側（APIバリデーション層）にて、`standard_daily_wage` と `work_hours` が非負かつ
///   計算結果が DB `NUMERIC(15,0)` の範囲（`±999,999,999,999,999` 円）内であることを確認してから呼び出すこと。
/// - 内部では `checked_mul` / `checked_div` を使用し、オーバーフロー時はパニックにより不正値を防止する。
pub fn calc_daily_labor_cost(standard_daily_wage: YenAmount, work_hours: Quantity) -> YenAmount {
    let wage_dec = Decimal::from(standard_daily_wage.0);
    let eight = Decimal::from(8);
    let raw = wage_dec
        .checked_mul(work_hours.0)
        .expect("calc_daily_labor_cost: 日額×工数の乗算でオーバーフローが発生しました")
        .checked_div(eight)
        .expect("calc_daily_labor_cost: 8時間除算に失敗しました");
    let rounded = raw.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    let yen = rounded
        .to_i64()
        .expect("calc_daily_labor_cost: Decimalからi64への変換に失敗しました");
    assert!(
        yen.unsigned_abs() <= MAX_YEN_ABS as u64,
        "calc_daily_labor_cost: 金額がDB NUMERIC(15,0)の範囲を超過しました"
    );
    YenAmount(yen)
}

/// 資機材・機械損料の自動原価計算（CONVENTIONS.md §3.4）
///
/// `round_half_up(qty * daily_rent_price * usage_days, 0) + freight_fee + maintenance_fee`
///
/// # 前提条件 (Preconditions)
/// - 呼び出し側（APIバリデーション層）にて、数量・日額単価・使用日数・運賃・整備費が非負かつ
///   積および合計が DB `NUMERIC(15,0)` の範囲（`±999,999,999,999,999` 円）内であることを確認してから呼び出すこと。
/// - 内部では `checked_mul` / `checked_add` を使用し、オーバーフロー時はパニックにより不正値を防止する。
pub fn calc_equipment_movement_cost(
    qty: Quantity,
    daily_rent_price: UnitPrice,
    usage_days: i32,
    freight_fee: YenAmount,
    maintenance_fee: YenAmount,
) -> YenAmount {
    let days_dec = Decimal::from(usage_days);
    let rent_raw = qty
        .0
        .checked_mul(daily_rent_price.0)
        .and_then(|v| v.checked_mul(days_dec))
        .expect("calc_equipment_movement_cost: 損料乗算でオーバーフローが発生しました");
    let rent_rounded = rent_raw.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    let rent_yen = rent_rounded
        .to_i64()
        .expect("calc_equipment_movement_cost: Decimalからi64への変換に失敗しました");

    let total = rent_yen
        .checked_add(freight_fee.0)
        .and_then(|v| v.checked_add(maintenance_fee.0))
        .expect("calc_equipment_movement_cost: 運賃・整備費加算でオーバーフローが発生しました");
    assert!(
        total.unsigned_abs() <= MAX_YEN_ABS as u64,
        "calc_equipment_movement_cost: 金額がDB NUMERIC(15,0)の範囲を超過しました"
    );
    YenAmount(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::{ProjectBranchKey, Rate};
    use std::str::FromStr;

    fn dec(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn branch(project_code: &str, branch_code: &str) -> ProjectBranchKey {
        ProjectBranchKey {
            company_code: "0000".to_string(),
            project_code: project_code.to_string(),
            branch_code: branch_code.to_string(),
        }
    }

    // 必須テストケース1: 出来高査定・控除検証
    #[test]
    fn test_subcontract_assessment_standard_case() {
        let input = AssessmentCalcInput {
            order_amount_tax_ex: YenAmount(10_000_000),
            prev_accum_assessed_tax_ex: YenAmount(0),
            prev_accum_tax_amount: YenAmount(0),
            curr_assessed_tax_ex: YenAmount(3_000_000),
            tax_rate: dec("0.10"),
            retainage_rate_num: Rate(dec("10.00")),
            retainage_rate_den: Rate(dec("100.00")),
            safety_assoc_rate_num: Rate(dec("3.00")),
            safety_assoc_rate_den: Rate(dec("1000.00")),
            fixed_deductions: YenAmount(5_000),
            chargeback_offset: YenAmount(0),
        };

        let out = calc_subcontract_assessment(&input).expect("計算成功すること");
        assert_eq!(out.curr_assessed_amount_tax_ex, YenAmount(3_000_000));
        assert_eq!(out.curr_assessed_tax_amount, YenAmount(300_000));
        assert_eq!(out.accum_assessed_amount_tax_ex, YenAmount(3_000_000));
        assert_eq!(out.accum_assessed_tax_amount, YenAmount(300_000));
        assert_eq!(out.curr_retainage_deduction, YenAmount(300_000));
        assert_eq!(out.curr_safety_assoc_deduction, YenAmount(9_000));
        assert_eq!(out.total_deduction_amount, YenAmount(314_000));
        assert_eq!(out.net_payment_amount, YenAmount(2_986_000));
        assert_eq!(out.remaining_order_balance, YenAmount(7_000_000));
    }

    // 必須テストケース2: 消費税累計差額方式の端数ズレ防止検証（3回分割査定）
    #[test]
    fn test_subcontract_assessment_cumulative_tax_no_drift() {
        // 契約額 1,000円（10%税 = 100円）を 333円, 333円, 334円の3回で査定
        // 単発切捨だと 33 + 33 + 33 = 99円になるが、累計差額方式では 33 + 33 + 34 = 100円となる
        let order_amount = YenAmount(1_000);
        let steps = [YenAmount(333), YenAmount(333), YenAmount(334)];

        let mut prev_accum_ex = YenAmount::ZERO;
        let mut prev_accum_tax = YenAmount::ZERO;
        let mut sum_curr_tax = 0i64;

        for curr_ex in steps {
            let input = AssessmentCalcInput {
                order_amount_tax_ex: order_amount,
                prev_accum_assessed_tax_ex: prev_accum_ex,
                prev_accum_tax_amount: prev_accum_tax,
                curr_assessed_tax_ex: curr_ex,
                tax_rate: dec("0.10"),
                retainage_rate_num: Rate(dec("0.00")),
                retainage_rate_den: Rate(dec("100.00")),
                safety_assoc_rate_num: Rate(dec("0.00")),
                safety_assoc_rate_den: Rate(dec("1000.00")),
                fixed_deductions: YenAmount::ZERO,
                chargeback_offset: YenAmount::ZERO,
            };
            let out = calc_subcontract_assessment(&input).unwrap();
            sum_curr_tax += out.curr_assessed_tax_amount.0;
            prev_accum_ex = out.accum_assessed_amount_tax_ex;
            prev_accum_tax = out.accum_assessed_tax_amount;
        }

        assert_eq!(prev_accum_ex, YenAmount(1_000));
        assert_eq!(prev_accum_tax, YenAmount(100));
        assert_eq!(sum_curr_tax, 100);
    }

    // 必須テストケース3: 労務費出面按分と端数寄先検証
    #[test]
    fn test_allocate_monthly_labor_cost_largest_hours_gets_delta() {
        let total_wage = YenAmount(400_000);
        let sites = vec![
            SiteWorkHours {
                branch_key: branch("P001", "000"),
                work_type_code: "010001000100".to_string(),
                hours: Quantity(dec("30.000")),
            },
            SiteWorkHours {
                branch_key: branch("P002", "000"),
                work_type_code: "010001000100".to_string(),
                hours: Quantity(dec("50.000")),
            },
            SiteWorkHours {
                branch_key: branch("P003", "000"),
                work_type_code: "010001000100".to_string(),
                hours: Quantity(dec("30.000")),
            },
        ];

        let result = allocate_monthly_labor_cost(total_wage, &sites).expect("按分成功すること");
        assert_eq!(result.len(), 3);
        // 400,000 * 30 / 110 = 109,090.909... -> floor 109,090
        // 400,000 * 50 / 110 = 181,818.181... -> floor 181,818
        // 基礎合計 = 109,090 + 181,818 + 109,090 = 399,998 (delta = +2)
        // 最多工数の現場B(index 1) に +2 され 181,820 になる
        assert_eq!(result[0].allocated_cost, YenAmount(109_090));
        assert_eq!(result[1].allocated_cost, YenAmount(181_820));
        assert_eq!(result[2].allocated_cost, YenAmount(109_090));

        let sum: i64 = result.iter().map(|r| r.allocated_cost.0).sum();
        assert_eq!(sum, 400_000);
    }

    // 追加テスト: 四捨五入境界（MidpointAwayFromZero）
    #[test]
    fn test_calc_line_amount_rounding_boundary() {
        // 1.005 * 100 = 100.5 -> 四捨五入で 101円
        let amt1 = calc_line_amount(Quantity(dec("1.005")), UnitPrice(dec("100.000")));
        assert_eq!(amt1, YenAmount(101));

        // 1.004 * 100 = 100.4 -> 四捨五入で 100円
        let amt2 = calc_line_amount(Quantity(dec("1.004")), UnitPrice(dec("100.000")));
        assert_eq!(amt2, YenAmount(100));
    }

    // 追加テスト: ゼロ分母・発注超過・控除超過・負数エラー検証
    #[test]
    fn test_subcontract_assessment_error_cases() {
        let base = AssessmentCalcInput {
            order_amount_tax_ex: YenAmount(1_000_000),
            prev_accum_assessed_tax_ex: YenAmount(800_000),
            prev_accum_tax_amount: YenAmount(80_000),
            curr_assessed_tax_ex: YenAmount(100_000),
            tax_rate: dec("0.10"),
            retainage_rate_num: Rate(dec("10.00")),
            retainage_rate_den: Rate(dec("100.00")),
            safety_assoc_rate_num: Rate(dec("3.00")),
            safety_assoc_rate_den: Rate(dec("1000.00")),
            fixed_deductions: YenAmount(0),
            chargeback_offset: YenAmount(0),
        };

        // ゼロ分母
        let mut zero_den = base.clone();
        zero_den.retainage_rate_den = Rate(dec("0.00"));
        assert!(calc_subcontract_assessment(&zero_den).is_err());

        // 発注超過 (800,000 + 300,000 > 1,000,000)
        let mut over_order = base.clone();
        over_order.curr_assessed_tax_ex = YenAmount(300_000);
        assert!(calc_subcontract_assessment(&over_order).is_err());

        // 控除超過 (税込110,000に対し固定控除200,000)
        let mut over_deduct = base.clone();
        over_deduct.fixed_deductions = YenAmount(200_000);
        assert!(calc_subcontract_assessment(&over_deduct).is_err());

        // 負数金額
        let mut neg_curr = base.clone();
        neg_curr.curr_assessed_tax_ex = YenAmount(-1);
        assert!(calc_subcontract_assessment(&neg_curr).is_err());

        // 15桁超過
        let mut over_15 = base;
        over_15.order_amount_tax_ex = YenAmount(1_000_000_000_000_000);
        assert!(calc_subcontract_assessment(&over_15).is_err());
    }

    // 追加テスト: 労務費按分の総工数0・負数・同数最多工数（先頭優先）
    #[test]
    fn test_allocate_monthly_labor_cost_tie_and_errors() {
        // 同数最多工数（30h, 50h, 50h -> index 1が先頭最多）
        let sites = vec![
            SiteWorkHours {
                branch_key: branch("P001", "000"),
                work_type_code: "010001000100".to_string(),
                hours: Quantity(dec("30.000")),
            },
            SiteWorkHours {
                branch_key: branch("P002", "000"),
                work_type_code: "010001000100".to_string(),
                hours: Quantity(dec("50.000")),
            },
            SiteWorkHours {
                branch_key: branch("P003", "000"),
                work_type_code: "010001000100".to_string(),
                hours: Quantity(dec("50.000")),
            },
        ];
        // 100,000 / 130h:
        // 30h -> floor(23076.92) = 23,076
        // 50h -> floor(38461.53) = 38,461
        // sum_base = 23,076 + 38,461 + 38,461 = 99,998 (delta = +2)
        // index 1 に +2 -> 38,463, index 2 は 38,461
        let res = allocate_monthly_labor_cost(YenAmount(100_000), &sites).unwrap();
        assert_eq!(res[0].allocated_cost, YenAmount(23_076));
        assert_eq!(res[1].allocated_cost, YenAmount(38_463));
        assert_eq!(res[2].allocated_cost, YenAmount(38_461));

        // 総工数0はErr
        let zero_sites = vec![SiteWorkHours {
            branch_key: branch("P001", "000"),
            work_type_code: "010001000100".to_string(),
            hours: Quantity(dec("0.000")),
        }];
        assert!(allocate_monthly_labor_cost(YenAmount(100_000), &zero_sites).is_err());

        // 負工数はErr
        let neg_sites = vec![SiteWorkHours {
            branch_key: branch("P001", "000"),
            work_type_code: "010001000100".to_string(),
            hours: Quantity(dec("-1.000")),
        }];
        assert!(allocate_monthly_labor_cost(YenAmount(100_000), &neg_sites).is_err());
    }

    // 追加テスト: 標準日額 22,000円 × 4時間 = 11,000円、機械損料 120 × 2 × 3 + 1000 + 200 = 1,920円
    #[test]
    fn test_daily_labor_and_equipment_cost() {
        let daily_cost = calc_daily_labor_cost(YenAmount(22_000), Quantity(dec("4.000")));
        assert_eq!(daily_cost, YenAmount(11_000));

        let equip_cost = calc_equipment_movement_cost(
            Quantity(dec("2.000")),
            UnitPrice(dec("120.000")),
            3,
            YenAmount(1_000),
            YenAmount(200),
        );
        assert_eq!(equip_cost, YenAmount(1_920));
    }
}
