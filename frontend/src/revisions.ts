// 予算・発注の登録と承認（Phase 4）の型と通信ヘルパー。
// bindings.ts（ロック済アンカー）は変更せず、このファイルに置く。backend/src/api/revisions.rs と対応。
// 円金額は JSON 整数、数量・単価・率は JSON 文字列（Decimal）。
import Decimal from "decimal.js";
import { apiFetch, Role } from "./auth";

/** '0' 未承認の案 / '1' 承認済 / '9' 否認（'3' 申請中・'2' 確認済は将来拡張） */
export type RevisionStatus = string;

export function statusLabel(status: RevisionStatus): string {
  switch (status) {
    case "0":
      return "未承認の案";
    case "1":
      return "承認済";
    case "9":
      return "否認";
    default:
      return `状態${status}`;
  }
}

export function completionLabel(status: string): string {
  switch (status) {
    case "0":
      return "未成";
    case "1":
      return "完成";
    case "2":
      return "前期完成";
    case "3":
      return "計上済";
    default:
      return status;
  }
}

/** 案の作成・編集・削除（registrar 以上） */
export function canEditDrafts(role: Role): boolean {
  return role === "registrar" || role === "approver";
}

/** 承認・否認、工事・枝番の登録（approver のみ） */
export function canApprove(role: Role): boolean {
  return role === "approver";
}

export interface BudgetLineDto {
  line_no: number;
  work_type_code: string;
  work_type_name: string | null;
  cost_element_code: string;
  cost_element_name: string | null;
  item_name: string;
  specification: string | null;
  unit: string;
  planned_quantity: string;
  planned_unit_price: string;
  planned_amount: number;
}

export interface BudgetVersionDto {
  history_no: number;
  status: RevisionStatus;
  budget_created_date: string;
  total_budget_amount: number;
  target_gross_profit_rate: string;
  notes: string | null;
  created_by: string | null;
  lines: BudgetLineDto[];
}

export interface VersionSummaryDto {
  history_no: number;
  status: RevisionStatus;
  amount: number;
}

export interface BudgetLineChangeDto {
  line_no: number;
  before: BudgetLineDto;
  after: BudgetLineDto;
  amount_delta: number;
}

export interface BudgetDiffDto {
  base_history_no: number | null;
  draft_history_no: number;
  total_before: number;
  total_after: number;
  total_delta: number;
  added: BudgetLineDto[];
  removed: BudgetLineDto[];
  changed: BudgetLineChangeDto[];
}

export interface RevisionEventDto {
  event_no: number;
  occurred_at: string;
  actor_user_id: string;
  actor_role: string;
  target_type: "project" | "branch" | "budget" | "order";
  action: "create" | "update" | "delete" | "approve" | "reject";
  project_code: string | null;
  branch_code: string | null;
  order_number: string | null;
  history_no: number | null;
  reason: string | null;
  amount_before: number | null;
  amount_after: number | null;
}

export interface BranchBudgetDto {
  company_code: string;
  project_code: string;
  project_name: string;
  branch_code: string;
  branch_name: string;
  completion_status: string;
  approved: BudgetVersionDto | null;
  draft: BudgetVersionDto | null;
  versions: VersionSummaryDto[];
  diff: BudgetDiffDto | null;
  events: RevisionEventDto[];
}

export interface OrderVersionDto {
  order_number: string;
  history_no: number;
  status: RevisionStatus;
  project_code: string;
  branch_code: string;
  subcontractor_code: string;
  subcontractor_name: string | null;
  work_type_code: string;
  work_type_name: string | null;
  order_date: string;
  work_start_date: string;
  work_end_date: string;
  order_type: string;
  is_unit_price_contract: boolean;
  order_amount_tax_ex: number;
  order_tax_amount: number;
  tax_rate: string;
  retainage_rate_num: string;
  retainage_rate_den: string;
  safety_assoc_rate_num: string;
  safety_assoc_rate_den: string;
  created_by: string | null;
}

