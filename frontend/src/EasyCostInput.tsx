import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import {
  API_ENDPOINTS,
  CompletionStatus,
  CostRegistrationResponse,
  EasyDailyReportRequest,
  EasyDirectCostRequest,
  EasyEquipmentMovementRequest,
  EasySubcontractProgressRequest,
  ErrorResponse,
  LookupsDto,
  ProjectCostCockpitDto,
  QuickItemTemplateDto,
  SubcontractOrderSummaryDto,
  YenAmount,
} from "./bindings";
import { apiFetch } from "./auth";

export interface EasyCostInputProps {
  projects: ProjectCostCockpitDto[];
  companyCode: string;
  onRegistered: () => Promise<void>;
}

type InputMode = "subcontract" | "direct" | "daily" | "equipment";

const MAX_YEN_DEC = new Decimal("999999999999999");

function getLocalTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getLocalYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function formatYen(amount: YenAmount): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

function completionStatusLabel(status: CompletionStatus): string {
  switch (status) {
    case "0":
      return "未成（登録可）";
    case "1":
      return "完成（警告付き登録可）";
    case "2":
      return "前期完成（登録不可）";
    case "3":
      return "計上ロック済（登録不可）";
  }
}

function isBranchLocked(status: CompletionStatus): boolean {
  return status === "2" || status === "3";
}

function isValidDateYmd(val: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const [yStr, mStr, dStr] = val.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
}

function isValidYearMonth(val: string): boolean {
  if (!/^\d{6}$/.test(val)) return false;
  const m = Number(val.slice(4, 6));
  return m >= 1 && m <= 12;
}

function parseNonNegativeYen(
  raw: string,
  fieldLabel: string
): { value?: YenAmount; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: `${fieldLabel}を入力してください。` };
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return { error: `${fieldLabel}は整数の円金額で入力してください。` };
  }
  try {
    const dec = new Decimal(trimmed);
    if (dec.isNegative()) {
      return { error: `${fieldLabel}にマイナスの金額は入力できません。` };
    }
    if (dec.gt(MAX_YEN_DEC)) {
      return { error: `${fieldLabel}は15桁以内で入力してください。` };
    }
    const num = dec.toNumber();
    if (!Number.isSafeInteger(num)) {
      return { error: `${fieldLabel}が有効な整数範囲を超えています。` };
    }
    return { value: num };
  } catch {
    return { error: `${fieldLabel}の形式が正しくありません。` };
  }
}

function parseDecimalScale3(
  raw: string,
  fieldLabel: string,
  allowZero: boolean
): { dec?: Decimal; formatted?: string; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: `${fieldLabel}を入力してください。` };
  }
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { error: `${fieldLabel}は数値で入力してください。` };
  }
  const parts = trimmed.split(".");
  if (parts[1] && parts[1].length > 3) {
    return { error: `${fieldLabel}は小数第3位までで入力してください。` };
  }
  try {
    const dec = new Decimal(trimmed);
    if (dec.isNegative()) {
      return { error: `${fieldLabel}にマイナスの値は入力できません。` };
    }
    if (!allowZero && dec.isZero()) {
      return { error: `${fieldLabel}は0より大きい値を入力してください。` };
    }
    if (dec.abs().gte(new Decimal("1000000000000"))) {
      return { error: `${fieldLabel}の桁数が上限を超えています。` };
    }
    return { dec, formatted: dec.toFixed(3) };
  } catch {
    return { error: `${fieldLabel}の数値形式が正しくありません。` };
  }
}

function formatRatePercent(numStr: string, denStr: string): string {
  try {
    const num = new Decimal(numStr);
    const den = new Decimal(denStr);
    if (den.lte(0)) return "-";
    const pct = num.mul(100).div(den);
    return `${pct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString()}%`;
  } catch {
    return "-";
  }
}

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as Partial<ErrorResponse>;
    if (data && typeof data.message === "string" && data.message.trim() !== "") {
      return data.message;
    }
  } catch {
    // JSON解析エラー時は無視して標準エラー文言へフォールバック
  }
  return `リクエスト処理中にエラーが発生しました（HTTP ${res.status}）`;
}

