import React, { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import {
  CompletionStatus,
  CostElementBreakdown,
  ProjectCostCockpitDto,
  WorkTypeCostRow,
} from "./bindings";

export interface CockpitViewProps {
  projects: ProjectCostCockpitDto[];
}

const ALL_BRANCHES_KEY = "__ALL__";
const MAX_SAFE_YEN_DEC = new Decimal(Number.MAX_SAFE_INTEGER);

function toSafeYenNumber(dec: Decimal, label: string): number {
  if (!dec.isInteger() || dec.abs().greaterThan(MAX_SAFE_YEN_DEC)) {
    throw new Error(
      `${label}の合算金額が表示可能な安全整数上限を超えました。各工事枝番（本工事・追加工事）を個別に選択して確認してください。`
    );
  }
  const num = dec.toNumber();
  if (!Number.isSafeInteger(num)) {
    throw new Error(
      `${label}の合算金額が表示可能な安全整数上限を超えました。各工事枝番（本工事・追加工事）を個別に選択して確認してください。`
    );
  }
  return num;
}

function formatYen(amount: number): string {
  const dec = new Decimal(amount);
  const isNeg = dec.isNegative();
  const absStr = dec.abs().toFixed(0);
  const withCommas = absStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return isNeg ? `-¥${withCommas}` : `¥${withCommas}`;
}

function formatPercent(rateStr: string): string {
  try {
    return `${new Decimal(rateStr).toFixed(2)}%`;
  } catch {
    return "0.00%";
  }
}

function calcRatePercent(numerator: Decimal, denominator: Decimal): string {
  if (denominator.isZero() || denominator.isNegative()) {
    return "0.00";
  }
  return numerator
    .mul(100)
    .div(denominator)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

function clampProgressWidth(rateStr: string): number {
  try {
    const val = new Decimal(rateStr);
    if (val.isNegative()) return 0;
    if (val.greaterThan(100)) return 100;
    return val.toNumber();
  } catch {
    return 0;
  }
}

function isOver100Percent(rateStr: string): boolean {
  try {
    return new Decimal(rateStr).greaterThan(100);
  } catch {
    return false;
  }
}

function getCompletionBadge(status: CompletionStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "0":
      return { label: "施工中（未成）", className: "status-badge status-0" };
    case "1":
      return { label: "当期完成（入力時注意）", className: "status-badge status-1" };
    case "2":
      return { label: "前期完成（登録ロック）", className: "status-badge status-2" };
    case "3":
      return { label: "計上ロック済", className: "status-badge status-3" };
  }
}

function getBranchDisplayLabel(branchCode: string, branchName: string): string {
  const prefix = branchCode === "000" ? "本工事" : `追加工事(${branchCode})`;
  if (!branchName || branchName === prefix) {
    return `${prefix} [${branchCode}]`;
  }
  return `${prefix}：${branchName}`;
}

interface AggregatedCockpitViewData {
  mode: "single" | "all";
  projectCode: string;
  projectName: string;
  branchCode: string;
  branchTitle: string;
  completionStatus: CompletionStatus;
  budgetRevLabel: string;
  contractAmountTaxEx: number;
  executionBudgetAmount: number;
  orderedCommittedAmount: number;
  actualOccurredCost: number;
  forecastFinalCost: number;
  forecastGrossProfit: number;
  forecastProfitRate: string;
  isBudgetExceeded: boolean;
  requiresSupervisingEngineerWarning: boolean;
  actualBreakdown: CostElementBreakdown;
  byWorkType: WorkTypeCostRow[];
}

function buildSingleViewData(dto: ProjectCostCockpitDto): AggregatedCockpitViewData {
  return {
    mode: "single",
    projectCode: dto.key.project_code,
    projectName: dto.project_name,
    branchCode: dto.key.branch_code,
    branchTitle: getBranchDisplayLabel(dto.key.branch_code, dto.branch_name),
    completionStatus: dto.completion_status,
    budgetRevLabel: `Rev.${dto.latest_budget_history_no}`,
    contractAmountTaxEx: dto.contract_amount_tax_ex,
    executionBudgetAmount: dto.execution_budget_amount,
    orderedCommittedAmount: dto.ordered_committed_amount,
    actualOccurredCost: dto.actual_occurred_cost,
    forecastFinalCost: dto.forecast_final_cost,
    forecastGrossProfit: dto.forecast_gross_profit,
    forecastProfitRate: new Decimal(dto.forecast_profit_rate).toFixed(2),
    isBudgetExceeded: dto.is_budget_exceeded,
    requiresSupervisingEngineerWarning: dto.requires_supervising_engineer_warning,
    actualBreakdown: dto.actual_breakdown,
    byWorkType: dto.by_work_type,
  };
}

function buildAllBranchesViewData(
  branches: ProjectCostCockpitDto[]
): AggregatedCockpitViewData | null {
  const first = branches[0];
  if (!first) return null;

  let contractDec = new Decimal(0);
  let budgetDec = new Decimal(0);
  let orderedDec = new Decimal(0);
  let actualDec = new Decimal(0);
  let forecastCostDec = new Decimal(0);
  let forecastProfitDec = new Decimal(0);

  let matDec = new Decimal(0);
  let labDec = new Decimal(0);
  let subDec = new Decimal(0);
  let expDec = new Decimal(0);
  let eqpDec = new Decimal(0);
  let totalBreakdownDec = new Decimal(0);

  let anyBudgetExceeded = false;
  let anyEngineerWarning = false;

  const workTypeMap = new Map<
    string,
    {
      work_type_code: string;
      work_type_name: string;
      budget: Decimal;
      ordered: Decimal;
      actual: Decimal;
      remaining: Decimal;
    }
  >();

  for (const b of branches) {
    contractDec = contractDec.plus(b.contract_amount_tax_ex);
    budgetDec = budgetDec.plus(b.execution_budget_amount);
    orderedDec = orderedDec.plus(b.ordered_committed_amount);
    actualDec = actualDec.plus(b.actual_occurred_cost);
    forecastCostDec = forecastCostDec.plus(b.forecast_final_cost);
    forecastProfitDec = forecastProfitDec.plus(b.forecast_gross_profit);

    matDec = matDec.plus(b.actual_breakdown.material_cost);
    labDec = labDec.plus(b.actual_breakdown.labor_cost);
    subDec = subDec.plus(b.actual_breakdown.subcontract_cost);
    expDec = expDec.plus(b.actual_breakdown.expense_cost);
    eqpDec = eqpDec.plus(b.actual_breakdown.equipment_cost);
    totalBreakdownDec = totalBreakdownDec.plus(b.actual_breakdown.total_cost);

    if (b.is_budget_exceeded) anyBudgetExceeded = true;
    if (b.requires_supervising_engineer_warning) anyEngineerWarning = true;

    for (const row of b.by_work_type) {
      const existing = workTypeMap.get(row.work_type_code);
      if (existing) {
        existing.budget = existing.budget.plus(row.budget_amount);
        existing.ordered = existing.ordered.plus(row.ordered_amount);
        existing.actual = existing.actual.plus(row.actual_cost);
        existing.remaining = existing.remaining.plus(row.remaining_budget);
      } else {
        workTypeMap.set(row.work_type_code, {
          work_type_code: row.work_type_code,
          work_type_name: row.work_type_name,
          budget: new Decimal(row.budget_amount),
          ordered: new Decimal(row.ordered_amount),
          actual: new Decimal(row.actual_cost),
          remaining: new Decimal(row.remaining_budget),
        });
      }
    }
  }

  const combinedBudgetExceeded =
    anyBudgetExceeded ||
    orderedDec.greaterThan(budgetDec) ||
    actualDec.greaterThan(budgetDec) ||
    forecastCostDec.greaterThan(budgetDec);

  const forecastProfitRate = contractDec.greaterThan(0)
    ? forecastProfitDec
        .mul(100)
        .div(contractDec)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2)
    : "0.00";

  const aggregatedWorkTypes: WorkTypeCostRow[] = Array.from(workTypeMap.values())
    .sort((a, b) => a.work_type_code.localeCompare(b.work_type_code))
    .map((item) => ({
      work_type_code: item.work_type_code,
      work_type_name: item.work_type_name,
      budget_amount: toSafeYenNumber(item.budget, "工種別実行予算額"),
      ordered_amount: toSafeYenNumber(item.ordered, "工種別発注済額"),
      actual_cost: toSafeYenNumber(item.actual, "工種別実際発生原価"),
      remaining_budget: toSafeYenNumber(item.remaining, "工種別予算残高"),
      consumption_rate_percent: calcRatePercent(item.actual, item.budget),
    }));

  const hasActiveBranch = branches.some((b) => b.completion_status === "0");
  const hasCompletedWarningBranch = branches.some((b) => b.completion_status === "1");
  const representativeStatus: CompletionStatus = hasActiveBranch
    ? "0"
    : hasCompletedWarningBranch
      ? "1"
      : first.completion_status;

  return {
    mode: "all",
    projectCode: first.key.project_code,
    projectName: first.project_name,
    branchCode: ALL_BRANCHES_KEY,
    branchTitle: `全枝番合算（工事全体：全${branches.length}枝番）`,
    completionStatus: representativeStatus,
    budgetRevLabel: `全${branches.length}枝番合算`,
    contractAmountTaxEx: toSafeYenNumber(contractDec, "請負契約額"),
    executionBudgetAmount: toSafeYenNumber(budgetDec, "実行予算額"),
    orderedCommittedAmount: toSafeYenNumber(orderedDec, "発注・確定済額"),
    actualOccurredCost: toSafeYenNumber(actualDec, "実際発生原価"),
    forecastFinalCost: toSafeYenNumber(forecastCostDec, "着地予想原価"),
    forecastGrossProfit: toSafeYenNumber(forecastProfitDec, "見込粗利額"),
    forecastProfitRate,
    isBudgetExceeded: combinedBudgetExceeded,
    requiresSupervisingEngineerWarning: anyEngineerWarning,
    actualBreakdown: {
      material_cost: toSafeYenNumber(matDec, "材料費"),
      labor_cost: toSafeYenNumber(labDec, "労務費"),
      subcontract_cost: toSafeYenNumber(subDec, "外注費"),
      expense_cost: toSafeYenNumber(expDec, "現場経費"),
      equipment_cost: toSafeYenNumber(eqpDec, "機械損料"),
      total_cost: toSafeYenNumber(totalBreakdownDec, "原価5要素合計"),
    },
    byWorkType: aggregatedWorkTypes,
  };
}

