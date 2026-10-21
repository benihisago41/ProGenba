import Decimal from "decimal.js";
import { CostElementBreakdown, ProjectCostCockpitDto, WorkTypeCostRow } from "./bindings";

const MAX_SAFE_YEN_DEC = new Decimal(Number.MAX_SAFE_INTEGER);
export function toSafeYenNumber(dec: Decimal, label: string): number {
  if (!dec.isInteger() || dec.abs().greaterThan(MAX_SAFE_YEN_DEC) || !Number.isSafeInteger(dec.toNumber())) {
    throw new Error(`${label}の合算金額が表示可能な安全整数上限を超えました。本工事・追加工事を個別に選択して確認してください。`);
  }
  return dec.toNumber();
}
export function formatYen(amount: number): string {
  const dec = new Decimal(amount);
  return `${dec.isNegative() ? "−" : ""}¥${dec.abs().toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
export function calcRatePercent(numerator: Decimal, denominator: Decimal): string {
  return denominator.lte(0) ? "0.00" : numerator.mul(100).div(denominator).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
export function progressValue(rate: string) { return Decimal.max(0, Decimal.min(100, new Decimal(rate))).div(100).toNumber(); }

export function buildAllBranchesViewData(branches: ProjectCostCockpitDto[]): ProjectCostCockpitDto | null {
  const first = branches[0]; if (!first) return null;
  let contract = new Decimal(0), budget = new Decimal(0), ordered = new Decimal(0), actual = new Decimal(0), forecastCost = new Decimal(0), forecastProfit = new Decimal(0);
  const breakdown: Record<keyof CostElementBreakdown, Decimal> = { material_cost: new Decimal(0), labor_cost: new Decimal(0), subcontract_cost: new Decimal(0), expense_cost: new Decimal(0), equipment_cost: new Decimal(0), total_cost: new Decimal(0) };
  const workTypes = new Map<string, { name: string; budget: Decimal; ordered: Decimal; actual: Decimal; remaining: Decimal }>();
  for (const b of branches) {
    contract = contract.plus(b.contract_amount_tax_ex); budget = budget.plus(b.execution_budget_amount);
    ordered = ordered.plus(b.ordered_committed_amount); actual = actual.plus(b.actual_occurred_cost);
    forecastCost = forecastCost.plus(b.forecast_final_cost); forecastProfit = forecastProfit.plus(b.forecast_gross_profit);
    for (const key of Object.keys(breakdown) as (keyof CostElementBreakdown)[]) breakdown[key] = breakdown[key].plus(b.actual_breakdown[key]);
    for (const row of b.by_work_type) {
      const previous = workTypes.get(row.work_type_code);
      workTypes.set(row.work_type_code, { name: row.work_type_name, budget: (previous?.budget ?? new Decimal(0)).plus(row.budget_amount), ordered: (previous?.ordered ?? new Decimal(0)).plus(row.ordered_amount), actual: (previous?.actual ?? new Decimal(0)).plus(row.actual_cost), remaining: (previous?.remaining ?? new Decimal(0)).plus(row.remaining_budget) });
    }
  }
  const by_work_type: WorkTypeCostRow[] = Array.from(workTypes.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([code, row]) => ({ work_type_code: code, work_type_name: row.name, budget_amount: toSafeYenNumber(row.budget, "工種別実行予算額"), ordered_amount: toSafeYenNumber(row.ordered, "工種別発注済額"), actual_cost: toSafeYenNumber(row.actual, "工種別実際発生原価"), remaining_budget: toSafeYenNumber(row.remaining, "工種別予算残高"), consumption_rate_percent: calcRatePercent(row.actual, row.budget) }));
  return {
    ...first, key: { ...first.key, branch_code: "__ALL__" }, branch_name: `工事全体（${branches.length}件の合算）`,
    completion_status: branches.some(b => b.completion_status === "0") ? "0" : branches.some(b => b.completion_status === "1") ? "1" : first.completion_status,
    contract_amount_tax_ex: toSafeYenNumber(contract, "請負契約額"), execution_budget_amount: toSafeYenNumber(budget, "実行予算額"), ordered_committed_amount: toSafeYenNumber(ordered, "発注・確定済額"), actual_occurred_cost: toSafeYenNumber(actual, "実際発生原価"), forecast_final_cost: toSafeYenNumber(forecastCost, "着地予想原価"), forecast_gross_profit: toSafeYenNumber(forecastProfit, "見込粗利額"), forecast_profit_rate: calcRatePercent(forecastProfit, contract),
    is_budget_exceeded: branches.some(b => b.is_budget_exceeded) || ordered.gt(budget) || actual.gt(budget) || forecastCost.gt(budget),
    requires_supervising_engineer_warning: branches.some(b => b.requires_supervising_engineer_warning),
    actual_breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, toSafeYenNumber(value, key)])) as unknown as CostElementBreakdown,
    by_work_type,
  };
}
export function workTypeTotals(rows: WorkTypeCostRow[]) {
  let budget = new Decimal(0), ordered = new Decimal(0), actual = new Decimal(0), remaining = new Decimal(0);
  for (const row of rows) { budget = budget.plus(row.budget_amount); ordered = ordered.plus(row.ordered_amount); actual = actual.plus(row.actual_cost); remaining = remaining.plus(row.remaining_budget); }
  return { budget_amount: toSafeYenNumber(budget, "工種合計（実行予算額）"), ordered_amount: toSafeYenNumber(ordered, "工種合計（発注済額）"), actual_cost: toSafeYenNumber(actual, "工種合計（実際発生原価）"), remaining_budget: toSafeYenNumber(remaining, "工種合計（予算残高）"), consumption_rate_percent: calcRatePercent(actual, budget) };
}