export interface FieldChangeDto {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface OrderDiffDto {
  base_history_no: number | null;
  draft_history_no: number;
  amount_before: number;
  amount_after: number;
  amount_delta: number;
  changed_fields: FieldChangeDto[];
}

export interface OrderEntryDto {
  order_number: string;
  approved: OrderVersionDto | null;
  draft: OrderVersionDto | null;
  versions: VersionSummaryDto[];
  accum_assessed_amount_tax_ex: number;
  remaining_order_balance: number | null;
  diff: OrderDiffDto | null;
}

export interface BranchOrdersDto {
  company_code: string;
  project_code: string;
  branch_code: string;
  completion_status: string;
  orders: OrderEntryDto[];
  events: RevisionEventDto[];
}

export interface BranchSummaryDto {
  branch_code: string;
  branch_name: string;
  completion_status: string;
  contract_amount_tax_ex: number;
  approved_budget_history_no: number | null;
  has_budget_draft: boolean;
  order_count: number;
  order_draft_count: number;
}

export interface ProjectSummaryDto {
  project_code: string;
  project_name: string;
  project_short_name: string;
  branches: BranchSummaryDto[];
}

export interface ProjectListDto {
  company_code: string;
  projects: ProjectSummaryDto[];
}

export interface CodeNameDto {
  code: string;
  name: string;
}

export interface RevisionOptionsDto {
  work_types: { code: string; name: string; hierarchy_level: number }[];
  cost_elements: CodeNameDto[];
  subcontractors: CodeNameDto[];
  customers: CodeNameDto[];
  employees: CodeNameDto[];
}

export interface RevisionMutationResponse {
  target_type: string;
  action: string;
  project_code: string | null;
  branch_code: string | null;
  order_number: string | null;
  history_no: number | null;
  status: string | null;
  amount: number | null;
  event_no: number;
}

export interface BudgetLineInput {
  line_no: number | null;
  work_type_code: string;
  cost_element_code: string;
  item_name: string;
  specification: string | null;
  unit: string;
  planned_quantity: string;
  planned_unit_price: string;
}

export interface BudgetDraftUpdateRequest {
  budget_created_date?: string | null;
  target_gross_profit_rate: string;
  notes: string | null;
  lines: BudgetLineInput[];
}

export interface OrderFieldsInput {
  subcontractor_code: string;
  work_type_code: string;
  order_date: string;
  work_start_date: string;
  work_end_date: string;
  is_unit_price_contract: boolean;
  order_amount_tax_ex: number;
  tax_rate: string;
  retainage_rate_num: string;
  retainage_rate_den: string;
  safety_assoc_rate_num: string;
  safety_assoc_rate_den: string;
}

export interface OrderCreateRequest extends OrderFieldsInput {
  order_number?: string | null;
  project_code: string;
  branch_code: string;
}

export interface BranchFieldsInput {
  branch_name: string;
  site_manager_code: string;
  supervising_engineer_code: string | null;
  chief_engineer_code: string | null;
  client_partner_code: string;
  contract_start_date: string;
  contract_end_date: string;
  internal_start_date: string;
  internal_end_date: string;
  contract_amount_tax_ex: number;
  contract_tax_amount: number;
  estimated_total_cost: number;
}

export interface ProjectCreateRequest {
  project_code: string;
  project_name: string;
  project_short_name: string;
  doken_type: string;
  honzatsu_type: string;
  kanmin_type1: string;
  main_branch: BranchFieldsInput;
}

export interface BranchCreateRequest extends BranchFieldsInput {
  branch_code: string;
}

const enc = encodeURIComponent;
const branchBase = (p: string, b: string) => `/api/v1/projects/${enc(p)}/branches/${enc(b)}`;

export const REVISION_ENDPOINTS = {
  PROJECTS: "/api/v1/projects",
  OPTIONS: "/api/v1/revision-options",
  ORDERS: "/api/v1/orders",
  branches: (p: string) => `/api/v1/projects/${enc(p)}/branches`,
  budget: (p: string, b: string) => `${branchBase(p, b)}/budget`,
  budgetDrafts: (p: string, b: string) => `${branchBase(p, b)}/budget/drafts`,
  budgetDraft: (p: string, b: string, h: number) => `${branchBase(p, b)}/budget/drafts/${h}`,
  branchOrders: (p: string, b: string) => `${branchBase(p, b)}/orders`,
  orderDrafts: (n: string) => `/api/v1/orders/${enc(n)}/drafts`,
  orderDraft: (n: string, h: number) => `/api/v1/orders/${enc(n)}/drafts/${h}`,
} as const;

/** API エラーの本文（{code,message}）を利用者向けの文に変換する */
export class ApiRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  // 状態を変える POST/PUT/DELETE は Content-Type: application/json が必須（CSRF 対策）。DELETE は本文なしで送る。
  const init: RequestInit = { method, headers: { Accept: "application/json" } };
  if (method !== "GET") {
    init.headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  const res = await apiFetch(url, init);
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      data && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : `サーバー通信エラーが発生しました（HTTP ${res.status}）`;
    throw new ApiRequestError(res.status, msg);
  }
  return data as T;
}

