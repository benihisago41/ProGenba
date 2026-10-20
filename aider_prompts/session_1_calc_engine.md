# Session 1: 決定論的・工事原価計算エンジンの実装 (`calc.rs`)

あなたは建設原価管理システム「Project Sirius Reborn」のコア計算エンジン担当エンジニアです。
Read-Onlyで提供された `CONVENTIONS.md` および `backend/src/domain/types.rs` の型定義に100%従い、`backend/src/domain/calc.rs` と `backend/src/lib.rs` を実装してください。

## 厳守ルール
1. `backend/src/domain/types.rs` はロック済アンカーです。変更しないでください。
2. `f32` / `f64` は一切使用禁止です。すべての計算は `rust_decimal::Decimal` および `YenAmount(i64)` で行ってください。
3. 経理・複式仕訳に関するコードは一切書かないでください。

## 実装する関数 (`backend/src/domain/calc.rs`)

1. **`pub fn calc_line_amount(qty: Quantity, unit_price: UnitPrice) -> YenAmount`**
   - `qty.0 * unit_price.0` を計算し、小数第1位を四捨五入（`RoundingStrategy::MidpointAwayFromZero`）して整数円 `YenAmount` を返す。

2. **`pub fn calc_subcontract_assessment(input: &AssessmentCalcInput) -> Result<AssessmentCalcOutput, String>`**
   - `CONVENTIONS.md` §3.2 のパイプラインを厳密に実装すること：
     - `accum_assessed_amount_tax_ex = input.prev_accum_assessed_tax_ex.0 + input.curr_assessed_tax_ex.0`
     - **消費税（累計差額方式・端数切捨）**:
       `accum_tax_curr = floor(Decimal::from(accum_assessed_amount_tax_ex) * input.tax_rate)`
       `curr_assessed_tax_amount = accum_tax_curr - input.prev_accum_tax_amount.0`
     - **保留金控除額（端数切捨）**:
       `curr_retainage_deduction = floor(Decimal::from(input.curr_assessed_tax_ex.0) * input.retainage_rate_num.0 / input.retainage_rate_den.0)`
     - **安全協力会費控除額（端数切捨）**:
       `curr_safety_assoc_deduction = floor(Decimal::from(input.curr_assessed_tax_ex.0) * input.safety_assoc_rate_num.0 / input.safety_assoc_rate_den.0)`
     - **総控除額**:
       `total_deduction_amount = curr_retainage_deduction + curr_safety_assoc_deduction + input.fixed_deductions.0 + input.chargeback_offset.0`
     - **差引支払実額**:
       `net_payment_amount = (input.curr_assessed_tax_ex.0 + curr_assessed_tax_amount) - total_deduction_amount`
     - **発注残高**:
       `remaining_order_balance = input.order_amount_tax_ex.0 - accum_assessed_amount_tax_ex`

3. **`pub fn allocate_monthly_labor_cost(total_wage: YenAmount, sites: &[SiteWorkHours]) -> Result<Vec<AllocatedLaborCost>, String>`**
   - `CONVENTIONS.md` §3.3 の労務費出面按分アルゴリズムを実装すること：
     - 総工数 `total_hours = sum(sites[i].hours.0)` が 0 以下の場合は `Err` を返す。
     - 各現場の基礎配賦額 `base_cost_i = floor(Decimal::from(total_wage.0) * sites[i].hours.0 / total_hours)`。
     - 端数差額 `delta = total_wage.0 - sum(base_cost_i)` を、`hours` が最大の現場（同数の場合は最初に出現したインデックス）に加算し、配賦後の合計が `total_wage` と1円の狂いもなく一致することを保証する。

4. **`pub fn calc_daily_labor_cost(standard_daily_wage: YenAmount, work_hours: Quantity) -> YenAmount`**
   - `Decimal::from(standard_daily_wage.0) * work_hours.0 / Decimal::from(8)` を小数第1位四捨五入（`MidpointAwayFromZero`）して `YenAmount` を返す。

5. **`pub fn calc_equipment_movement_cost(qty: Quantity, daily_rent_price: UnitPrice, usage_days: i32, freight_fee: YenAmount, maintenance_fee: YenAmount) -> YenAmount`**
   - `round_half_up(qty.0 * daily_rent_price.0 * Decimal::from(usage_days)) + freight_fee.0 + maintenance_fee.0` を返す。

## 必須単体テスト (`#[cfg(test)] mod tests`)
以下の検証ケースを必ず `calc.rs` 内に実装し、`cargo test` がパスすることを確認してください：
- **テストケース1（出来高査定・控除検証）**:
  - 発注額 `10,000,000` 円、前回累計 `0` 円、今回査定税抜 `3,000,000` 円、税率 `0.10`、保留金率 `10 / 100`、安全協力会費率 `3 / 1000`、固定控除 `5,000` 円、相殺 `0` 円
  - 期待値：今回消費税 = `300,000` 円、保留金 = `300,000` 円、安全協力会費 = `9,000` 円、総控除 = `314,000` 円、差引支払実額 = `2,986,000` 円、発注残高 = `7,000,000` 円、計上外注実原価 = `3,000,000` 円。
- **テストケース2（消費税累計差額方式の端数ズレ防止検証）**:
  - 3回分割査定で端数が出るケースにおいて、累計税抜×10%と各回消費税合計が1円のズレもなく一致すること。
- **テストケース3（労務費出面按分と端数寄先検証）**:
  - 月次総賃金 `400,000` 円を 現場A(`30.0h`), 現場B(`50.0h`), 現場C(`30.0h`)（計 `110.0h`）で按分した際、端数差額が最多工数の現場Bへ加算され、3現場の配賦額合計が厳密に `400,000` 円になること。

## 管理者による確定補足
- この回の編集は backend/src/domain/mod.rs, backend/src/domain/calc.rs, backend/src/lib.rs の3ファイルのみ。他の変更を戻さず、アンカー・依存・試験ファイルを変更しない。コマンド、コミット、pushを実行しない。
- lib.rsは pub mod domain; とし、後続APIで参照できるようにする。Phase 0の仮contract_typesモジュールは不要。
- calc_subcontract_assessmentは負金額、不正累計、今回+前回>契約額、控除超過、税率負数、分子負数、分母0以下、整数オーバーフローでErr。金額15桁超もErr。税は累計差額、控除前税抜を原価とする。
- allocate_monthly_labor_costは空配列・負賃金・負工数・総工数0をErr。0工数現場は0円、最多同数時は先頭、checked演算で合計一致を保証。
- 既定シグネチャを維持する非Result関数には適用可能範囲の前提をdocコメントで明記し、内部でchecked演算を使う。API側で積と合計がDB金額範囲内かを確認してから呼ぶ。
- 必須3試験に加え、四捨五入境界、ゼロ分母、発注超過、控除超過、負数、総工数0、同数最多工数、標準日額22000×4時間=11000、機械損料120×2×3+1000+200=1920を単体テストに追加。
- 既存のNUMERIC型・率・DTOは変更しない。Decimalにto_f64などを使わない。