export const CockpitView: React.FC<CockpitViewProps> = ({ projects }) => {
  const projectGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        projectCode: string;
        projectName: string;
        branches: ProjectCostCockpitDto[];
      }
    >();
    for (const item of projects) {
      const code = item.key.project_code;
      const existing = map.get(code);
      if (existing) {
        existing.branches.push(item);
      } else {
        map.set(code, {
          projectCode: code,
          projectName: item.project_name,
          branches: [item],
        });
      }
    }
    const list = Array.from(map.values());
    for (const group of list) {
      group.branches.sort((a, b) =>
        a.key.branch_code.localeCompare(b.key.branch_code)
      );
    }
    return list;
  }, [projects]);

  const [selectedProjectCode, setSelectedProjectCode] = useState<string>(() => {
    const first = projectGroups[0];
    return first ? first.projectCode : "";
  });

  const [selectedBranchKey, setSelectedBranchKey] = useState<string>("000");

  useEffect(() => {
    if (projectGroups.length === 0) {
      setSelectedProjectCode("");
      return;
    }
    const exists = projectGroups.some((g) => g.projectCode === selectedProjectCode);
    if (!exists) {
      const first = projectGroups[0];
      if (first) {
        setSelectedProjectCode(first.projectCode);
        const firstBranch = first.branches[0];
        setSelectedBranchKey(firstBranch ? firstBranch.key.branch_code : "000");
      }
    }
  }, [projectGroups, selectedProjectCode]);

  const currentProjectGroup = useMemo(() => {
    return (
      projectGroups.find((g) => g.projectCode === selectedProjectCode) ??
      projectGroups[0] ??
      null
    );
  }, [projectGroups, selectedProjectCode]);

  useEffect(() => {
    if (!currentProjectGroup) return;
    if (selectedBranchKey === ALL_BRANCHES_KEY) return;
    const branchExists = currentProjectGroup.branches.some(
      (b) => b.key.branch_code === selectedBranchKey
    );
    if (!branchExists) {
      const mainBranch =
        currentProjectGroup.branches.find((b) => b.key.branch_code === "000") ??
        currentProjectGroup.branches[0];
      if (mainBranch) {
        setSelectedBranchKey(mainBranch.key.branch_code);
      }
    }
  }, [currentProjectGroup, selectedBranchKey]);

  const activeResult = useMemo<{
    data: AggregatedCockpitViewData | null;
    error: string | null;
  }>(() => {
    if (!currentProjectGroup) return { data: null, error: null };
    try {
      if (selectedBranchKey === ALL_BRANCHES_KEY) {
        return {
          data: buildAllBranchesViewData(currentProjectGroup.branches),
          error: null,
        };
      }
      const targetBranch =
        currentProjectGroup.branches.find(
          (b) => b.key.branch_code === selectedBranchKey
        ) ?? currentProjectGroup.branches[0];
      if (!targetBranch) return { data: null, error: null };
      return { data: buildSingleViewData(targetBranch), error: null };
    } catch (err) {
      return {
        data: null,
        error:
          err instanceof Error
            ? err.message
            : "合算金額が安全に表示できる上限を超えたため表示できません。枝番単体を選択してください。",
      };
    }
  }, [currentProjectGroup, selectedBranchKey]);

  const workTypeTotalsResult = useMemo<{
    totals: {
      budget: number;
      ordered: number;
      actual: number;
      remaining: number;
      rate: string;
    } | null;
    error: string | null;
  }>(() => {
    const activeData = activeResult.data;
    if (!activeData) return { totals: null, error: null };
    try {
      let budget = new Decimal(0);
      let ordered = new Decimal(0);
      let actual = new Decimal(0);
      let remaining = new Decimal(0);
      for (const r of activeData.byWorkType) {
        budget = budget.plus(r.budget_amount);
        ordered = ordered.plus(r.ordered_amount);
        actual = actual.plus(r.actual_cost);
        remaining = remaining.plus(r.remaining_budget);
      }
      const rate = calcRatePercent(actual, budget);
      return {
        totals: {
          budget: toSafeYenNumber(budget, "工種合計（実行予算額）"),
          ordered: toSafeYenNumber(ordered, "工種合計（発注済額）"),
          actual: toSafeYenNumber(actual, "工種合計（実際発生原価）"),
          remaining: toSafeYenNumber(remaining, "工種合計（予算残高）"),
          rate,
        },
        error: null,
      };
    } catch (err) {
      return {
        totals: null,
        error:
          err instanceof Error
            ? err.message
            : "工種合計金額が安全に表示できる上限を超えました。",
      };
    }
  }, [activeResult.data]);

  if (!currentProjectGroup) {
    return (
      <div className="card state-box" role="status">
        <p style={{ margin: 0, fontWeight: 700 }}>
          表示可能な工事原価データがありません。
        </p>
      </div>
    );
  }

  const fallbackBranch =
    currentProjectGroup.branches.find((b) => b.key.branch_code === "000") ??
    currentProjectGroup.branches[0];

  const aggregationError = activeResult.error ?? workTypeTotalsResult.error;
  const activeData = activeResult.data;
  const workTypeTotals = workTypeTotalsResult.totals;

  if (aggregationError || !activeData || !workTypeTotals) {
    return (
      <div>
        <section className="card" aria-label="対象工事および工事枝番の選択">
          <div className="section-header">
            <div>
              <h2 className="section-title">
                <span>🏗️ 対象工事・枝番の選択</span>
              </h2>
              <p className="section-subtitle">
                本工事・追加工事の単体状況、または全枝番合算（工事全体）の原価・粗利をワンクリックで切り替えられます
              </p>
            </div>
          </div>

          <div className="selector-grid">
            <div className="form-field">
              <label htmlFor="cockpit-project-select" className="form-label">
                工事名を選択
              </label>
              <select
                id="cockpit-project-select"
                className="form-select"
                value={currentProjectGroup.projectCode}
                onChange={(e) => {
                  const nextCode = e.target.value;
                  setSelectedProjectCode(nextCode);
                  const nextGroup = projectGroups.find(
                    (g) => g.projectCode === nextCode
                  );
                  const defaultBranch =
                    nextGroup?.branches.find(
                      (b) => b.key.branch_code === "000"
                    ) ?? nextGroup?.branches[0];
                  setSelectedBranchKey(
                    defaultBranch ? defaultBranch.key.branch_code : "000"
                  );
                }}
              >
                {projectGroups.map((group) => (
                  <option key={group.projectCode} value={group.projectCode}>
                    {group.projectName}（工事番号: {group.projectCode} / 全
                    {group.branches.length}枝番）
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <span className="form-label" id="branch-tabs-label">
                工事枝番・集計単位の切り替え
              </span>
              <div
                className="branch-tabs"
                role="tablist"
                aria-labelledby="branch-tabs-label"
              >
                {currentProjectGroup.branches.map((b) => {
                  const isSelected =
                    selectedBranchKey !== ALL_BRANCHES_KEY &&
                    b.key.branch_code === selectedBranchKey;
                  const labelText = getBranchDisplayLabel(
                    b.key.branch_code,
                    b.branch_name
                  );
                  return (
                    <button
                      key={b.key.branch_code}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className={`branch-tab-btn ${isSelected ? "active" : ""}`}
                      onClick={() => setSelectedBranchKey(b.key.branch_code)}
                    >
                      {labelText}
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedBranchKey === ALL_BRANCHES_KEY}
                  className={`branch-tab-btn ${
                    selectedBranchKey === ALL_BRANCHES_KEY ? "active" : ""
                  }`}
                  onClick={() => setSelectedBranchKey(ALL_BRANCHES_KEY)}
                >
                  📊 全枝番合算（工事全体）
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="card state-box" role="alert">
          <div
            className="alert-banner alert-danger"
            style={{ justifyContent: "center", marginBottom: "16px" }}
          >
            <span>
              ⚠️{" "}
              {aggregationError ??
                "表示可能な工事原価データがありません。各枝番を個別に選択してください。"}
            </span>
          </div>
          {fallbackBranch && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                setSelectedBranchKey(fallbackBranch.key.branch_code)
              }
            >
              本工事を表示（枝番単体表示へ戻る）
            </button>
          )}
        </section>
      </div>
    );
  }

  const badge = getCompletionBadge(activeData.completionStatus);

  const budgetRemainingDec = new Decimal(activeData.executionBudgetAmount).minus(
    activeData.actualOccurredCost
  );
  const actualConsumptionRate = calcRatePercent(
    new Decimal(activeData.actualOccurredCost),
    new Decimal(activeData.executionBudgetAmount)
  );
  const orderedRate = calcRatePercent(
    new Decimal(activeData.orderedCommittedAmount),
    new Decimal(activeData.executionBudgetAmount)
  );

  const totalBreakdownDec = new Decimal(activeData.actualBreakdown.total_cost);
  const breakdownItems = [
    {
      key: "subcontract",
      label: "外注費（出来高）",
      amount: activeData.actualBreakdown.subcontract_cost,
      color: "#0d9488",
      percent: calcRatePercent(
        new Decimal(activeData.actualBreakdown.subcontract_cost),
        totalBreakdownDec
      ),
    },
    {
      key: "material",
      label: "材料費",
      amount: activeData.actualBreakdown.material_cost,
      color: "#2563eb",
      percent: calcRatePercent(
        new Decimal(activeData.actualBreakdown.material_cost),
        totalBreakdownDec
      ),
    },
    {
      key: "labor",
      label: "労務費（出面）",
      amount: activeData.actualBreakdown.labor_cost,
      color: "#d97706",
      percent: calcRatePercent(
        new Decimal(activeData.actualBreakdown.labor_cost),
        totalBreakdownDec
      ),
    },
    {
      key: "expense",
      label: "現場経費",
      amount: activeData.actualBreakdown.expense_cost,
      color: "#7c3aed",
      percent: calcRatePercent(
        new Decimal(activeData.actualBreakdown.expense_cost),
        totalBreakdownDec
      ),
    },
    {
      key: "equipment",
      label: "機械損料",
      amount: activeData.actualBreakdown.equipment_cost,
      color: "#e11d48",
      percent: calcRatePercent(
        new Decimal(activeData.actualBreakdown.equipment_cost),
        totalBreakdownDec
      ),
    },
  ];

  return (
    <div>
      {/* 工事・枝番セレクター */}
      <section className="card" aria-label="対象工事および工事枝番の選択">
        <div className="section-header">
          <div>
            <h2 className="section-title">
              <span>🏗️ 対象工事・枝番の選択</span>
              <span className={badge.className}>{badge.label}</span>
            </h2>
            <p className="section-subtitle">
              本工事・追加工事の単体状況、または全枝番合算（工事全体）の原価・粗利をワンクリックで切り替えられます
            </p>
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600 }}>
            表示対象：{activeData.projectName}（{activeData.branchTitle}）
          </div>
        </div>

        <div className="selector-grid">
          <div className="form-field">
            <label htmlFor="cockpit-project-select" className="form-label">
              工事名を選択
            </label>
            <select
              id="cockpit-project-select"
              className="form-select"
              value={currentProjectGroup.projectCode}
              onChange={(e) => {
                const nextCode = e.target.value;
                setSelectedProjectCode(nextCode);
                const nextGroup = projectGroups.find((g) => g.projectCode === nextCode);
                const defaultBranch =
                  nextGroup?.branches.find((b) => b.key.branch_code === "000") ??
                  nextGroup?.branches[0];
                setSelectedBranchKey(defaultBranch ? defaultBranch.key.branch_code : "000");
              }}
            >
              {projectGroups.map((group) => (
                <option key={group.projectCode} value={group.projectCode}>
                  {group.projectName}（工事番号: {group.projectCode} / 全
                  {group.branches.length}枝番）
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <span className="form-label" id="branch-tabs-label">
              工事枝番・集計単位の切り替え
            </span>
            <div
              className="branch-tabs"
              role="tablist"
              aria-labelledby="branch-tabs-label"
            >
              {currentProjectGroup.branches.map((b) => {
                const isSelected =
                  selectedBranchKey !== ALL_BRANCHES_KEY &&
                  b.key.branch_code === activeData.branchCode;
                const labelText = getBranchDisplayLabel(
                  b.key.branch_code,
                  b.branch_name
                );
                return (
                  <button
                    key={b.key.branch_code}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    className={`branch-tab-btn ${isSelected ? "active" : ""}`}
                    onClick={() => setSelectedBranchKey(b.key.branch_code)}
                  >
                    {labelText}
                  </button>
                );
              })}

              <button
                type="button"
                role="tab"
                aria-selected={selectedBranchKey === ALL_BRANCHES_KEY}
                className={`branch-tab-btn ${
                  selectedBranchKey === ALL_BRANCHES_KEY ? "active" : ""
                }`}
                onClick={() => setSelectedBranchKey(ALL_BRANCHES_KEY)}
              >
                📊 全枝番合算（工事全体）
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* アラートバナー（スマートガードレール） */}
      {(activeData.isBudgetExceeded ||
        activeData.requiresSupervisingEngineerWarning) && (
        <section className="alert-stack" aria-label="原価・現場管理アラート">
          {activeData.isBudgetExceeded && (
            <div className="alert-banner alert-danger" role="alert">
              <span>
                ⚠️ 予算超過アラート：発注額または実発生原価が実行予算を上回っています（実行予算{" "}
                {formatYen(activeData.executionBudgetAmount)} に対し、発注済{" "}
                {formatYen(activeData.orderedCommittedAmount)} ／ 実発生原価{" "}
                {formatYen(activeData.actualOccurredCost)} ／ 着地予想{" "}
                {formatYen(activeData.forecastFinalCost)}）
              </span>
            </div>
          )}

          {activeData.requiresSupervisingEngineerWarning && (
            <div className="alert-banner alert-warning" role="alert">
              <span>
                ⚠️ 監理技術者設定アラート：下請発注総額が基準値（4,500万円）以上ですが監理技術者が未設定です。監理技術者の設定を確認してください。
              </span>
            </div>
          )}
        </section>
      )}

      {/* 5大指標サマリーカード */}
      <section className="kpi-grid" aria-label="工事原価5大指標サマリー">
        {/* ① 請負契約額（税抜） */}
        <article className="kpi-card">
          <div className="kpi-label-row">
            <span className="kpi-label">① 請負契約額（税抜）</span>
            <span className="kpi-tag">受注金額</span>
          </div>
          <div className="kpi-amount">
            {formatYen(activeData.contractAmountTaxEx)}
          </div>
          <div className="kpi-subtext">
            <span>対象</span>
            <span>{activeData.branchTitle}</span>
          </div>
        </article>

        {/* ② 実行予算額（上限） */}
        <article className="kpi-card">
          <div className="kpi-label-row">
            <span className="kpi-label">② 実行予算額（上限）</span>
            <span className="kpi-tag">{activeData.budgetRevLabel}</span>
          </div>
          <div className="kpi-amount">
            {formatYen(activeData.executionBudgetAmount)}
          </div>
          <div className="kpi-subtext">
            <span>実発生ベースの予算残</span>
            <span className={budgetRemainingDec.isNegative() ? "text-danger" : ""}>
              {(() => {
                try {
                  return formatYen(
                    toSafeYenNumber(budgetRemainingDec, "予算残")
                  );
                } catch {
                  return "上限超過";
                }
              })()}
            </span>
          </div>
        </article>

        {/* ③ 発注・確定済額 */}
        <article className="kpi-card">
          <div className="kpi-label-row">
            <span className="kpi-label">③ 発注・確定済額</span>
            <span className="kpi-tag">下請注文コミット</span>
          </div>
          <div className="kpi-amount">
            {formatYen(activeData.orderedCommittedAmount)}
          </div>
          <div className="kpi-subtext">
            <span>実行予算比</span>
            <span>{formatPercent(orderedRate)}</span>
          </div>
        </article>

        {/* ④ 今実際に発生した原価（最重要強調表示） */}
        <article
          className={`kpi-card ${
            activeData.isBudgetExceeded ? "danger-highlight" : "primary-highlight"
          }`}
        >
          <div className="kpi-label-row">
            <span className="kpi-label">④ 今実際に発生した原価</span>
            <span className="kpi-tag">最重要指標</span>
          </div>
          <div className="kpi-amount">
            {formatYen(activeData.actualOccurredCost)}
          </div>
          <div className="kpi-subtext">
            <span>予算消化率</span>
            <span
              className={
                isOver100Percent(actualConsumptionRate) ? "text-danger" : ""
              }
            >
              {formatPercent(actualConsumptionRate)}
            </span>
          </div>
        </article>

        {/* ⑤ 着地予想原価 ＆ 見込粗利 */}
        <article
          className={`kpi-card ${
            activeData.isBudgetExceeded ? "danger-highlight" : ""
          }`}
        >
          <div className="kpi-label-row">
            <span className="kpi-label">⑤ 着地予想原価 ＆ 見込粗利</span>
            <span className="kpi-tag">
              粗利率 {formatPercent(activeData.forecastProfitRate)}
            </span>
          </div>
          <div className="kpi-amount">
            {formatYen(activeData.forecastFinalCost)}
          </div>
          <div className="kpi-subtext">
            <span>見込粗利額</span>
            <span
              className={
                activeData.forecastGrossProfit < 0 ? "text-danger" : ""
              }
              style={{ fontWeight: 700 }}
            >
              {formatYen(activeData.forecastGrossProfit)}（
              {formatPercent(activeData.forecastProfitRate)}）
            </span>
          </div>
        </article>
      </section>

      {/* 原価5要素の内訳プログレスバー */}
      <section className="card" aria-label="実際発生原価の5要素内訳">
        <div className="section-header">
          <div>
            <h3 className="section-title">
              📊 原価5要素の内訳（実際発生原価：{formatYen(activeData.actualBreakdown.total_cost)}）
            </h3>
            <p className="section-subtitle">
              外注費（出来高）・材料費・労務費（出面）・現場経費・機械損料のどこに原価がかかっているかを可視化します
            </p>
          </div>
        </div>

        <div
          className="stacked-bar-track"
          role="img"
          aria-label="原価5要素の構成比バー"
        >
          {totalBreakdownDec.greaterThan(0) ? (
            breakdownItems.map((item) => {
              const widthNum = clampProgressWidth(item.percent);
              if (widthNum <= 0) return null;
              return (
                <div
                  key={item.key}
                  className="stacked-bar-segment"
                  style={{
                    width: `${widthNum}%`,
                    backgroundColor: item.color,
                  }}
                  title={`${item.label}: ${formatYen(item.amount)} (${formatPercent(
                    item.percent
                  )})`}
                />
              );
            })
          ) : (
            <div
              className="stacked-bar-segment"
              style={{ width: "100%", backgroundColor: "#cbd5e1" }}
            />
          )}
        </div>

        <div className="breakdown-list">
          {breakdownItems.map((item) => (
            <div key={item.key} className="breakdown-item">
              <div className="breakdown-item-header">
                <span className="breakdown-dot-label">
                  <span
                    className="color-dot"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                </span>
                <span className="breakdown-percent">
                  {formatPercent(item.percent)}
                </span>
              </div>
              <div className="breakdown-amount">{formatYen(item.amount)}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 工種別（12桁工種）予実対比テーブル */}
      <section className="card" aria-label="工種別予実対比テーブル">
        <div className="section-header">
          <div>
            <h3 className="section-title">📋 工種別（12桁工種）予実対比一覧</h3>
            <p className="section-subtitle">
              工種ごとの実行予算・発注済額・実際発生原価・予算残高および消化率（100%超は赤強調）
            </p>
          </div>
        </div>

        {activeData.byWorkType.length === 0 ? (
          <div className="state-box">
            <p style={{ margin: 0, color: "var(--text-muted)" }}>
              この工事枝番には工種別の予算・原価明細がまだ登録されていません。
            </p>
          </div>
        ) : (
          <div className="table-scroll-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">工種コード（12桁）</th>
                  <th scope="col">工種名</th>
                  <th scope="col" className="num">
                    実行予算額
                  </th>
                  <th scope="col" className="num">
                    発注済額
                  </th>
                  <th scope="col" className="num">
                    実際発生原価
                  </th>
                  <th scope="col" className="num">
                    予算残高
                  </th>
                  <th scope="col" className="progress-cell">
                    予算消化率
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeData.byWorkType.map((row) => {
                  const exceeded =
                    isOver100Percent(row.consumption_rate_percent) ||
                    row.remaining_budget < 0;
                  const barWidth = clampProgressWidth(
                    row.consumption_rate_percent
                  );
                  return (
                    <tr key={row.work_type_code}>
                      <td>
                        <span className="code-pill">{row.work_type_code}</span>
                      </td>
                      <td style={{ fontWeight: 700 }}>{row.work_type_name}</td>
                      <td className="num">{formatYen(row.budget_amount)}</td>
                      <td className="num">{formatYen(row.ordered_amount)}</td>
                      <td
                        className={`num ${exceeded ? "text-danger" : ""}`}
                        style={{ fontWeight: 800 }}
                      >
                        {formatYen(row.actual_cost)}
                      </td>
                      <td
                        className={`num ${
                          row.remaining_budget < 0 ? "text-danger" : ""
                        }`}
                      >
                        {formatYen(row.remaining_budget)}
                      </td>
                      <td className="progress-cell">
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: "0.82rem",
                            fontWeight: 700,
                          }}
                          className={exceeded ? "text-danger" : ""}
                        >
                          <span>
                            {formatPercent(row.consumption_rate_percent)}
                          </span>
                          {exceeded && <span>超過</span>}
                        </div>
                        <div className="progress-bar-bg">
                          <div
                            className={`progress-bar-fill ${
                              exceeded ? "exceeded" : ""
                            }`}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>合計（{activeData.byWorkType.length} 工種）</td>
                  <td className="num">{formatYen(workTypeTotals.budget)}</td>
                  <td className="num">{formatYen(workTypeTotals.ordered)}</td>
                  <td
                    className={`num ${
                      isOver100Percent(workTypeTotals.rate) ? "text-danger" : ""
                    }`}
                  >
                    {formatYen(workTypeTotals.actual)}
                  </td>
                  <td
                    className={`num ${
                      workTypeTotals.remaining < 0 ? "text-danger" : ""
                    }`}
                  >
                    {formatYen(workTypeTotals.remaining)}
                  </td>
                  <td
                    className={`num ${
                      isOver100Percent(workTypeTotals.rate) ? "text-danger" : ""
                    }`}
                  >
                    全体消化率 {formatPercent(workTypeTotals.rate)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default CockpitView;
