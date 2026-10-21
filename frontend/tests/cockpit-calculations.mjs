import assert from 'node:assert/strict';
import { createServer } from 'vite';
import Decimal from 'decimal.js';
import { projects, project } from './ui-fixtures.mjs';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { buildAllBranchesViewData, toSafeYenNumber, calcRatePercent, workTypeTotals, formatYen, progressValue } = await server.ssrLoadModule('/src/cockpitData.ts');
  const all = buildAllBranchesViewData(projects);
  assert.equal(all.contract_amount_tax_ex, 55000000);
  assert.equal(all.execution_budget_amount, 42000000);
  assert.equal(all.actual_occurred_cost, 13000000);
  assert.equal(all.forecast_gross_profit, 11500000);
  assert.equal(all.forecast_profit_rate, '20.91');
  assert.equal(all.actual_breakdown.total_cost, 13000000);
  assert.equal(all.by_work_type[0].remaining_budget, 29000000);
  assert.equal(workTypeTotals(all.by_work_type).remaining_budget, 29000000);
  assert.equal(all.is_budget_exceeded, true);
  assert.equal(buildAllBranchesViewData([]), null);
  assert.equal(buildAllBranchesViewData([{ ...project, completion_status: '2' }, { ...project, completion_status: '1' }]).completion_status, '1');
  assert.equal(buildAllBranchesViewData([{ ...project, completion_status: '1' }, project]).completion_status, '0');
  assert.equal(buildAllBranchesViewData([{ ...project, requires_supervising_engineer_warning: true }]).requires_supervising_engineer_warning, true);
  assert.throws(() => buildAllBranchesViewData(Array.from({ length: 10 }, () => ({ ...project, contract_amount_tax_ex: 999999999999999 }))), /安全整数上限/);
  assert.throws(() => toSafeYenNumber(new Decimal('9007199254740992'), 'テスト'), /安全整数上限/);
  assert.throws(() => toSafeYenNumber(new Decimal('1.5'), 'テスト'), /安全整数上限/);
  assert.equal(toSafeYenNumber(new Decimal('9007199254740991'), 'テスト'), Number.MAX_SAFE_INTEGER);
  assert.equal(calcRatePercent(new Decimal(1), new Decimal(0)), '0.00');
  assert.equal(calcRatePercent(new Decimal(1), new Decimal(3)), '33.33');
  assert.equal(formatYen(-1234), '−¥1,234');
  assert.equal(progressValue('150'), 1); assert.equal(progressValue('-5'), 0);
  console.log('PASS 22 cockpit aggregation, safety, status and formatting assertions');
} finally { await server.close(); }