export const revisionsApi = {
  listProjects: () => send<ProjectListDto>(REVISION_ENDPOINTS.PROJECTS, "GET"),
  options: () => send<RevisionOptionsDto>(REVISION_ENDPOINTS.OPTIONS, "GET"),
  getBudget: (p: string, b: string) => send<BranchBudgetDto>(REVISION_ENDPOINTS.budget(p, b), "GET"),
  getOrders: (p: string, b: string) => send<BranchOrdersDto>(REVISION_ENDPOINTS.branchOrders(p, b), "GET"),
  createBudgetDraft: (p: string, b: string) =>
    send<RevisionMutationResponse>(REVISION_ENDPOINTS.budgetDrafts(p, b), "POST", {}),
  updateBudgetDraft: (p: string, b: string, h: number, req: BudgetDraftUpdateRequest) =>
    send<RevisionMutationResponse>(REVISION_ENDPOINTS.budgetDraft(p, b, h), "PUT", req),
  deleteBudgetDraft: (p: string, b: string, h: number) =>
    send<void>(REVISION_ENDPOINTS.budgetDraft(p, b, h), "DELETE"),
  approveBudget: (p: string, b: string, h: number, comment: string) =>
    send<RevisionMutationResponse>(`${REVISION_ENDPOINTS.budgetDraft(p, b, h)}/approve`, "POST", { comment: comment || null }),
  rejectBudget: (p: string, b: string, h: number, reason: string) =>
    send<RevisionMutationResponse>(`${REVISION_ENDPOINTS.budgetDraft(p, b, h)}/reject`, "POST", { reason }),
  createOrder: (req: OrderCreateRequest) => send<RevisionMutationResponse>(REVISION_ENDPOINTS.ORDERS, "POST", req),
  createOrderRevision: (n: string) => send<RevisionMutationResponse>(REVISION_ENDPOINTS.orderDrafts(n), "POST", {}),
  updateOrderDraft: (n: string, h: number, req: OrderFieldsInput) =>
    send<RevisionMutationResponse>(REVISION_ENDPOINTS.orderDraft(n, h), "PUT", req),
  deleteOrderDraft: (n: string, h: number) => send<void>(REVISION_ENDPOINTS.orderDraft(n, h), "DELETE"),
  approveOrder: (n: string, h: number, comment: string) =>
    send<RevisionMutationResponse>(`${REVISION_ENDPOINTS.orderDraft(n, h)}/approve`, "POST", { comment: comment || null }),
  rejectOrder: (n: string, h: number, reason: string) =>
    send<RevisionMutationResponse>(`${REVISION_ENDPOINTS.orderDraft(n, h)}/reject`, "POST", { reason }),
  createProject: (req: ProjectCreateRequest) => send<RevisionMutationResponse>(REVISION_ENDPOINTS.PROJECTS, "POST", req),
  createBranch: (p: string, req: BranchCreateRequest) =>
    send<RevisionMutationResponse>(REVISION_ENDPOINTS.branches(p), "POST", req),
};

// ---------------------------------------------------------------------------
// 表示用（概算プレビュー。正はサーバーの計算）
// ---------------------------------------------------------------------------

export function formatYen(amount: number): string {
  const dec = new Decimal(amount);
  const abs = dec.abs().toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec.isNegative() ? `-¥${abs}` : `¥${abs}`;
}

export function formatDelta(amount: number): string {
  if (amount === 0) return "±¥0";
  return amount > 0 ? `+${formatYen(amount)}` : formatYen(amount);
}

/** 数量×単価を小数第1位で四捨五入（calc_line_amount と同じ規則の概算）。不正入力は null */
export function previewLineAmount(qty: string, price: string): number | null {
  try {
    const q = new Decimal(qty.trim());
    const p = new Decimal(price.trim());
    if (!q.isFinite() || !p.isFinite()) return null;
    const v = q.mul(p).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    if (v.abs().greaterThan(Number.MAX_SAFE_INTEGER)) return null;
    return v.toNumber();
  } catch {
    return null;
  }
}

/** 発注消費税額の概算 = floor(税抜 × 税率) */
export function previewOrderTax(amount: number, rate: string): number | null {
  try {
    return new Decimal(amount).mul(new Decimal(rate.trim())).floor().toNumber();
  } catch {
    return null;
  }
}

export function formatRate(num: string, den: string): string {
  try {
    return `${new Decimal(num).toString()}/${new Decimal(den).toString()}`;
  } catch {
    return `${num}/${den}`;
  }
}

export function eventLabel(e: RevisionEventDto): string {
  const target = { project: "工事", branch: "枝番", budget: "実行予算", order: "外注発注" }[e.target_type] ?? e.target_type;
  const action = { create: "作成", update: "編集", delete: "削除", approve: "承認", reject: "否認" }[e.action] ?? e.action;
  return `${target}を${action}`;
}
