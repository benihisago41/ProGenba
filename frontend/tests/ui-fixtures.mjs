export const me = { company_code: '0000', user_id: 'genba01', display_name: '現場 太郎', role: 'approver' };
export const workTypes = [{ work_type_code: '010001000100', work_type_name: '躯体工事' }, { work_type_code: '020001000100', work_type_name: '外部足場' }];
export const project = {
  key: { company_code: '0000', project_code: 'P001', branch_code: '000' },
  project_name: '青葉台レジデンス新築工事', branch_name: '本工事', completion_status: '0',
  contract_amount_tax_ex: 50000000, latest_budget_history_no: 2, execution_budget_amount: 38000000,
  ordered_committed_amount: 24000000, actual_occurred_cost: 12000000, forecast_final_cost: 40000000,
  forecast_gross_profit: 10000000, forecast_profit_rate: '20.00', is_budget_exceeded: true, requires_supervising_engineer_warning: false,
  actual_breakdown: { material_cost: 1000000, labor_cost: 2000000, subcontract_cost: 8000000, expense_cost: 500000, equipment_cost: 500000, total_cost: 12000000 },
  by_work_type: [{ ...workTypes[0], budget_amount: 38000000, ordered_amount: 24000000, actual_cost: 12000000, remaining_budget: 26000000, consumption_rate_percent: '31.58' }],
};
export const projects = [project, { ...project, key: { ...project.key, branch_code: '001' }, branch_name: 'エントランス変更', contract_amount_tax_ex: 5000000, execution_budget_amount: 4000000, ordered_committed_amount: 3000000, actual_occurred_cost: 1000000, forecast_final_cost: 3500000, forecast_gross_profit: 1500000, forecast_profit_rate: '30.00', is_budget_exceeded: false, actual_breakdown: { ...project.actual_breakdown, material_cost: 1000000, labor_cost: 0, subcontract_cost: 0, expense_cost: 0, equipment_cost: 0, total_cost: 1000000 }, by_work_type: [{ ...workTypes[0], budget_amount: 4000000, ordered_amount: 3000000, actual_cost: 1000000, remaining_budget: 3000000, consumption_rate_percent: '25.00' }] }];
const order = { order_number: '000000000001', order_history_no: 2, project_code: 'P001', branch_code: '000', subcontractor_code: 'V001', subcontractor_name: '佐藤建設', work_type_code: workTypes[0].work_type_code, work_type_name: workTypes[0].work_type_name, order_amount_tax_ex: 10000000, accum_assessed_amount_tax_ex: 2000000, accum_assessed_tax_amount: 200000, remaining_order_balance: 8000000, tax_rate: '0.10', retainage_rate_num: '5.00', retainage_rate_den: '100.00', safety_assoc_rate_num: '3.00', safety_assoc_rate_den: '1000.00' };
export const lookups = {
  work_types: workTypes,
  quick_templates: [{ template_code: 'T001', item_label: '生コンクリート', work_type_code: workTypes[0].work_type_code, cost_element_code: '0100', default_unit: 'm3', default_unit_price: '18000.000' }, { template_code: 'T002', item_label: '産廃処分', work_type_code: workTypes[0].work_type_code, cost_element_code: '0400', default_unit: '式', default_unit_price: '10000.000' }],
  subcontract_orders: [order, { ...order, order_number: '000000000002', subcontractor_name: '鈴木建設' }],
  employees: [{ employee_code: 'E001', employee_name: '高橋 一郎', standard_daily_wage: 22000 }],
  suppliers: [{ partner_code: 'V001', partner_name: '青葉資材' }],
  equipments: [{ equipment_code: 'Q001', equipment_name: '枠組足場', unit: '組', daily_rent_price: '120.000' }],
};

