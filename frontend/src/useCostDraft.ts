import { useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { API_ENDPOINTS, CostRegistrationResponse, EasyDailyReportRequest, EasyDirectCostRequest, EasyEquipmentMovementRequest, EasySubcontractProgressRequest, LookupsDto, ProjectCostCockpitDto, QuickItemTemplateDto } from "./bindings";
import { apiFetch } from "./auth";
import { describeFailure, Guidance, HttpError } from "./errors";

export type InputMode = "subcontract" | "direct" | "daily" | "equipment";
export const modeLabels: Record<InputMode, string> = { subcontract: "外注の出来高", direct: "材料・経費", daily: "作業日報", equipment: "資機材の使用" };
const MAX_YEN = new Decimal("999999999999999");
export const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const dateValid = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y = 0, m = 0, d = 0] = value.split("-").map(Number); const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
};
export function isBranchLocked(status: string, allowCompleted: boolean) { return status === "2" || status === "3" || (status === "1" && !allowCompleted); }
export function completionLabel(status: string, allowCompleted: boolean) {
  return status === "0" ? "施工中" : status === "1" ? allowCompleted ? "完成 · 注意して登録" : "完成 · 承認権限のみ登録可" : status === "2" ? "前期完成 · 登録不可" : "ロック済 · 登録不可";
}
function yen(raw: string, label: string): { value: number; error?: string } {
  if (!/^\d+$/.test(raw.trim())) return { value: 0, error: `${label}は0以上の整数で入力してください。` };
  const dec = new Decimal(raw.trim());
  if (dec.gt(MAX_YEN) || !Number.isSafeInteger(dec.toNumber())) return { value: 0, error: `${label}は15桁以内で入力してください。` };
  return { value: dec.toNumber() };
}
function quantity(raw: string, label: string): { dec: Decimal | null; formatted: string; error?: string } {
  if (!/^\d+(\.\d{1,3})?$/.test(raw.trim())) return { dec: null, formatted: "0.000", error: `${label}は小数第3位までの正の数で入力してください。` };
  const dec = new Decimal(raw.trim());
  if (dec.lte(0) || dec.gte("1000000000000")) return { dec: null, formatted: "0.000", error: `${label}は0より大きく、整数部12桁以内で入力してください。` };
  return { dec, formatted: dec.toFixed(3) };
}
function safeAmount(dec: Decimal) { return dec.lte(MAX_YEN) && Number.isSafeInteger(dec.toNumber()); }
function initialDirect(lookups: LookupsDto | null) {
  const tpl = lookups?.quick_templates[0];
  return { templateCode: tpl?.template_code ?? "", itemName: tpl?.item_label ?? "", specification: "", workType: tpl?.work_type_code ?? "", costElement: (tpl?.cost_element_code ?? "") as "0100" | "0400" | "", unit: tpl?.default_unit ?? "", quantity: "1", price: tpl ? new Decimal(tpl.default_unit_price).toString() : "", date: today(), vendor: "", notes: "" };
}
const initialSub = () => ({ orderNo: "", month: today().slice(0, 7), progress: "0", amount: "0", fixed: "0", offset: "0" });
const initialDaily = (lookups: LookupsDto | null) => ({ employee: lookups?.employees[0]?.employee_code ?? "", workType: lookups?.work_types[0]?.work_type_code ?? "", date: today(), hours: "8.0", summary: "" });
const initialEquip = (lookups: LookupsDto | null) => ({ equipment: lookups?.equipments[0]?.equipment_code ?? "", workType: lookups?.work_types[0]?.work_type_code ?? "", date: today(), quantity: "1", days: "1", freight: "0", maintenance: "0" });
export type DirectDraft = ReturnType<typeof initialDirect>;
export type SubDraft = ReturnType<typeof initialSub>;
export type DailyDraft = ReturnType<typeof initialDaily>;
export type EquipDraft = ReturnType<typeof initialEquip>;
export type FieldErrors = Record<string, string>;