export const EasyCostInput: React.FC<EasyCostInputProps> = ({
  projects,
  companyCode,
  onRegistered,
}) => {
  const [lookups, setLookups] = useState<LookupsDto | null>(null);
  const [lookupsLoading, setLookupsLoading] = useState<boolean>(true);
  const [lookupsError, setLookupsError] = useState<string | null>(null);

  const [mode, setMode] = useState<InputMode>("subcontract");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const busyRef = useRef<boolean>(false);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<{
    modeLabel: string;
    documentNo: string;
    warnings: string[];
  } | null>(null);

  // 工事・枝番の選択状態（完成2/3でない最初の枝番を初期選択）
  const [selectedBranchKey, setSelectedBranchKey] = useState<string>(() => {
    const firstWritable = projects.find(
      (p) => !isBranchLocked(p.completion_status)
    );
    const target = firstWritable ?? projects[0];
    return target ? `${target.key.project_code}::${target.key.branch_code}` : "";
  });

  useEffect(() => {
    if (projects.length === 0) return;
    const exists = projects.some(
      (p) => `${p.key.project_code}::${p.key.branch_code}` === selectedBranchKey
    );
    if (!exists) {
      const firstWritable = projects.find(
        (p) => !isBranchLocked(p.completion_status)
      );
      const target = firstWritable ?? projects[0];
      if (target) {
        setSelectedBranchKey(
          `${target.key.project_code}::${target.key.branch_code}`
        );
      }
    }
  }, [projects, selectedBranchKey]);

  const selectedProject = useMemo(() => {
    return (
      projects.find(
        (p) =>
          `${p.key.project_code}::${p.key.branch_code}` === selectedBranchKey
      ) ?? null
    );
  }, [projects, selectedBranchKey]);

  const fetchLookups = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLookupsLoading(true);
      }
      setLookupsError(null);
      try {
        const params = new URLSearchParams({ company_code: companyCode });
        const res = await apiFetch(
          `${API_ENDPOINTS.MASTER_LOOKUPS}?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );
        if (!res.ok) {
          throw new Error(await extractErrorMessage(res));
        }
        const data = (await res.json()) as LookupsDto;
        setLookups(data);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "マスタ辞書の取得に失敗しました。";
        setLookupsError(msg);
      } finally {
        if (!silent) {
          setLookupsLoading(false);
        }
      }
    },
    [companyCode]
  );

  useEffect(() => {
    void fetchLookups(false);
  }, [fetchLookups]);

  // ============================================================================
  // タブ1：外注出来高査定の状態
  // ============================================================================
  const branchOrders = useMemo<SubcontractOrderSummaryDto[]>(() => {
    if (!lookups || !selectedProject) return [];
    return lookups.subcontract_orders.filter(
      (o) =>
        o.project_code === selectedProject.key.project_code &&
        o.branch_code === selectedProject.key.branch_code
    );
  }, [lookups, selectedProject]);

  const [selectedOrderNumber, setSelectedOrderNumber] = useState<string>("");
  const [assessmentYm, setAssessmentYm] = useState<string>(() =>
    getLocalYearMonth()
  );
  const [progressPercentStr, setProgressPercentStr] = useState<string>("0");
  const [currAssessedInput, setCurrAssessedInput] = useState<string>("0");
  const [fixedDeductionsInput, setFixedDeductionsInput] = useState<string>("0");
  const [chargebackOffsetInput, setChargebackOffsetInput] =
    useState<string>("0");

  const selectedOrder = useMemo<SubcontractOrderSummaryDto | null>(() => {
    return (
      branchOrders.find((o) => o.order_number === selectedOrderNumber) ?? null
    );
  }, [branchOrders, selectedOrderNumber]);

  const initOrderProgressState = useCallback(
    (order: SubcontractOrderSummaryDto | null) => {
      if (!order) {
        setProgressPercentStr("0");
        setCurrAssessedInput("0");
        return;
      }
      const orderAmt = new Decimal(order.order_amount_tax_ex);
      const prevAccum = new Decimal(order.accum_assessed_amount_tax_ex);
      if (orderAmt.gt(0)) {
        const prevPct = prevAccum
          .mul(100)
          .div(orderAmt)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        setProgressPercentStr(prevPct.toString());
      } else {
        setProgressPercentStr("0");
      }
      setCurrAssessedInput("0");
    },
    []
  );

  useEffect(() => {
    if (branchOrders.length === 0) {
      setSelectedOrderNumber("");
      initOrderProgressState(null);
      return;
    }
    const stillExists = branchOrders.some(
      (o) => o.order_number === selectedOrderNumber
    );
    if (!stillExists) {
      const firstOrder = branchOrders[0];
      if (firstOrder) {
        setSelectedOrderNumber(firstOrder.order_number);
        initOrderProgressState(firstOrder);
      } else {
        setSelectedOrderNumber("");
        initOrderProgressState(null);
      }
    }
  }, [branchOrders, selectedOrderNumber, initOrderProgressState]);

  const handleSelectOrder = (orderNo: string) => {
    if (isSubmitting) return;
    setSelectedOrderNumber(orderNo);
    const found =
      branchOrders.find((o) => o.order_number === orderNo) ?? null;
    initOrderProgressState(found);
    setSubmitError(null);
  };

  const handleProgressSliderChange = (pctStr: string) => {
    setProgressPercentStr(pctStr);
    if (!selectedOrder) return;
    try {
      const pct = new Decimal(pctStr);
      const orderAmt = new Decimal(selectedOrder.order_amount_tax_ex);
      const prevAccum = new Decimal(
        selectedOrder.accum_assessed_amount_tax_ex
      );
      const targetAccum = orderAmt
        .mul(pct)
        .div(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      const curr = targetAccum.minus(prevAccum);
      setCurrAssessedInput(curr.toString());
    } catch {
      // 不正なスライダー文字列は無視
    }
  };

  const handleCurrAssessedDirectChange = (val: string) => {
    setCurrAssessedInput(val);
    if (!selectedOrder) return;
    const trimmed = val.trim();
    if (!/^-?\d+$/.test(trimmed)) return;
    try {
      const curr = new Decimal(trimmed);
      const orderAmt = new Decimal(selectedOrder.order_amount_tax_ex);
      const prevAccum = new Decimal(
        selectedOrder.accum_assessed_amount_tax_ex
      );
      if (orderAmt.gt(0)) {
        const newAccum = prevAccum.plus(curr);
        const pct = Decimal.max(
          0,
          Decimal.min(
            100,
            newAccum
              .mul(100)
              .div(orderAmt)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          )
        );
        setProgressPercentStr(pct.toString());
      }
    } catch {
      // 数値変換エラー時は無視
    }
  };

  const subcontractPreview = useMemo(() => {
    if (!selectedOrder) return null;
    const fieldErrors: Record<string, string> = {};

    if (!isValidYearMonth(assessmentYm.trim())) {
      fieldErrors.assessmentYm =
        "査定対象年月はYYYYMM形式（例: 202610）で入力してください。";
    }

    const currParsed = parseNonNegativeYen(
      currAssessedInput,
      "今回査定金額（税抜）"
    );
    const fixedParsed = parseNonNegativeYen(
      fixedDeductionsInput,
      "定額控除額"
    );
    const offsetParsed = parseNonNegativeYen(
      chargebackOffsetInput,
      "立替相殺額"
    );

    if (currParsed.error) {
      const trimmed = currAssessedInput.trim();
      if (/^-\d+$/.test(trimmed)) {
        fieldErrors.currAssessed =
          "累計進捗率が前回査定を下回っています（今回査定額がマイナスになります）。";
      } else {
        fieldErrors.currAssessed = currParsed.error;
      }
    } else if (currParsed.value !== undefined) {
      if (currParsed.value === 0) {
        fieldErrors.currAssessed =
          "今回査定金額（税抜）は1円以上を入力してください。";
      } else if (currParsed.value > selectedOrder.remaining_order_balance) {
        fieldErrors.currAssessed = `今回査定金額が発注残高（${formatYen(
          selectedOrder.remaining_order_balance
        )}）を超過しています。`;
      }
    }

    if (fixedParsed.error) {
      fieldErrors.fixedDeductions = fixedParsed.error;
    }
    if (offsetParsed.error) {
      fieldErrors.chargebackOffset = offsetParsed.error;
    }

    const currDec = new Decimal(currParsed.value ?? 0);
    const fixedDec = new Decimal(fixedParsed.value ?? 0);
    const offsetDec = new Decimal(offsetParsed.value ?? 0);

    const prevAccumEx = new Decimal(
      selectedOrder.accum_assessed_amount_tax_ex
    );
    const prevAccumTax = new Decimal(selectedOrder.accum_assessed_tax_amount);
    const taxRate = new Decimal(selectedOrder.tax_rate);
    const retNum = new Decimal(selectedOrder.retainage_rate_num);
    const retDen = new Decimal(selectedOrder.retainage_rate_den);
    const safNum = new Decimal(selectedOrder.safety_assoc_rate_num);
    const safDen = new Decimal(selectedOrder.safety_assoc_rate_den);

    // CONVENTIONS.md §3.2 決定論的端数計算
    const newAccumEx = prevAccumEx.plus(currDec);
    const accumTaxCurr = newAccumEx
      .mul(taxRate)
      .toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    const currTaxAmount = accumTaxCurr.minus(prevAccumTax);

    const retainage = retDen.gt(0)
      ? currDec
          .mul(retNum)
          .div(retDen)
          .toDecimalPlaces(0, Decimal.ROUND_FLOOR)
      : new Decimal(0);

    const safetyFee = safDen.gt(0)
      ? currDec
          .mul(safNum)
          .div(safDen)
          .toDecimalPlaces(0, Decimal.ROUND_FLOOR)
      : new Decimal(0);

    const totalDeduction = retainage
      .plus(safetyFee)
      .plus(fixedDec)
      .plus(offsetDec);
    const netPayment = currDec.plus(currTaxAmount).minus(totalDeduction);

    const orderAmtDec = new Decimal(selectedOrder.order_amount_tax_ex);
    const prevProgressPct = orderAmtDec.gt(0)
      ? prevAccumEx
          .mul(100)
          .div(orderAmtDec)
          .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
          .toString()
      : "0.0";
    const newProgressPct = orderAmtDec.gt(0)
      ? newAccumEx
          .mul(100)
          .div(orderAmtDec)
          .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
          .toString()
      : "0.0";

    return {
      fieldErrors,
      isValid: Object.keys(fieldErrors).length === 0,
      currAssessedYen: currDec.toNumber(),
      currTaxYen: currTaxAmount.toNumber(),
      retainageYen: retainage.toNumber(),
      safetyFeeYen: safetyFee.toNumber(),
      fixedYen: fixedDec.toNumber(),
      offsetYen: offsetDec.toNumber(),
      totalDeductionYen: totalDeduction.toNumber(),
      netPaymentYen: netPayment.toNumber(),
      prevProgressPct,
      newProgressPct,
      taxRatePctLabel: `${taxRate.mul(100).toDecimalPlaces(1).toString()}%`,
      retainageRateLabel: formatRatePercent(
        selectedOrder.retainage_rate_num,
        selectedOrder.retainage_rate_den
      ),
      safetyRateLabel: formatRatePercent(
        selectedOrder.safety_assoc_rate_num,
        selectedOrder.safety_assoc_rate_den
      ),
    };
  }, [
    selectedOrder,
    assessmentYm,
    currAssessedInput,
    fixedDeductionsInput,
    chargebackOffsetInput,
  ]);

  const handleSubcontractSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;

    setSubmitError(null);
    setSubmitSuccess(null);

    if (!selectedProject) {
      setSubmitError("対象の工事・枝番を選択してください。");
      return;
    }
    if (isBranchLocked(selectedProject.completion_status)) {
      setSubmitError(
        "選択された工事枝番は前期完成または計上ロック済のため、原価を登録できません。"
      );
      return;
    }
    if (!selectedOrder || !subcontractPreview) {
      setSubmitError("対象の発注書を選択してください。");
      return;
    }
    if (!subcontractPreview.isValid) {
      const firstErr = Object.values(subcontractPreview.fieldErrors)[0];
      setSubmitError(firstErr ?? "入力内容を確認してください。");
      return;
    }

    const payload: EasySubcontractProgressRequest = {
      company_code: companyCode,
      order_number: selectedOrder.order_number,
      order_history_no: selectedOrder.order_history_no,
      assessment_year_month: assessmentYm.trim(),
      curr_assessed_amount_tax_ex: subcontractPreview.currAssessedYen,
      fixed_deductions: subcontractPreview.fixedYen,
      chargeback_offset: subcontractPreview.offsetYen,
    };

    busyRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await apiFetch(API_ENDPOINTS.SUBMIT_SUBCONTRACT_PROGRESS, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      const result = (await res.json()) as CostRegistrationResponse;
      setSubmitSuccess({
        modeLabel: "外注出来高査定",
        documentNo: result.document_no,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      });
      setCurrAssessedInput("0");
      setFixedDeductionsInput("0");
      setChargebackOffsetInput("0");
      await Promise.all([fetchLookups(true), onRegistered()]);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "外注出来高の登録中に通信エラーが発生しました。"
      );
    } finally {
      busyRef.current = false;
      setIsSubmitting(false);
    }
  };

  // ============================================================================
  // タブ2：買った材料・現場経費の状態
  // ============================================================================
  const [selectedTemplateCode, setSelectedTemplateCode] = useState<string>("");
  const [directItemName, setDirectItemName] = useState<string>("");
  const [directSpecification, setDirectSpecification] = useState<string>("");
  const [directWorkTypeCode, setDirectWorkTypeCode] = useState<string>("");
  const [directCostElement, setDirectCostElement] = useState<
    "0100" | "0400" | ""
  >("");
  const [directUnit, setDirectUnit] = useState<string>("");
  const [directQuantity, setDirectQuantity] = useState<string>("1");
  const [directUnitPrice, setDirectUnitPrice] = useState<string>("");
  const [directOccurredDate, setDirectOccurredDate] = useState<string>(() =>
    getLocalTodayDate()
  );
  const [directVendorCode, setDirectVendorCode] = useState<string>("");
  const [directNotes, setDirectNotes] = useState<string>("");

  const applyQuickTemplate = useCallback((tpl: QuickItemTemplateDto) => {
    setSelectedTemplateCode(tpl.template_code);
    setDirectItemName(tpl.item_label);
    setDirectWorkTypeCode(tpl.work_type_code);
    setDirectCostElement(tpl.cost_element_code);
    setDirectUnit(tpl.default_unit);
    try {
      const priceDec = new Decimal(tpl.default_unit_price);
      setDirectUnitPrice(priceDec.toString());
    } catch {
      setDirectUnitPrice(tpl.default_unit_price);
    }
  }, []);

  useEffect(() => {
    if (lookups && selectedTemplateCode === "" && directCostElement === "") {
      const firstTemplate = lookups.quick_templates[0];
      if (firstTemplate) {
        applyQuickTemplate(firstTemplate);
      }
    }
  }, [lookups, selectedTemplateCode, directCostElement, applyQuickTemplate]);

  const workTypeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (lookups) {
      for (const wt of lookups.work_types) {
        map.set(wt.work_type_code, wt.work_type_name);
      }
    }
    for (const p of projects) {
      for (const row of p.by_work_type) {
        if (!map.has(row.work_type_code)) {
          map.set(row.work_type_code, row.work_type_name);
        }
      }
    }
    return map;
  }, [lookups, projects]);

  const directPreview = useMemo(() => {
    const fieldErrors: Record<string, string> = {};

    if (!directCostElement) {
      fieldErrors.template =
        "品目カードを選択するか、材料費・現場経費の種類を選択してください。";
    }
    if (!directWorkTypeCode || directWorkTypeCode.length !== 12) {
      fieldErrors.workType = "対象の作業内容（工種）を選択してください。";
    }
    if (!directItemName.trim()) {
      fieldErrors.itemName = "品名・内容を入力してください。";
    }
    if (!directUnit.trim()) {
      fieldErrors.unit = "単位を入力してください（例: m3, t, 式）。";
    }
    if (!isValidDateYmd(directOccurredDate.trim())) {
      fieldErrors.occurredDate =
        "発生日はYYYY-MM-DD形式で有効な日付を入力してください。";
    }

    const qtyParsed = parseDecimalScale3(directQuantity, "数量", false);
    if (qtyParsed.error) {
      fieldErrors.quantity = qtyParsed.error;
    }

    const priceParsed = parseDecimalScale3(directUnitPrice, "単価", false);
    if (priceParsed.error) {
      fieldErrors.unitPrice = priceParsed.error;
    }

    let calculatedAmountYen: YenAmount = 0;
    if (qtyParsed.dec && priceParsed.dec) {
      // CONVENTIONS.md §3.1 round_half_up(quantity * unit_price, 0)
      const amtDec = qtyParsed.dec
        .mul(priceParsed.dec)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      if (amtDec.gt(MAX_YEN_DEC) || !Number.isSafeInteger(amtDec.toNumber())) {
        fieldErrors.amount = "計算後の金額が上限（15桁）を超えています。";
      } else if (amtDec.lte(0)) {
        fieldErrors.amount = "計算後の金額が1円以上になるよう入力してください。";
      } else {
        calculatedAmountYen = amtDec.toNumber();
      }
    }

    return {
      fieldErrors,
      isValid: Object.keys(fieldErrors).length === 0,
      qtyFormatted: qtyParsed.formatted ?? "0.000",
      priceFormatted: priceParsed.formatted ?? "0.000",
      calculatedAmountYen,
    };
  }, [
    directCostElement,
    directWorkTypeCode,
    directItemName,
    directUnit,
    directOccurredDate,
    directQuantity,
    directUnitPrice,
  ]);

  const handleDirectCostSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;

    setSubmitError(null);
    setSubmitSuccess(null);

    if (!selectedProject) {
      setSubmitError("対象の工事・枝番を選択してください。");
      return;
    }
    if (isBranchLocked(selectedProject.completion_status)) {
      setSubmitError(
        "選択された工事枝番は前期完成または計上ロック済のため、原価を登録できません。"
      );
      return;
    }
    if (!directPreview.isValid || !directCostElement) {
      const firstErr = Object.values(directPreview.fieldErrors)[0];
      setSubmitError(firstErr ?? "入力内容を確認してください。");
      return;
    }

    const payload: EasyDirectCostRequest = {
      company_code: companyCode,
      project_code: selectedProject.key.project_code,
      branch_code: selectedProject.key.branch_code,
      occurred_date: directOccurredDate.trim(),
      vendor_partner_code: directVendorCode.trim()
        ? directVendorCode.trim()
        : null,
      work_type_code: directWorkTypeCode,
      cost_element_code: directCostElement,
      item_name: directItemName.trim(),
      specification: directSpecification.trim()
        ? directSpecification.trim()
        : null,
      quantity: directPreview.qtyFormatted,
      unit: directUnit.trim(),
      unit_price: directPreview.priceFormatted,
      notes: directNotes.trim() ? directNotes.trim() : null,
    };

    busyRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await apiFetch(API_ENDPOINTS.SUBMIT_DIRECT_COST, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      const result = (await res.json()) as CostRegistrationResponse;
      setSubmitSuccess({
        modeLabel:
          directCostElement === "0100" ? "材料購入原価" : "現場経費原価",
        documentNo: result.document_no,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      });
      setDirectSpecification("");
      setDirectNotes("");
      await Promise.all([fetchLookups(true), onRegistered()]);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "材料費・現場経費の登録中に通信エラーが発生しました。"
      );
    } finally {
      busyRef.current = false;
      setIsSubmitting(false);
    }
  };

  // ============================================================================
  // タブ3：今日の現場日報（出面）の状態
  // ============================================================================
  const [dailyEmployeeCode, setDailyEmployeeCode] = useState<string>("");
  const [dailyWorkTypeCode, setDailyWorkTypeCode] = useState<string>("");
  const [dailyWorkDate, setDailyWorkDate] = useState<string>(() =>
    getLocalTodayDate()
  );
  const [dailyWorkHours, setDailyWorkHours] = useState<string>("8.0");
  const [dailyWorkSummary, setDailyWorkSummary] = useState<string>("");

  // ============================================================================
  // タブ4：資機材・重機の現場出庫の状態
  // ============================================================================
  const [equipCode, setEquipCode] = useState<string>("");
  const [equipWorkTypeCode, setEquipWorkTypeCode] = useState<string>("");
  const [equipMovementDate, setEquipMovementDate] = useState<string>(() =>
    getLocalTodayDate()
  );
  const [equipQuantity, setEquipQuantity] = useState<string>("1");
  const [equipUsageDays, setEquipUsageDays] = useState<string>("1");
  const [equipFreightFee, setEquipFreightFee] = useState<string>("0");
  const [equipMaintenanceFee, setEquipMaintenanceFee] = useState<string>("0");

  useEffect(() => {
    if (!lookups) return;
    const firstEmployee = lookups.employees[0];
    if (dailyEmployeeCode === "" && firstEmployee) {
      setDailyEmployeeCode(firstEmployee.employee_code);
    }
    const firstWorkType = lookups.work_types[0];
    if (dailyWorkTypeCode === "" && firstWorkType) {
      setDailyWorkTypeCode(firstWorkType.work_type_code);
    }
    const firstEquipment = lookups.equipments[0];
    if (equipCode === "" && firstEquipment) {
      setEquipCode(firstEquipment.equipment_code);
    }
    if (equipWorkTypeCode === "" && firstWorkType) {
      setEquipWorkTypeCode(firstWorkType.work_type_code);
    }
  }, [
    lookups,
    dailyEmployeeCode,
    dailyWorkTypeCode,
    equipCode,
    equipWorkTypeCode,
  ]);

  const selectedEmployee = useMemo(() => {
    return (
      lookups?.employees.find((e) => e.employee_code === dailyEmployeeCode) ??
      null
    );
  }, [lookups, dailyEmployeeCode]);

  const dailyPreview = useMemo(() => {
    const fieldErrors: Record<string, string> = {};

    if (!dailyEmployeeCode || !selectedEmployee) {
      fieldErrors.employee = "作業員を選択してください。";
    }
    if (!dailyWorkTypeCode || dailyWorkTypeCode.length !== 12) {
      fieldErrors.workType = "対象の作業内容（工種）を選択してください。";
    }
    if (!isValidDateYmd(dailyWorkDate.trim())) {
      fieldErrors.workDate =
        "作業日はYYYY-MM-DD形式で有効な日付を入力してください。";
    }

    const hoursParsed = parseDecimalScale3(
      dailyWorkHours,
      "作業時間（時間）",
      false
    );
    if (hoursParsed.error) {
      fieldErrors.workHours = hoursParsed.error;
    } else if (hoursParsed.dec && hoursParsed.dec.gt(new Decimal("24"))) {
      fieldErrors.workHours = "作業時間は24時間以内で入力してください。";
    }

    let estimatedLaborCostYen: YenAmount = 0;
    if (selectedEmployee && hoursParsed.dec) {
      // CONVENTIONS.md §3.3.4 round_half_up(daily_standard_wage * (hours_j / 8.0), 0)
      const wageDec = new Decimal(selectedEmployee.standard_daily_wage);
      const estDec = wageDec
        .mul(hoursParsed.dec)
        .div(new Decimal(8))
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      if (estDec.gt(MAX_YEN_DEC) || !Number.isSafeInteger(estDec.toNumber())) {
        fieldErrors.amount = "概算労務原価が上限（15桁）を超えています。";
      } else {
        estimatedLaborCostYen = estDec.toNumber();
      }
    }

    return {
      fieldErrors,
      isValid: Object.keys(fieldErrors).length === 0,
      hoursFormatted: hoursParsed.formatted ?? "0.000",
      estimatedLaborCostYen,
    };
  }, [
    dailyEmployeeCode,
    selectedEmployee,
    dailyWorkTypeCode,
    dailyWorkDate,
    dailyWorkHours,
  ]);

  const handleDailyReportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;

    setSubmitError(null);
    setSubmitSuccess(null);

    if (!selectedProject) {
      setSubmitError("対象の工事・枝番を選択してください。");
      return;
    }
    if (isBranchLocked(selectedProject.completion_status)) {
      setSubmitError(
        "選択された工事枝番は前期完成または計上ロック済のため、原価を登録できません。"
      );
      return;
    }
    if (!dailyPreview.isValid) {
      const firstErr = Object.values(dailyPreview.fieldErrors)[0];
      setSubmitError(firstErr ?? "入力内容を確認してください。");
      return;
    }

    const payload: EasyDailyReportRequest = {
      company_code: companyCode,
      work_date: dailyWorkDate.trim(),
      employee_code: dailyEmployeeCode,
      project_code: selectedProject.key.project_code,
      branch_code: selectedProject.key.branch_code,
      work_type_code: dailyWorkTypeCode,
      work_hours: dailyPreview.hoursFormatted,
      work_summary: dailyWorkSummary.trim() ? dailyWorkSummary.trim() : null,
    };

    busyRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await apiFetch(API_ENDPOINTS.SUBMIT_DAILY_REPORT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      const result = (await res.json()) as CostRegistrationResponse;
      setSubmitSuccess({
        modeLabel: "現場日報（出面・労務費）",
        documentNo: result.document_no,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      });
      setDailyWorkSummary("");
      await Promise.all([fetchLookups(true), onRegistered()]);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "現場日報の登録中に通信エラーが発生しました。"
      );
    } finally {
      busyRef.current = false;
      setIsSubmitting(false);
    }
  };

  const selectedEquipment = useMemo(() => {
    return (
      lookups?.equipments.find((eq) => eq.equipment_code === equipCode) ?? null
    );
  }, [lookups, equipCode]);

  const equipmentPreview = useMemo(() => {
    const fieldErrors: Record<string, string> = {};

    if (!equipCode || !selectedEquipment) {
      fieldErrors.equipment = "出庫する資機材・重機を選択してください。";
    }
    if (!equipWorkTypeCode || equipWorkTypeCode.length !== 12) {
      fieldErrors.workType = "対象の作業内容（工種）を選択してください。";
    }
    if (!isValidDateYmd(equipMovementDate.trim())) {
      fieldErrors.movementDate =
        "出庫日はYYYY-MM-DD形式で有効な日付を入力してください。";
    }

    const qtyParsed = parseDecimalScale3(equipQuantity, "出庫数量", false);
    if (qtyParsed.error) {
      fieldErrors.quantity = qtyParsed.error;
    }

    const daysParsed = parseNonNegativeYen(equipUsageDays, "使用日数");
    let usageDaysInt = 0;
    if (daysParsed.error) {
      fieldErrors.usageDays = daysParsed.error;
    } else if (daysParsed.value !== undefined) {
      if (daysParsed.value <= 0) {
        fieldErrors.usageDays = "使用日数は1日以上の整数を入力してください。";
      } else if (daysParsed.value > 36500) {
        fieldErrors.usageDays = "使用日数が上限を超えています。";
      } else {
        usageDaysInt = daysParsed.value;
      }
    }

    const freightParsed = parseNonNegativeYen(
      equipFreightFee,
      "運賃・回送費"
    );
    if (freightParsed.error) {
      fieldErrors.freightFee = freightParsed.error;
    }

    const maintParsed = parseNonNegativeYen(
      equipMaintenanceFee,
      "整備・基本料"
    );
    if (maintParsed.error) {
      fieldErrors.maintenanceFee = maintParsed.error;
    }

    let rentAmountYen: YenAmount = 0;
    let totalEquipmentCostYen: YenAmount = 0;

    if (
      selectedEquipment &&
      qtyParsed.dec &&
      usageDaysInt > 0 &&
      freightParsed.value !== undefined &&
      maintParsed.value !== undefined
    ) {
      // CONVENTIONS.md §3.4 round_half_up(quantity * daily_rent_price * days, 0) + freight_fee + maintenance_fee
      const dailyPriceDec = new Decimal(selectedEquipment.daily_rent_price);
      const rentDec = qtyParsed.dec
        .mul(dailyPriceDec)
        .mul(new Decimal(usageDaysInt))
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      const totalDec = rentDec
        .plus(freightParsed.value)
        .plus(maintParsed.value);

      if (
        totalDec.gt(MAX_YEN_DEC) ||
        !Number.isSafeInteger(totalDec.toNumber())
      ) {
        fieldErrors.amount = "計算後の機械損料合計が上限（15桁）を超えています。";
      } else {
        rentAmountYen = rentDec.toNumber();
        totalEquipmentCostYen = totalDec.toNumber();
      }
    }

    return {
      fieldErrors,
      isValid: Object.keys(fieldErrors).length === 0,
      qtyFormatted: qtyParsed.formatted ?? "0.000",
      usageDaysInt,
      freightYen: freightParsed.value ?? 0,
      maintenanceYen: maintParsed.value ?? 0,
      rentAmountYen,
      totalEquipmentCostYen,
    };
  }, [
    equipCode,
    selectedEquipment,
    equipWorkTypeCode,
    equipMovementDate,
    equipQuantity,
    equipUsageDays,
    equipFreightFee,
    equipMaintenanceFee,
  ]);

  const handleEquipmentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;

    setSubmitError(null);
    setSubmitSuccess(null);

    if (!selectedProject) {
      setSubmitError("対象の工事・枝番を選択してください。");
      return;
    }
    if (isBranchLocked(selectedProject.completion_status)) {
      setSubmitError(
        "選択された工事枝番は前期完成または計上ロック済のため、原価を登録できません。"
      );
      return;
    }
    if (!equipmentPreview.isValid) {
      const firstErr = Object.values(equipmentPreview.fieldErrors)[0];
      setSubmitError(firstErr ?? "入力内容を確認してください。");
      return;
    }

    const payload: EasyEquipmentMovementRequest = {
      company_code: companyCode,
      equipment_code: equipCode,
      dest_project_code: selectedProject.key.project_code,
      dest_branch_code: selectedProject.key.branch_code,
      work_type_code: equipWorkTypeCode,
      movement_date: equipMovementDate.trim(),
      quantity: equipmentPreview.qtyFormatted,
      usage_days: equipmentPreview.usageDaysInt,
      freight_fee: equipmentPreview.freightYen,
      maintenance_fee: equipmentPreview.maintenanceYen,
    };

    busyRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await apiFetch(API_ENDPOINTS.SUBMIT_EQUIPMENT_MOVEMENT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      const result = (await res.json()) as CostRegistrationResponse;
      setSubmitSuccess({
        modeLabel: "資機材出庫・機械損料",
        documentNo: result.document_no,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      });
      await Promise.all([fetchLookups(true), onRegistered()]);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "資機材出庫の登録中に通信エラーが発生しました。"
      );
    } finally {
      busyRef.current = false;
      setIsSubmitting(false);
    }
  };

  const branchLocked = selectedProject
    ? isBranchLocked(selectedProject.completion_status)
    : true;

  return (
    <div>
      {/* 共通ヘッダー＆工事枝番セレクタ */}
      <section className="card" aria-label="原価登録対象の工事選択">
        <div className="section-header">
          <div>
            <h2 className="section-title">
              ➕ かんたん原価登録（前提知識ゼロ・カード選択式）
            </h2>
            <p className="section-subtitle">
              専門的なコード入力は不要です。「どの工事で」「何が発生したか」を選ぶだけでリアルタイムに工事原価へ反映されます。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={isSubmitting || lookupsLoading}
            onClick={() => {
              void fetchLookups(false);
            }}
          >
            🔄 マスタ辞書を再読込
          </button>
        </div>

        <div className="selector-grid">
          <div className="form-field">
            <label htmlFor="easy-branch-select" className="form-label">
              ① 対象の工事・枝番（本工事／追加工事）を選択
            </label>
            <select
              id="easy-branch-select"
              className="form-select"
              value={selectedBranchKey}
              disabled={isSubmitting}
              onChange={(e) => {
                if (isSubmitting) return;
                setSelectedBranchKey(e.target.value);
                setSubmitError(null);
              }}
            >
              {projects.map((p) => {
                const key = `${p.key.project_code}::${p.key.branch_code}`;
                const locked = isBranchLocked(p.completion_status);
                return (
                  <option key={key} value={key} disabled={locked}>
                    [{p.key.project_code}-{p.key.branch_code}] {p.project_name}（
                    {p.branch_name}）— {completionStatusLabel(p.completion_status)}
                  </option>
                );
              })}
            </select>
          </div>

          {selectedProject && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "12px",
                padding: "10px 14px",
                backgroundColor: "var(--bg-subtle)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <span
                className={`status-badge status-${selectedProject.completion_status}`}
              >
                {completionStatusLabel(selectedProject.completion_status)}
              </span>
              <span style={{ fontSize: "0.88rem", fontWeight: 700 }}>
                実行予算: {formatYen(selectedProject.execution_budget_amount)}
              </span>
              <span style={{ fontSize: "0.88rem", fontWeight: 700 }}>
                現在発生原価: {formatYen(selectedProject.actual_occurred_cost)}
              </span>
            </div>
          )}
        </div>

        {selectedProject?.completion_status === "1" && (
          <div
            className="alert-banner alert-warning"
            style={{ marginTop: "12px" }}
            role="status"
          >
            <span>
              ⚠️ この工事枝番は「完成（区分1）」です。追加の原価登録は可能ですが、完成後の原価計上として警告が記録されます。
            </span>
          </div>
        )}

        {branchLocked && (
          <div
            className="alert-banner alert-danger"
            style={{ marginTop: "12px" }}
            role="alert"
          >
            <span>
              ⛔ 選択された工事枝番は「前期完成」または「計上ロック済」のため、新規の原価登録はできません。未成または当期完成の工事枝番を選択してください。
            </span>
          </div>
        )}
      </section>

      {/* マスタ取得エラー表示 */}
      {lookupsError && (
        <div
          className="alert-banner alert-danger"
          style={{ marginBottom: "18px", justifyContent: "space-between" }}
          role="alert"
        >
          <span>⚠️ マスタ辞書の取得に失敗しました：{lookupsError}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void fetchLookups(false);
            }}
          >
            再試行
          </button>
        </div>
      )}

      {/* 登録成功バナー */}
      {submitSuccess && (
        <div
          className="alert-banner alert-success"
          style={{
            marginBottom: "18px",
            flexDirection: "column",
            alignItems: "flex-start",
          }}
          role="status"
          aria-live="polite"
        >
          <div>
            ✅ <strong>{submitSuccess.modeLabel}</strong>
            を登録し、原価コックピットへ反映しました！（伝票番号:{" "}
            <span className="code-pill">{submitSuccess.documentNo}</span>）
          </div>
          {submitSuccess.warnings.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: "20px" }}>
              {submitSuccess.warnings.map((w, idx) => (
                <li key={idx} style={{ color: "var(--warning)" }}>
                  ⚠️ {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 送信エラーバナー */}
      {submitError && (
        <div
          className="alert-banner alert-danger"
          style={{ marginBottom: "18px" }}
          role="alert"
        >
          <span>⚠️ {submitError}</span>
        </div>
      )}

      {/* 4つの原価入力モード選択カードタブ */}
      <section className="card" aria-label="原価入力モードの選択">
        <div className="section-header" style={{ marginBottom: "10px" }}>
          <h3 className="section-title" style={{ fontSize: "0.98rem" }}>
            ② 何の原価を登録しますか？（4つのカードから選択）
          </h3>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "10px",
          }}
          role="tablist"
          aria-label="原価入力種別タブ"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "subcontract"}
            disabled={isSubmitting}
            onClick={() => {
              if (isSubmitting) return;
              setMode("subcontract");
              setSubmitError(null);
            }}
            className="card"
            style={{
              margin: 0,
              textAlign: "left",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              border:
                mode === "subcontract"
                  ? "2px solid var(--accent-primary)"
                  : "1px solid var(--border-color)",
              backgroundColor:
                mode === "subcontract" ? "#f0fdfa" : "var(--bg-card)",
            }}
          >
            <div style={{ fontSize: "1.3rem", marginBottom: "4px" }}>🏗️</div>
            <div style={{ fontWeight: 800, color: "var(--text-heading)" }}>
              外注さんの今月の出来高を入れる
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              外注費（進捗％スライダー・査定控除自動計算）
            </div>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={mode === "direct"}
            disabled={isSubmitting}
            onClick={() => {
              if (isSubmitting) return;
              setMode("direct");
              setSubmitError(null);
            }}
            className="card"
            style={{
              margin: 0,
              textAlign: "left",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              border:
                mode === "direct"
                  ? "2px solid var(--accent-primary)"
                  : "1px solid var(--border-color)",
              backgroundColor: mode === "direct" ? "#f0fdfa" : "var(--bg-card)",
            }}
          >
            <div style={{ fontSize: "1.3rem", marginBottom: "4px" }}>🧱</div>
            <div style={{ fontWeight: 800, color: "var(--text-heading)" }}>
              買った材料・現場経費を入れる
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              材料費・現場経費（品目カード1クリック選択）
            </div>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={mode === "daily"}
            disabled={isSubmitting}
            onClick={() => {
              if (isSubmitting) return;
              setMode("daily");
              setSubmitError(null);
            }}
            className="card"
            style={{
              margin: 0,
              textAlign: "left",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              border:
                mode === "daily"
                  ? "2px solid var(--accent-primary)"
                  : "1px solid var(--border-color)",
              backgroundColor: mode === "daily" ? "#f0fdfa" : "var(--bg-card)",
            }}
          >
            <div style={{ fontSize: "1.3rem", marginBottom: "4px" }}>👷</div>
            <div style={{ fontWeight: 800, color: "var(--text-heading)" }}>
              今日の現場日報（出面）をつける
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              労務費（誰が・どの作業に・何時間入ったか）
            </div>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={mode === "equipment"}
            disabled={isSubmitting}
            onClick={() => {
              if (isSubmitting) return;
              setMode("equipment");
              setSubmitError(null);
            }}
            className="card"
            style={{
              margin: 0,
              textAlign: "left",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              border:
                mode === "equipment"
                  ? "2px solid var(--accent-primary)"
                  : "1px solid var(--border-color)",
              backgroundColor:
                mode === "equipment" ? "#f0fdfa" : "var(--bg-card)",
            }}
          >
            <div style={{ fontSize: "1.3rem", marginBottom: "4px" }}>🚜</div>
            <div style={{ fontWeight: 800, color: "var(--text-heading)" }}>
              資機材・重機の現場出庫を入れる
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              機械・仮設損料（日単価×日数＋運賃自動計算）
            </div>
          </button>
        </div>
      </section>

      {lookupsLoading && !lookups ? (
        <section className="card state-box" aria-live="polite">
          <p style={{ margin: 0, fontWeight: 700 }}>
            かんたん入力用のマスタ辞書を読み込んでいます...
          </p>
        </section>
      ) : mode === "subcontract" ? (
        /* ====================================================================
         * タブ1：外注出来高査定フォーム
         * ==================================================================== */
        <section
          className="card"
          aria-label="外注さんの今月の出来高を入れるフォーム"
        >
          <div className="section-header">
            <div>
              <h3 className="section-title">
                🏗️ 外注さんの今月の出来高を入れる（外注費）
              </h3>
              <p className="section-subtitle">
                発注済みの注文書を選び、「今回どこまで進んだか（累計進捗％または今回査定税抜額）」を入力してください。
              </p>
            </div>
          </div>

          {branchOrders.length === 0 ? (
            <div className="state-box">
              <p style={{ margin: 0, fontWeight: 700 }}>
                選択中の工事枝番（{selectedProject?.project_name} /{" "}
                {selectedProject?.branch_name}）には承認済みの外注注文書がありません。
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubcontractSubmit} noValidate>
              {/* 注文書選択カード */}
              <div className="form-field" style={{ marginBottom: "16px" }}>
                <label htmlFor="subcontract-order-select" className="form-label">
                  対象の外注注文書を選択
                </label>
                <select
                  id="subcontract-order-select"
                  className="form-select"
                  value={selectedOrderNumber}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => handleSelectOrder(e.target.value)}
                >
                  {branchOrders.map((o) => (
                    <option key={o.order_number} value={o.order_number}>
                      [{o.order_number}] {o.subcontractor_name} — {o.work_type_name}
                      （発注額: {formatYen(o.order_amount_tax_ex)} / 発注残:{" "}
                      {formatYen(o.remaining_order_balance)}）
                    </option>
                  ))}
                </select>
              </div>

              {selectedOrder && subcontractPreview && (
                <>
                  {/* 選択中の注文書サマリ */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: "10px",
                      padding: "12px",
                      backgroundColor: "var(--bg-subtle)",
                      borderRadius: "var(--radius-sm)",
                      marginBottom: "16px",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        外注先・工種
                      </div>
                      <div style={{ fontWeight: 700 }}>
                        {selectedOrder.subcontractor_name}（
                        {selectedOrder.work_type_name}）
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        発注契約額（税抜・改定No.{selectedOrder.order_history_no}）
                      </div>
                      <div style={{ fontWeight: 800 }}>
                        {formatYen(selectedOrder.order_amount_tax_ex)}
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        前回まで査定累計（税抜）
                      </div>
                      <div style={{ fontWeight: 700 }}>
                        {formatYen(selectedOrder.accum_assessed_amount_tax_ex)}（
                        {subcontractPreview.prevProgressPct}%）
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        残り査定可能枠（発注残）
                      </div>
                      <div
                        style={{
                          fontWeight: 800,
                          color: "var(--accent-primary)",
                        }}
                      >
                        {formatYen(selectedOrder.remaining_order_balance)}
                      </div>
                    </div>
                  </div>

                  {/* スライダー＆直接金額入力 */}
                  <div className="form-grid form-grid-2">
                    <div className="form-field">
                      <label
                        htmlFor="subcontract-progress-slider"
                        className="form-label"
                      >
                        今回どこまで進みましたか？（累計進捗率: 0%〜100%）
                      </label>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                        }}
                      >
                        <input
                          id="subcontract-progress-slider"
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          style={{ flex: 1 }}
                          value={progressPercentStr}
                          disabled={isSubmitting || branchLocked}
                          onChange={(e) =>
                            handleProgressSliderChange(e.target.value)
                          }
                        />
                        <span
                          style={{
                            minWidth: "74px",
                            textAlign: "right",
                            fontWeight: 800,
                            fontSize: "1.1rem",
                            color: "var(--accent-primary)",
                          }}
                        >
                          {subcontractPreview.newProgressPct}%
                        </span>
                      </div>
                      <div
                        className="chip-group"
                        style={{ marginTop: "6px" }}
                      >
                        {[25, 50, 75, 100].map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            className="chip-btn"
                            disabled={isSubmitting || branchLocked}
                            onClick={() =>
                              handleProgressSliderChange(String(pct))
                            }
                          >
                            累計 {pct}%
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="form-field">
                      <label
                        htmlFor="subcontract-curr-amount"
                        className="form-label"
                      >
                        今回査定金額（税抜・円）※直接入力も可
                      </label>
                      <input
                        id="subcontract-curr-amount"
                        type="number"
                        inputMode="numeric"
                        className="form-input"
                        value={currAssessedInput}
                        disabled={isSubmitting || branchLocked}
                        onChange={(e) =>
                          handleCurrAssessedDirectChange(e.target.value)
                        }
                      />
                      {subcontractPreview.fieldErrors.currAssessed && (
                        <span
                          className="text-danger"
                          style={{ fontSize: "0.82rem" }}
                        >
                          {subcontractPreview.fieldErrors.currAssessed}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 対象年月・定額控除・立替相殺 */}
                  <div
                    className="form-grid form-grid-3"
                    style={{ marginTop: "14px" }}
                  >
                    <div className="form-field">
                      <label
                        htmlFor="subcontract-ym-input"
                        className="form-label"
                      >
                        査定対象年月（YYYYMM）
                      </label>
                      <input
                        id="subcontract-ym-input"
                        type="text"
                        maxLength={6}
                        placeholder="202610"
                        className="form-input"
                        value={assessmentYm}
                        disabled={isSubmitting || branchLocked}
                        onChange={(e) => setAssessmentYm(e.target.value)}
                      />
                      {subcontractPreview.fieldErrors.assessmentYm && (
                        <span
                          className="text-danger"
                          style={{ fontSize: "0.82rem" }}
                        >
                          {subcontractPreview.fieldErrors.assessmentYm}
                        </span>
                      )}
                    </div>

                    <div className="form-field">
                      <label
                        htmlFor="subcontract-fixed-deduction"
                        className="form-label"
                      >
                        その他定額控除（円）
                      </label>
                      <input
                        id="subcontract-fixed-deduction"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        className="form-input"
                        value={fixedDeductionsInput}
                        disabled={isSubmitting || branchLocked}
                        onChange={(e) =>
                          setFixedDeductionsInput(e.target.value)
                        }
                      />
                      {subcontractPreview.fieldErrors.fixedDeductions && (
                        <span
                          className="text-danger"
                          style={{ fontSize: "0.82rem" }}
                        >
                          {subcontractPreview.fieldErrors.fixedDeductions}
                        </span>
                      )}
                    </div>

                    <div className="form-field">
                      <label
                        htmlFor="subcontract-chargeback-offset"
                        className="form-label"
                      >
                        支給材・立替相殺額（円）
                      </label>
                      <input
                        id="subcontract-chargeback-offset"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        className="form-input"
                        value={chargebackOffsetInput}
                        disabled={isSubmitting || branchLocked}
                        onChange={(e) =>
                          setChargebackOffsetInput(e.target.value)
                        }
                      />
                      {subcontractPreview.fieldErrors.chargebackOffset && (
                        <span
                          className="text-danger"
                          style={{ fontSize: "0.82rem" }}
                        >
                          {subcontractPreview.fieldErrors.chargebackOffset}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 自動計算プレビューボックス */}
                  <div className="preview-box" aria-live="polite">
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "8px",
                        marginBottom: "10px",
                      }}
                    >
                      <strong style={{ color: "var(--text-heading)" }}>
                        📊 外注出来高・支払控除プレビュー — 概算（確定時に再計算）
                      </strong>
                      <span
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        ※工事原価には控除前の「今回査定税抜額」が計上されます
                      </span>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(190px, 1fr))",
                        gap: "12px",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          今回工事原価計上額（外注費・税抜）
                        </div>
                        <div
                          style={{
                            fontSize: "1.25rem",
                            fontWeight: 800,
                            color: "var(--accent-primary)",
                          }}
                        >
                          {formatYen(subcontractPreview.currAssessedYen)}
                        </div>
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          今回消費税額（契約税率{" "}
                          {subcontractPreview.taxRatePctLabel}・累計差額切捨）
                        </div>
                        <div style={{ fontSize: "1.08rem", fontWeight: 700 }}>
                          +{formatYen(subcontractPreview.currTaxYen)}
                        </div>
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          保留金控除（契約率{" "}
                          {subcontractPreview.retainageRateLabel}・端数切捨）
                        </div>
                        <div style={{ fontSize: "1.08rem", fontWeight: 700 }}>
                          -{formatYen(subcontractPreview.retainageYen)}
                        </div>
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          安全協力会費控除（契約率{" "}
                          {subcontractPreview.safetyRateLabel}・端数切捨）
                        </div>
                        <div style={{ fontSize: "1.08rem", fontWeight: 700 }}>
                          -{formatYen(subcontractPreview.safetyFeeYen)}
                        </div>
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          差引振込予定額（税込査定 − 控除計）
                        </div>
                        <div
                          style={{
                            fontSize: "1.25rem",
                            fontWeight: 800,
                            color:
                              subcontractPreview.netPaymentYen < 0
                                ? "var(--danger)"
                                : "var(--text-heading)",
                          }}
                        >
                          {formatYen(subcontractPreview.netPaymentYen)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginTop: "14px",
                    }}
                  >
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={
                        isSubmitting ||
                        branchLocked ||
                        !subcontractPreview.isValid
                      }
                    >
                      {isSubmitting
                        ? "出来高を登録中..."
                        : "✅ この内容で出来高を確定する"}
                    </button>
                  </div>
                </>
              )}
            </form>
          )}
        </section>
      ) : mode === "direct" ? (
        /* ====================================================================
         * タブ2：材料費・現場経費フォーム
         * ==================================================================== */
        <section
          className="card"
          aria-label="買った材料・現場経費を入れるフォーム"
        >
          <div className="section-header">
            <div>
              <h3 className="section-title">
                🧱 買った材料・現場経費を入れる（材料費・現場経費）
              </h3>
              <p className="section-subtitle">
                「何を買いましたか？／何を使いましたか？」を下のカードから選ぶだけで、工種と費目区分が自動セットされます。
              </p>
            </div>
          </div>

          <form onSubmit={handleDirectCostSubmit} noValidate>
            {/* 品目テンプレートカード一覧 */}
            <div className="form-field" style={{ marginBottom: "16px" }}>
              <span className="form-label">
                かんたん品目カードから1クリック選択
              </span>
              <div className="chip-group">
                {(lookups?.quick_templates ?? []).map((tpl) => {
                  const active = selectedTemplateCode === tpl.template_code;
                  const catBadge =
                    tpl.cost_element_code === "0100" ? "材料費" : "現場経費";
                  return (
                    <button
                      key={tpl.template_code}
                      type="button"
                      disabled={isSubmitting || branchLocked}
                      className={`chip-btn ${active ? "active" : ""}`}
                      onClick={() => {
                        if (isSubmitting) return;
                        applyQuickTemplate(tpl);
                        setSubmitError(null);
                      }}
                    >
                      {tpl.item_label}（{catBadge} / 標準{" "}
                      {formatYen(
                        new Decimal(tpl.default_unit_price)
                          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                          .toNumber()
                      )}
                      /{tpl.default_unit}）
                    </button>
                  );
                })}
              </div>
              {directPreview.fieldErrors.template && (
                <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                  {directPreview.fieldErrors.template}
                </span>
              )}
            </div>

            {/* 自動セットされた費目種別と作業内容（手動変更も可・専門コード暗記不要） */}
            <div className="form-grid form-grid-3">
              <div className="form-field">
                <label htmlFor="direct-category-select" className="form-label">
                  原価の種類（自動セット・変更可）
                </label>
                <select
                  id="direct-category-select"
                  className="form-select"
                  value={directCostElement}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) =>
                    setDirectCostElement(
                      e.target.value as "0100" | "0400" | ""
                    )
                  }
                >
                  <option value="">-- 選択してください --</option>
                  <option value="0100">🧱 現場の材料費</option>
                  <option value="0400">🧾 現場の経費（産廃・駐車場・光熱費など）</option>
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="direct-work-type-select" className="form-label">
                  対象の作業内容（工種・自動セット）
                </label>
                <select
                  id="direct-work-type-select"
                  className="form-select"
                  value={directWorkTypeCode}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectWorkTypeCode(e.target.value)}
                >
                  <option value="">-- 作業内容を選択 --</option>
                  {(lookups?.work_types ?? []).map((wt) => (
                    <option key={wt.work_type_code} value={wt.work_type_code}>
                      {wt.work_type_name}
                    </option>
                  ))}
                  {directWorkTypeCode &&
                    !(lookups?.work_types ?? []).some(
                      (w) => w.work_type_code === directWorkTypeCode
                    ) && (
                      <option value={directWorkTypeCode}>
                        {workTypeNameMap.get(directWorkTypeCode) ??
                          "選択品目の標準工種"}
                      </option>
                    )}
                </select>
                {directPreview.fieldErrors.workType && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {directPreview.fieldErrors.workType}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="direct-occurred-date" className="form-label">
                  購入日・発生日
                </label>
                <input
                  id="direct-occurred-date"
                  type="date"
                  className="form-input"
                  value={directOccurredDate}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectOccurredDate(e.target.value)}
                />
                {directPreview.fieldErrors.occurredDate && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {directPreview.fieldErrors.occurredDate}
                  </span>
                )}
              </div>
            </div>

            {/* 品名・規格・仕入先 */}
            <div
              className="form-grid form-grid-3"
              style={{ marginTop: "14px" }}
            >
              <div className="form-field">
                <label htmlFor="direct-item-name" className="form-label">
                  品名・内容
                </label>
                <input
                  id="direct-item-name"
                  type="text"
                  className="form-input"
                  placeholder="例: 生コンクリート 21-18-20"
                  value={directItemName}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectItemName(e.target.value)}
                />
                {directPreview.fieldErrors.itemName && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {directPreview.fieldErrors.itemName}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="direct-spec-input" className="form-label">
                  規格・寸法（任意）
                </label>
                <input
                  id="direct-spec-input"
                  type="text"
                  className="form-input"
                  placeholder="例: 呼び強度21 スランプ18cm"
                  value={directSpecification}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectSpecification(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="direct-supplier-select" className="form-label">
                  購入先・支払先（任意）
                </label>
                <select
                  id="direct-supplier-select"
                  className="form-select"
                  value={directVendorCode}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectVendorCode(e.target.value)}
                >
                  <option value="">-- 指定なし（現金・一般購入） --</option>
                  {(lookups?.suppliers ?? []).map((sup) => (
                    <option key={sup.partner_code} value={sup.partner_code}>
                      {sup.partner_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 数量・単位・単価 */}
            <div
              className="form-grid form-grid-3"
              style={{ marginTop: "14px" }}
            >
              <div className="form-field">
                <label htmlFor="direct-quantity-input" className="form-label">
                  数量（小数第3位まで）
                </label>
                <input
                  id="direct-quantity-input"
                  type="number"
                  step="0.001"
                  min="0"
                  className="form-input"
                  value={directQuantity}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectQuantity(e.target.value)}
                />
                {directPreview.fieldErrors.quantity && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {directPreview.fieldErrors.quantity}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="direct-unit-input" className="form-label">
                  単位
                </label>
                <input
                  id="direct-unit-input"
                  type="text"
                  className="form-input"
                  placeholder="m3, t, 式, 台"
                  value={directUnit}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectUnit(e.target.value)}
                />
                {directPreview.fieldErrors.unit && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {directPreview.fieldErrors.unit}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="direct-unit-price-input" className="form-label">
                  単価（税抜・円）
                </label>
                <input
                  id="direct-unit-price-input"
                  type="number"
                  step="1"
                  min="0"
                  className="form-input"
                  value={directUnitPrice}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDirectUnitPrice(e.target.value)}
                />
                {directPreview.fieldErrors.unitPrice && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {directPreview.fieldErrors.unitPrice}
                  </span>
                )}
              </div>
            </div>

            <div className="form-field" style={{ marginTop: "14px" }}>
              <label htmlFor="direct-notes-input" className="form-label">
                現場メモ・備考（任意）
              </label>
              <input
                id="direct-notes-input"
                type="text"
                className="form-input"
                placeholder="例: 北側擁壁ベース打設分"
                value={directNotes}
                disabled={isSubmitting || branchLocked}
                onChange={(e) => setDirectNotes(e.target.value)}
              />
            </div>

            {/* 自動計算プレビュー */}
            <div className="preview-box" aria-live="polite">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <div>
                  <div
                    style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}
                  >
                    自動計算された発生原価（数量 × 単価・小数第1位四捨五入）— 概算（確定時に再計算）
                  </div>
                  <div
                    style={{
                      fontSize: "1.35rem",
                      fontWeight: 800,
                      color: "var(--accent-primary)",
                    }}
                  >
                    {formatYen(directPreview.calculatedAmountYen)}
                  </div>
                  {directPreview.fieldErrors.amount && (
                    <div
                      className="text-danger"
                      style={{ fontSize: "0.82rem" }}
                    >
                      {directPreview.fieldErrors.amount}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    isSubmitting || branchLocked || !directPreview.isValid
                  }
                >
                  {isSubmitting
                    ? "原価を登録中..."
                    : "✅ この材料・経費を原価登録する"}
                </button>
              </div>
            </div>
          </form>
        </section>
      ) : mode === "daily" ? (
        /* ====================================================================
         * タブ3：今日の現場日報（出面）をつけるフォーム
         * ==================================================================== */
        <section
          className="card"
          aria-label="今日の現場日報（出面）をつけるフォーム"
        >
          <div className="section-header">
            <div>
              <h3 className="section-title">
                👷 今日の現場日報（出面）をつける（労務費・スマホ3タップ）
              </h3>
              <p className="section-subtitle">
                ①誰が、②どの作業に、③何時間入ったかを選ぶだけで、作業員の標準日額から本日の概算労務原価を自動計上します。
              </p>
            </div>
          </div>

          <form onSubmit={handleDailyReportSubmit} noValidate>
            {/* ① 誰が？（作業員カード選択） */}
            <div className="form-field" style={{ marginBottom: "16px" }}>
              <label htmlFor="daily-employee-select" className="form-label">
                ① 誰が作業しましたか？（作業員カード選択）
              </label>
              <div className="chip-group" style={{ marginBottom: "8px" }}>
                {(lookups?.employees ?? []).map((emp) => {
                  const active = dailyEmployeeCode === emp.employee_code;
                  return (
                    <button
                      key={emp.employee_code}
                      type="button"
                      disabled={isSubmitting || branchLocked}
                      className={`chip-btn ${active ? "active" : ""}`}
                      onClick={() => {
                        if (isSubmitting) return;
                        setDailyEmployeeCode(emp.employee_code);
                        setSubmitError(null);
                      }}
                    >
                      👷 {emp.employee_name}（標準日額:{" "}
                      {formatYen(emp.standard_daily_wage)}）
                    </button>
                  );
                })}
              </div>
              <select
                id="daily-employee-select"
                className="form-select"
                value={dailyEmployeeCode}
                disabled={isSubmitting || branchLocked}
                onChange={(e) => setDailyEmployeeCode(e.target.value)}
              >
                <option value="">-- 作業員を選択 --</option>
                {(lookups?.employees ?? []).map((emp) => (
                  <option key={emp.employee_code} value={emp.employee_code}>
                    {emp.employee_name}（標準日額:{" "}
                    {formatYen(emp.standard_daily_wage)}）
                  </option>
                ))}
              </select>
              {dailyPreview.fieldErrors.employee && (
                <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                  {dailyPreview.fieldErrors.employee}
                </span>
              )}
            </div>

            {/* ② どの作業に？ ＆ 作業日 */}
            <div className="form-grid form-grid-2">
              <div className="form-field">
                <label htmlFor="daily-work-type-select" className="form-label">
                  ② どの作業に入りましたか？（作業内容・工種）
                </label>
                <select
                  id="daily-work-type-select"
                  className="form-select"
                  value={dailyWorkTypeCode}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDailyWorkTypeCode(e.target.value)}
                >
                  <option value="">-- 作業内容を選択 --</option>
                  {(lookups?.work_types ?? []).map((wt) => (
                    <option key={wt.work_type_code} value={wt.work_type_code}>
                      {wt.work_type_name}
                    </option>
                  ))}
                </select>
                {dailyPreview.fieldErrors.workType && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {dailyPreview.fieldErrors.workType}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="daily-work-date-input" className="form-label">
                  作業日
                </label>
                <input
                  id="daily-work-date-input"
                  type="date"
                  className="form-input"
                  value={dailyWorkDate}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDailyWorkDate(e.target.value)}
                />
                {dailyPreview.fieldErrors.workDate && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {dailyPreview.fieldErrors.workDate}
                  </span>
                )}
              </div>
            </div>

            {/* ③ 何時間入った？（クイックボタン + 数値入力） */}
            <div
              className="form-grid form-grid-2"
              style={{ marginTop: "14px" }}
            >
              <div className="form-field">
                <label htmlFor="daily-work-hours-input" className="form-label">
                  ③ 何時間入りましたか？（クイック選択または直接入力）
                </label>
                <div className="chip-group" style={{ marginBottom: "8px" }}>
                  {[
                    { hours: "8.0", label: "8.0時間 (1.0人工)" },
                    { hours: "4.0", label: "4.0時間 (0.5人工)" },
                    { hours: "10.0", label: "10.0時間 (残業2h)" },
                  ].map((q) => {
                    let isSelected = false;
                    try {
                      isSelected = new Decimal(dailyWorkHours).eq(
                        new Decimal(q.hours)
                      );
                    } catch {
                      isSelected = false;
                    }
                    return (
                      <button
                        key={q.hours}
                        type="button"
                        disabled={isSubmitting || branchLocked}
                        className={`chip-btn ${isSelected ? "active" : ""}`}
                        onClick={() => setDailyWorkHours(q.hours)}
                      >
                        ⏱️ {q.label}
                      </button>
                    );
                  })}
                </div>
                <input
                  id="daily-work-hours-input"
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="24"
                  className="form-input"
                  value={dailyWorkHours}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDailyWorkHours(e.target.value)}
                />
                {dailyPreview.fieldErrors.workHours && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {dailyPreview.fieldErrors.workHours}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="daily-summary-input" className="form-label">
                  作業メモ・日報摘要（任意）
                </label>
                <input
                  id="daily-summary-input"
                  type="text"
                  className="form-input"
                  placeholder="例: 基礎型枠組立・コンクリート打設相番"
                  value={dailyWorkSummary}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setDailyWorkSummary(e.target.value)}
                />
              </div>
            </div>

            {/* 自動計算プレビュー */}
            <div className="preview-box" aria-live="polite">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <div>
                  <div
                    style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}
                  >
                    本日の概算労務原価（標準日額 × 作業時間 ÷ 8.0h・小数第1位四捨五入）— 概算（確定時に再計算）
                  </div>
                  <div
                    style={{
                      fontSize: "1.35rem",
                      fontWeight: 800,
                      color: "var(--accent-primary)",
                    }}
                  >
                    {formatYen(dailyPreview.estimatedLaborCostYen)}
                  </div>
                  {dailyPreview.fieldErrors.amount && (
                    <div
                      className="text-danger"
                      style={{ fontSize: "0.82rem" }}
                    >
                      {dailyPreview.fieldErrors.amount}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    isSubmitting || branchLocked || !dailyPreview.isValid
                  }
                >
                  {isSubmitting
                    ? "現場日報を登録中..."
                    : "✅ この内容で現場日報（出面）を登録する"}
                </button>
              </div>
            </div>
          </form>
        </section>
      ) : (
        /* ====================================================================
         * タブ4：資機材・重機の現場出庫を入れるフォーム
         * ==================================================================== */
        <section
          className="card"
          aria-label="資機材・重機の現場出庫を入れるフォーム"
        >
          <div className="section-header">
            <div>
              <h3 className="section-title">
                🚜 資機材・重機の現場出庫を入れる（機械・仮設損料）
              </h3>
              <p className="section-subtitle">
                出庫する資機材・重機を選び、数量・使用日数・運賃を入力すると「日単価 × 数量 × 日数 ＋ 運賃 ＋ 整備費」を自動計算します。
              </p>
            </div>
          </div>

          <form onSubmit={handleEquipmentSubmit} noValidate>
            {/* 資機材カード選択 */}
            <div className="form-field" style={{ marginBottom: "16px" }}>
              <label htmlFor="equip-select" className="form-label">
                どの資機材・重機を現場へ出庫しましたか？
              </label>
              <div className="chip-group" style={{ marginBottom: "8px" }}>
                {(lookups?.equipments ?? []).map((eq) => {
                  const active = equipCode === eq.equipment_code;
                  const priceLabel = formatYen(
                    new Decimal(eq.daily_rent_price)
                      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                      .toNumber()
                  );
                  return (
                    <button
                      key={eq.equipment_code}
                      type="button"
                      disabled={isSubmitting || branchLocked}
                      className={`chip-btn ${active ? "active" : ""}`}
                      onClick={() => {
                        if (isSubmitting) return;
                        setEquipCode(eq.equipment_code);
                        setSubmitError(null);
                      }}
                    >
                      🚜 {eq.equipment_name}（日単価: {priceLabel}/{eq.unit}・日）
                    </button>
                  );
                })}
              </div>
              <select
                id="equip-select"
                className="form-select"
                value={equipCode}
                disabled={isSubmitting || branchLocked}
                onChange={(e) => setEquipCode(e.target.value)}
              >
                <option value="">-- 資機材・重機を選択 --</option>
                {(lookups?.equipments ?? []).map((eq) => (
                  <option key={eq.equipment_code} value={eq.equipment_code}>
                    {eq.equipment_name}（日単価:{" "}
                    {formatYen(
                      new Decimal(eq.daily_rent_price)
                        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                        .toNumber()
                    )}
                    /{eq.unit}・日）
                  </option>
                ))}
              </select>
              {equipmentPreview.fieldErrors.equipment && (
                <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                  {equipmentPreview.fieldErrors.equipment}
                </span>
              )}
            </div>

            {/* 作業内容（工種）と出庫日 */}
            <div className="form-grid form-grid-2">
              <div className="form-field">
                <label htmlFor="equip-work-type-select" className="form-label">
                  対象の作業内容（工種）
                </label>
                <select
                  id="equip-work-type-select"
                  className="form-select"
                  value={equipWorkTypeCode}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setEquipWorkTypeCode(e.target.value)}
                >
                  <option value="">-- 作業内容を選択 --</option>
                  {(lookups?.work_types ?? []).map((wt) => (
                    <option key={wt.work_type_code} value={wt.work_type_code}>
                      {wt.work_type_name}
                    </option>
                  ))}
                </select>
                {equipmentPreview.fieldErrors.workType && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {equipmentPreview.fieldErrors.workType}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label
                  htmlFor="equip-movement-date-input"
                  className="form-label"
                >
                  現場出庫日
                </label>
                <input
                  id="equip-movement-date-input"
                  type="date"
                  className="form-input"
                  value={equipMovementDate}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setEquipMovementDate(e.target.value)}
                />
                {equipmentPreview.fieldErrors.movementDate && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {equipmentPreview.fieldErrors.movementDate}
                  </span>
                )}
              </div>
            </div>

            {/* 数量・使用日数・運賃・整備費 */}
            <div
              className="form-grid form-grid-2"
              style={{ marginTop: "14px" }}
            >
              <div className="form-field">
                <label htmlFor="equip-quantity-input" className="form-label">
                  出庫数量（単位: {selectedEquipment?.unit ?? "式"}）
                </label>
                <input
                  id="equip-quantity-input"
                  type="number"
                  step="0.001"
                  min="0"
                  className="form-input"
                  value={equipQuantity}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setEquipQuantity(e.target.value)}
                />
                {equipmentPreview.fieldErrors.quantity && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {equipmentPreview.fieldErrors.quantity}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="equip-usage-days-input" className="form-label">
                  使用日数（日・正の整数）
                </label>
                <input
                  id="equip-usage-days-input"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min="1"
                  className="form-input"
                  value={equipUsageDays}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setEquipUsageDays(e.target.value)}
                />
                {equipmentPreview.fieldErrors.usageDays && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {equipmentPreview.fieldErrors.usageDays}
                  </span>
                )}
              </div>
            </div>

            <div
              className="form-grid form-grid-2"
              style={{ marginTop: "14px" }}
            >
              <div className="form-field">
                <label htmlFor="equip-freight-input" className="form-label">
                  運賃・回送費（円）
                </label>
                <input
                  id="equip-freight-input"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min="0"
                  className="form-input"
                  value={equipFreightFee}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setEquipFreightFee(e.target.value)}
                />
                {equipmentPreview.fieldErrors.freightFee && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {equipmentPreview.fieldErrors.freightFee}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor="equip-maintenance-input" className="form-label">
                  整備費・基本管理料（円）
                </label>
                <input
                  id="equip-maintenance-input"
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min="0"
                  className="form-input"
                  value={equipMaintenanceFee}
                  disabled={isSubmitting || branchLocked}
                  onChange={(e) => setEquipMaintenanceFee(e.target.value)}
                />
                {equipmentPreview.fieldErrors.maintenanceFee && (
                  <span className="text-danger" style={{ fontSize: "0.82rem" }}>
                    {equipmentPreview.fieldErrors.maintenanceFee}
                  </span>
                )}
              </div>
            </div>

            {/* 自動計算プレビュー */}
            <div className="preview-box" aria-live="polite">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <div>
                  <div
                    style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}
                  >
                    自動計算された機械・仮設損料（基本損料{" "}
                    {formatYen(equipmentPreview.rentAmountYen)} ＋ 運賃{" "}
                    {formatYen(equipmentPreview.freightYen)} ＋ 整備費{" "}
                    {formatYen(equipmentPreview.maintenanceYen)}）— 概算（確定時に再計算）
                  </div>
                  <div
                    style={{
                      fontSize: "1.35rem",
                      fontWeight: 800,
                      color: "var(--accent-primary)",
                    }}
                  >
                    {formatYen(equipmentPreview.totalEquipmentCostYen)}
                  </div>
                  {equipmentPreview.fieldErrors.amount && (
                    <div
                      className="text-danger"
                      style={{ fontSize: "0.82rem" }}
                    >
                      {equipmentPreview.fieldErrors.amount}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    isSubmitting || branchLocked || !equipmentPreview.isValid
                  }
                >
                  {isSubmitting
                    ? "出庫・損料を登録中..."
                    : "✅ この資機材出庫・機械損料を登録する"}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}
    </div>
  );
};

export default EasyCostInput;