// 予算・発注（RevisionsView）のモック応答。backend/src/api/revisions.rs の応答形に合わせる。
export const revOptions = {
  work_types: [{ code: workTypes[0].work_type_code, name: workTypes[0].work_type_name, hierarchy_level: 3 }],
  cost_elements: [{ code: '0100', name: '材料費' }, { code: '0400', name: '現場経費' }],
  subcontractors: [{ code: 'V001', name: '佐藤建設' }],
  customers: [{ code: 'C001', name: '青葉不動産' }],
  employees: [{ code: 'E001', name: '高橋 一郎' }],
};
const revBranch = (code, name, hasDraft) => ({ branch_code: code, branch_name: name, completion_status: '0', contract_amount_tax_ex: code === '000' ? 50000000 : 5000000, approved_budget_history_no: code === '000' ? 2 : 0, has_budget_draft: hasDraft, order_count: code === '000' ? 1 : 0, order_draft_count: 0 });
export const revProjects = { company_code: '0000', projects: [{ project_code: 'P001', project_name: project.project_name, project_short_name: '青葉台', branches: [revBranch('000', '本工事', true), revBranch('001', 'エントランス変更', false)] }] };
const budgetLine = (qty, price, amount) => ({ line_no: 1, work_type_code: workTypes[0].work_type_code, work_type_name: workTypes[0].work_type_name, cost_element_code: '0100', cost_element_name: '材料費', item_name: '生コンクリート', specification: null, unit: 'm3', planned_quantity: qty, planned_unit_price: price, planned_amount: amount });
const version = (h, status, line) => ({ history_no: h, status, budget_created_date: '2026-10-01', total_budget_amount: line.planned_amount, target_gross_profit_rate: '20.00', notes: null, created_by: status === '0' ? 'registrar01' : null, lines: [line] });
/** 本工事は承認済み履歴2＋未承認の案 履歴3、それ以外は承認済み履歴0のみ。未登録の工事は版なし */
export function revBudget(projectCode, branchCode) {
  const known = projectCode === 'P001';
  const approved = known ? version(branchCode === '000' ? 2 : 0, '1', budgetLine('100.000', '18000.000', 1800000)) : null;
  const draft = known && branchCode === '000' ? version(3, '0', budgetLine('100.000', '20000.000', 2000000)) : null;
  return {
    company_code: '0000', project_code: projectCode, project_name: known ? project.project_name : projectCode, branch_code: branchCode,
    branch_name: branchCode === '000' ? '本工事' : 'エントランス変更', completion_status: '0', approved, draft,
    versions: [approved, draft].filter(Boolean).map(v => ({ history_no: v.history_no, status: v.status, amount: v.total_budget_amount })),
    diff: draft ? { base_history_no: 2, draft_history_no: 3, total_before: 1800000, total_after: 2000000, total_delta: 200000, added: [], removed: [], changed: [{ line_no: 1, before: approved.lines[0], after: draft.lines[0], amount_delta: 200000 }] } : null,
    events: [],
  };
}
export function revOrders(projectCode, branchCode) {
  const orders = projectCode === 'P001' && branchCode === '000' ? [{
    order_number: 'ORD-2026-001', approved: { order_number: 'ORD-2026-001', history_no: 0, status: '1', project_code: 'P001', branch_code: '000', subcontractor_code: 'V001', subcontractor_name: '佐藤建設', work_type_code: workTypes[0].work_type_code, work_type_name: workTypes[0].work_type_name, order_date: '2026-09-01', work_start_date: '2026-09-01', work_end_date: '2027-03-31', order_type: '1', is_unit_price_contract: false, order_amount_tax_ex: 10000000, order_tax_amount: 1000000, tax_rate: '0.100', retainage_rate_num: '10.00', retainage_rate_den: '100.00', safety_assoc_rate_num: '3.00', safety_assoc_rate_den: '1000.00', created_by: null },
    draft: null, versions: [{ history_no: 0, status: '1', amount: 10000000 }], accum_assessed_amount_tax_ex: 2000000, remaining_order_balance: 8000000, diff: null,
  }] : [];
  return { company_code: '0000', project_code: projectCode, branch_code: branchCode, completion_status: '0', orders, events: [] };
}