export function useCostDraft({ lookups, project, companyCode, allowCompleted, onRegistered, onDirtyChange, onBusyChange }: {
  lookups: LookupsDto | null; project: ProjectCostCockpitDto | null; companyCode: string; allowCompleted: boolean;
  onRegistered: () => Promise<boolean>; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void;
}) {
  const [mode, setMode] = useState<InputMode>("subcontract");
  const [sub, setSub] = useState(initialSub);
  const [direct, setDirect] = useState(() => initialDirect(lookups));
  const [daily, setDaily] = useState(() => initialDaily(lookups));
  const [equip, setEquip] = useState(() => initialEquip(lookups));
  const [dirtyModes, setDirtyModes] = useState<InputMode[]>([]);
  const [attempted, setAttempted] = useState<InputMode[]>([]);
  const [touched, setTouched] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // サーバー・通信の失敗（何が起きたか・入力の保持・次の操作）。入力欄単位の誤りは error と Field に出す
  const [failure, setFailure] = useState<Guidance | null>(null);
  const [success, setSuccess] = useState<{ documentNo: string; label: string; warnings: string[] } | null>(null);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const initialised = useRef(!!lookups);
  useEffect(() => {
    if (!lookups || initialised.current) return;
    initialised.current = true; setDirect(initialDirect(lookups)); setDaily(initialDaily(lookups)); setEquip(initialEquip(lookups));
  }, [lookups]);
  useEffect(() => { onDirtyChange(dirtyModes.length > 0); }, [dirtyModes, onDirtyChange]);
  useEffect(() => { onBusyChange(isSubmitting); }, [isSubmitting, onBusyChange]);
  const mark = (target: InputMode) => { setDirtyModes(list => list.includes(target) ? list : [...list, target]); setSuccess(null); setError(null); setFailure(null); };
  const updateSub = (patch: Partial<SubDraft>) => { if (busyRef.current) return; mark("subcontract"); setSub(value => ({ ...value, ...patch })); };
  const updateDirect = (patch: Partial<DirectDraft>) => { if (busyRef.current) return; mark("direct"); setDirect(value => ({ ...value, ...patch })); };
  const updateDaily = (patch: Partial<DailyDraft>) => { if (busyRef.current) return; mark("daily"); setDaily(value => ({ ...value, ...patch })); };
  const updateEquip = (patch: Partial<EquipDraft>) => { if (busyRef.current) return; mark("equipment"); setEquip(value => ({ ...value, ...patch })); };
  const orders = useMemo(() => lookups?.subcontract_orders.filter(order => order.project_code === project?.key.project_code && order.branch_code === project?.key.branch_code) ?? [], [lookups, project]);
  const order = orders.find(item => item.order_number === sub.orderNo) ?? null;
  const initialProgress = (orderNo: string) => {
    const selected = orders.find(item => item.order_number === orderNo);
    return selected && selected.order_amount_tax_ex > 0 ? new Decimal(selected.accum_assessed_amount_tax_ex).mul(100).div(selected.order_amount_tax_ex).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString() : "0";
  };
  useEffect(() => {
    // 背景更新では選択・入力値を上書きしない。発注が消えた場合は送信時に再選択を要求する。
    const selected = orders.find(item => item.order_number === sub.orderNo) ?? (!sub.orderNo ? orders[0] : undefined);
    if (!selected || dirtyModes.includes("subcontract")) return;
    const progress = selected.order_amount_tax_ex > 0 ? new Decimal(selected.accum_assessed_amount_tax_ex).mul(100).div(selected.order_amount_tax_ex).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString() : "0";
    setSub(value => value.orderNo === selected.order_number && value.progress === progress ? value : { ...value, orderNo: selected.order_number, progress });
  }, [orders, sub.orderNo, dirtyModes]);
  const selectOrder = (orderNo: string) => { if (busyRef.current) return; setSub({ ...initialSub(), orderNo, month: sub.month, progress: initialProgress(orderNo) }); setDirtyModes(list => list.filter(item => item !== "subcontract")); setAttempted(list => list.filter(item => item !== "subcontract")); setTouched(list => list.filter(item => !item.startsWith("subcontract:"))); setError(null); setSuccess(null); };
  const setProgress = (progress: string) => {
    let amount = sub.amount;
    if (order && /^\d+(\.\d{1,3})?$/.test(progress)) {
      amount = new Decimal(order.order_amount_tax_ex).mul(progress).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).minus(order.accum_assessed_amount_tax_ex).toString();
    }
    updateSub({ progress, amount });
  };
  const setSubAmount = (amount: string) => {
    let progress = sub.progress;
    if (order && /^\d+$/.test(amount) && order.order_amount_tax_ex > 0) progress = new Decimal(order.accum_assessed_amount_tax_ex).plus(amount).mul(100).div(order.order_amount_tax_ex).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();
    updateSub({ amount, progress });
  };
  const applyTemplate = (tpl: QuickItemTemplateDto) => updateDirect({ templateCode: tpl.template_code, itemName: tpl.item_label, workType: tpl.work_type_code, costElement: tpl.cost_element_code, unit: tpl.default_unit, quantity: "1", price: new Decimal(tpl.default_unit_price).toString(), specification: "" });
  const subPreview = useMemo(() => {
    const errors: FieldErrors = {};
    if (!order) errors.order = "対象の発注を選択してください。";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(sub.month)) errors.month = "対象年月を選択してください。";
    if (!/^\d+(\.\d{1,3})?$/.test(sub.progress) || new Decimal(sub.progress || 0).gt(100)) errors.progress = "累計出来高は0〜100%で、小数第3位まで入力してください。";
    const amount = yen(sub.amount, "今回の出来高金額"); const fixed = yen(sub.fixed, "定額控除額"); const offset = yen(sub.offset, "立替相殺額");
    if (amount.error) errors.amount = sub.amount.startsWith("-") ? "累計出来高が前回を下回っています。前回以上の進捗率を入力してください。" : amount.error;
    else if (!amount.value) errors.amount = "今回の出来高金額は1円以上にしてください。";
    else if (order && amount.value > order.remaining_order_balance) errors.amount = "発注残高を超えています。累計出来高または今回金額を確認してください。";
    if (fixed.error) errors.fixed = fixed.error; if (offset.error) errors.offset = offset.error;
    let tax = new Decimal(0), retainage = new Decimal(0), safety = new Decimal(0);
    const current = new Decimal(amount.value);
    if (order) {
      tax = new Decimal(order.accum_assessed_amount_tax_ex).plus(current).mul(order.tax_rate).toDecimalPlaces(0, Decimal.ROUND_FLOOR).minus(order.accum_assessed_tax_amount);
      const retDen = new Decimal(order.retainage_rate_den), safDen = new Decimal(order.safety_assoc_rate_den);
      if (retDen.lte(0) || safDen.lte(0)) errors.order = "発注の控除率が不正です。管理者にご確認ください。";
      retainage = retDen.gt(0) ? current.mul(order.retainage_rate_num).div(retDen).toDecimalPlaces(0, Decimal.ROUND_FLOOR) : new Decimal(0);
      safety = safDen.gt(0) ? current.mul(order.safety_assoc_rate_num).div(safDen).toDecimalPlaces(0, Decimal.ROUND_FLOOR) : new Decimal(0);
    }
    const deductions = retainage.plus(safety).plus(fixed.value).plus(offset.value);
    return { errors, amount: amount.value, fixed: fixed.value, offset: offset.value, tax: tax.toNumber(), retainage: retainage.toNumber(), safety: safety.toNumber(), deductions: deductions.toNumber(), net: current.plus(tax).minus(deductions).toNumber() };
  }, [sub, order]);
  const directPreview = useMemo(() => {
    const errors: FieldErrors = {};
    if (!direct.costElement) errors.costElement = "材料費・現場経費の種類を選択してください。";
    if (direct.workType.length !== 12) errors.workType = "作業内容を選択してください。";
    if (!direct.itemName.trim()) errors.itemName = "品名・内容を入力してください。";
    if (!direct.unit.trim()) errors.unit = "単位を入力してください（例：m3、t、式）。";
    if (!dateValid(direct.date)) errors.date = "有効な発生日を選択してください。";
    const qty = quantity(direct.quantity, "数量"), price = quantity(direct.price, "単価");
    if (qty.error) errors.quantity = qty.error; if (price.error) errors.price = price.error;
    let amount = 0;
    if (qty.dec && price.dec) {
      const result = qty.dec.mul(price.dec).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      if (!safeAmount(result)) errors.amount = "計算後の金額が上限（15桁）を超えています。";
      else if (result.lte(0)) errors.amount = "計算後の金額が1円以上になるように入力してください。";
      else amount = result.toNumber();
    }
    return { errors, amount, quantity: qty.formatted, price: price.formatted };
  }, [direct]);
  const employee = lookups?.employees.find(item => item.employee_code === daily.employee) ?? null;
  const dailyPreview = useMemo(() => {
    const errors: FieldErrors = {};
    if (!employee) errors.employee = "作業員を選択してください。";
    if (daily.workType.length !== 12) errors.workType = "作業内容を選択してください。";
    if (!dateValid(daily.date)) errors.date = "有効な作業日を選択してください。";
    const hours = quantity(daily.hours, "作業時間"); if (hours.error) errors.hours = hours.error;
    else if (hours.dec?.gt(24)) errors.hours = "作業時間は24時間以内で入力してください。";
    let amount = 0;
    if (employee && hours.dec) {
      const result = new Decimal(employee.standard_daily_wage).mul(hours.dec).div(8).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      if (!safeAmount(result)) errors.amount = "概算労務原価が上限（15桁）を超えています。"; else amount = result.toNumber();
    }
    return { errors, amount, hours: hours.formatted };
  }, [daily, employee]);
  const equipment = lookups?.equipments.find(item => item.equipment_code === equip.equipment) ?? null;
  const equipPreview = useMemo(() => {
    const errors: FieldErrors = {};
    if (!equipment) errors.equipment = "資機材を選択してください。";
    if (equip.workType.length !== 12) errors.workType = "作業内容を選択してください。";
    if (!dateValid(equip.date)) errors.date = "有効な出庫日を選択してください。";
    const qty = quantity(equip.quantity, "数量"); if (qty.error) errors.quantity = qty.error;
    const days = yen(equip.days, "使用日数"); if (days.error || days.value < 1 || days.value > 36500) errors.days = "使用日数は1〜36,500日の整数で入力してください。";
    const freight = yen(equip.freight, "運賃・回送費"), maintenance = yen(equip.maintenance, "整備・基本料");
    if (freight.error) errors.freight = freight.error; if (maintenance.error) errors.maintenance = maintenance.error;
    let rent = 0, amount = 0;
    if (equipment && qty.dec && !errors.days && !freight.error && !maintenance.error) {
      const rentDec = qty.dec.mul(equipment.daily_rent_price).mul(days.value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      const result = rentDec.plus(freight.value).plus(maintenance.value);
      if (!safeAmount(result)) errors.amount = "機械損料の合計が上限（15桁）を超えています。";
      else { rent = rentDec.toNumber(); amount = result.toNumber(); }
    }
    return { errors, amount, rent, quantity: qty.formatted, days: days.value, freight: freight.value, maintenance: maintenance.value };
  }, [equip, equipment]);
  const previews = { subcontract: subPreview, direct: directPreview, daily: dailyPreview, equipment: equipPreview };
  const activePreview = previews[mode];
  const clearMode = (target: InputMode) => {
    if (target === "subcontract") setSub({ ...initialSub(), orderNo: sub.orderNo, progress: initialProgress(sub.orderNo) });
    if (target === "direct") setDirect(initialDirect(lookups));
    if (target === "daily") setDaily(initialDaily(lookups));
    if (target === "equipment") setEquip(initialEquip(lookups));
    setDirtyModes(list => list.filter(item => item !== target)); setAttempted(list => list.filter(item => item !== target)); setTouched(list => list.filter(item => !item.startsWith(`${target}:`))); setError(null);
  };
  const validate = () => {
    setAttempted(list => list.includes(mode) ? list : [...list, mode]);
    const first = Object.values(activePreview.errors)[0];
    if (first) { setError(first); return false; }
    return true;
  };
  const submit = async () => {
    if (busyRef.current || !validate()) return;
    if (!project || isBranchLocked(project.completion_status, allowCompleted)) { setError("登録できる工事を選択してください。"); return; }
    let endpoint: string;
    let payload: EasySubcontractProgressRequest | EasyDirectCostRequest | EasyDailyReportRequest | EasyEquipmentMovementRequest;
    const key = { company_code: companyCode, project_code: project.key.project_code, branch_code: project.key.branch_code };
    switch (mode) {
      case "subcontract":
        if (!order) return;
        endpoint = API_ENDPOINTS.SUBMIT_SUBCONTRACT_PROGRESS;
        payload = { company_code: companyCode, order_number: order.order_number, order_history_no: order.order_history_no, assessment_year_month: sub.month.replace("-", ""), curr_assessed_amount_tax_ex: subPreview.amount, fixed_deductions: subPreview.fixed, chargeback_offset: subPreview.offset }; break;
      case "direct":
        if (!direct.costElement) return;
        endpoint = API_ENDPOINTS.SUBMIT_DIRECT_COST;
        payload = { ...key, occurred_date: direct.date, vendor_partner_code: direct.vendor.trim() || null, work_type_code: direct.workType, cost_element_code: direct.costElement, item_name: direct.itemName.trim(), specification: direct.specification.trim() || null, quantity: directPreview.quantity, unit: direct.unit.trim(), unit_price: directPreview.price, notes: direct.notes.trim() || null }; break;
      case "daily":
        endpoint = API_ENDPOINTS.SUBMIT_DAILY_REPORT;
        payload = { ...key, work_date: daily.date, employee_code: daily.employee, work_type_code: daily.workType, work_hours: dailyPreview.hours, work_summary: daily.summary.trim() || null }; break;
      case "equipment":
        endpoint = API_ENDPOINTS.SUBMIT_EQUIPMENT_MOVEMENT;
        payload = { company_code: companyCode, equipment_code: equip.equipment, dest_project_code: project.key.project_code, dest_branch_code: project.key.branch_code, work_type_code: equip.workType, movement_date: equip.date, quantity: equipPreview.quantity, usage_days: equipPreview.days, freight_fee: equipPreview.freight, maintenance_fee: equipPreview.maintenance }; break;
    }
    busyRef.current = true; setIsSubmitting(true); setError(null); setFailure(null); setSuccess(null); setRefreshWarning(false);
    let result: CostRegistrationResponse;
    try {
      const res = await apiFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
      if (res.status !== 201) {
        let message = `登録できませんでした（HTTP ${res.status}）。入力内容を保持しています。`;
        try { const data = await res.json(); if (typeof data.message === "string") message = data.message; } catch { /* 非JSON応答の際も入力は保持する */ }
        throw new HttpError(res.status, message);
      }
      try { result = await res.json() as CostRegistrationResponse; }
      catch { throw new Error("登録結果を確認できません。重複を避けるため、工事の状況を更新して管理者にご確認ください。"); }
      if (!result || typeof result.document_no !== "string" || !/^\d{12}$/.test(result.document_no)) throw new Error("登録結果を確認できません。重複を避けるため、工事の状況を更新して管理者にご確認ください。");
    } catch (err) {
      // 通信が途切れた場合は、サーバーで登録済みの可能性があるため自動で再送せず、確認を案内する
      setFailure(err instanceof TypeError
        ? { intent: "error", title: "通信結果を確認できません", body: "入力は保持しています。登録済みの可能性があるため、再登録の前に「更新」で工事の状況を確認してください。" }
        : err instanceof HttpError ? describeFailure(err, "登録", "入力内容は保持しています。")
        : { intent: "error", title: "登録結果を確認できません", body: err instanceof Error ? err.message : "工事の状況を確認してください。" });
      busyRef.current = false; setIsSubmitting(false); return;
    }
    setSuccess({ documentNo: result.document_no, label: modeLabels[mode], warnings: Array.isArray(result.warnings) ? result.warnings : [] });
    clearMode(mode);
    try { setRefreshWarning(!(await onRegistered())); } catch { setRefreshWarning(true); }
    finally { busyRef.current = false; setIsSubmitting(false); }
  };
  const fieldError = (key: string) => attempted.includes(mode) || touched.includes(`${mode}:${key}`) ? activePreview.errors[key] : undefined;
  const touch = (key: string) => setTouched(list => list.includes(`${mode}:${key}`) ? list : [...list, `${mode}:${key}`]);
  return { mode, setMode, sub, direct, daily, equip, updateSub, updateDirect, updateDaily, updateEquip, setProgress, setSubAmount, applyTemplate, orders, order, selectOrder, employee, equipment, subPreview, directPreview, dailyPreview, equipPreview, activePreview, previews, isSubmitting, dirtyModes, error, failure, setFailure, success, refreshWarning, setRefreshWarning, validate, submit, clearMode, fieldError, touch, setError, setSuccess };
}
export type CostDraft = ReturnType<typeof useCostDraft>;
