import React, { useMemo } from "react";
import Decimal from "decimal.js";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Body1, Body1Strong, Button, Caption1, Card, Divider, Field, ProgressBar, Select, Tab, TabList, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Title1, Title3, makeStyles, mergeClasses, tokens, typographyStyles, useRestoreFocusTarget } from "@fluentui/react-components";
import { Add24Regular, Building24Regular } from "@fluentui/react-icons";
import { ProjectCostCockpitDto, WorkTypeCostRow } from "./bindings";
import { ALL_BRANCHES, branchLabel, ProjectSelection } from "./data";
import { buildAllBranchesViewData, calcRatePercent, formatYen, progressValue, toSafeYenNumber, workTypeTotals } from "./cockpitData";
import { Notice, usePageStyles } from "./ui";

export interface CockpitViewProps { allowCompleted?: boolean; projects: ProjectCostCockpitDto[]; selection: ProjectSelection; onSelect: (next: ProjectSelection) => void; onRegister?: () => void }
const useStyles = makeStyles({
  metrics: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: tokens.spacingHorizontalL, '@media (max-width: 1100px)': { gridTemplateColumns: "minmax(0, 1fr)" } },
  metric: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalL, minWidth: 0 },
  value: { ...typographyStyles.title1, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere", '@media (max-width: 420px)': { ...typographyStyles.title2 } },
  primary: { borderTop: `${tokens.strokeWidthThicker} solid ${tokens.colorBrandStroke1}` },
  lower: { display: "grid", gridTemplateColumns: "minmax(260px, 1fr) minmax(0, 1.5fr)", gap: tokens.spacingHorizontalL, '@media (max-width: 1100px)': { gridTemplateColumns: "minmax(0, 1fr)" } },
  details: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: tokens.spacingHorizontalXXL, '@media (max-width: 640px)': { gridTemplateColumns: "minmax(0, 1fr)" } },
  tabs: { overflowX: "auto", maxWidth: "100%" },
    table: { minWidth: "740px", '@media (max-width: 640px)': { minWidth: 0, display: "block", width: "100%" } },
  tableBody: { '@media (max-width: 640px)': { display: "block" } },
  tableRow: { '@media (max-width: 640px)': { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` } },
  tableCell: { '@media (max-width: 640px)': { display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: tokens.spacingHorizontalS, whiteSpace: "normal", overflowWrap: "anywhere", '::before': { content: "attr(data-label)", color: tokens.colorNeutralForeground3, textAlign: "left" } } },
  tableHead: { backgroundColor: tokens.colorNeutralBackground2, '@media (max-width: 640px)': { display: "none" } },
  count: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightRegular },
  context: { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2, width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: tokens.borderRadiusLarge },
});
const completion = { "0": "施工中", "1": "完成 · 登録時に注意", "2": "前期完成 · 登録不可", "3": "ロック済 · 登録不可" } as const;

export const CockpitView: React.FC<CockpitViewProps> = ({ projects, selection, onSelect, onRegister, allowCompleted = false }) => {
  const p = usePageStyles(); const s = useStyles(); const restoreFocus = useRestoreFocusTarget();
  const groups = useMemo(() => Array.from(new Map(projects.map(item => [item.key.project_code, item.project_name])).entries()), [projects]);
  const branches = useMemo(() => projects.filter(item => item.key.project_code === selection.projectCode).sort((a, b) => a.key.branch_code.localeCompare(b.key.branch_code)), [projects, selection.projectCode]);
  const all = selection.branchCode === ALL_BRANCHES;
  const result = useMemo(() => {
    try {
      const data = all ? buildAllBranchesViewData(branches) : branches.find(item => item.key.branch_code === selection.branchCode) ?? null;
      return { data, totals: data ? workTypeTotals(data.by_work_type) : null, error: null };
    } catch (error) { return { data: null, totals: null, error: error instanceof Error ? error.message : "合算金額を表示できません。本工事・追加工事を個別に確認してください。" }; }
  }, [branches, all, selection.branchCode]);
  const data = result.data;
  const consumption = data ? calcRatePercent(new Decimal(data.actual_occurred_cost), new Decimal(data.execution_budget_amount)) : "0";
  const remaining = data ? toSafeYenNumber(new Decimal(data.execution_budget_amount).minus(data.actual_occurred_cost), "予算残") : 0;
  const fallback = () => onSelect({ projectCode: selection.projectCode, branchCode: branches.find(b => b.key.branch_code === "000")?.key.branch_code ?? branches[0]?.key.branch_code ?? "000" });
  return <div className={p.stack}>
    <div className={p.spread}><div className={p.compact}><Caption1 className={p.muted}>工事原価 / 状況の確認</Caption1><Title1 as="h1">工事の状況</Title1><Body1 className={p.muted}>予算といまの原価を確認できます。</Body1></div>{onRegister && <Button appearance="primary" size="large" icon={<Add24Regular />} onClick={onRegister}>原価を登録</Button>}</div>
    <Card className={p.card}><div className={p.compact}>
      <div className={p.row}><span className={s.context}><Building24Regular /></span><Field label="対象の工事" className={p.full}><Select select={{ as: "select", ...restoreFocus }} id="cockpit-project-select" size="large" className={p.control} value={selection.projectCode} onChange={(_, event) => { const target = projects.find(item => item.key.project_code === event.value && item.key.branch_code === "000") ?? projects.find(item => item.key.project_code === event.value); if (target) onSelect({ projectCode: target.key.project_code, branchCode: target.key.branch_code }); }}>{groups.map(([code, name]) => <option key={code} value={code}>{name} · {code}</option>)}</Select></Field></div>
      <Divider /><TabList className={s.tabs} selectedValue={selection.branchCode} onTabSelect={(_, event) => onSelect({ ...selection, branchCode: String(event.value) })} size="large" aria-label="本工事・追加工事・工事全体">
        {branches.map(branch => <Tab {...restoreFocus} key={branch.key.branch_code} value={branch.key.branch_code}>{branchLabel(branch.key.branch_code, branch.branch_name)}</Tab>)}<Tab {...restoreFocus} value={ALL_BRANCHES}>工事全体 <span className={s.count}>（合算）</span></Tab>
      </TabList>
      {all ? <Caption1 className={p.muted}>本工事と追加工事、全{branches.length}件の合計です。原価の登録時は対象を個別に選びます。</Caption1> : data && <div className={p.row}><Badge appearance="tint" color={data.completion_status === "0" ? "success" : "warning"}>{data.completion_status === "1" ? allowCompleted ? "完成（警告付き登録可）" : "完成（承認権限のみ登録可）" : completion[data.completion_status]}</Badge><Caption1 className={p.muted}>{data.branch_name} · 予算 Rev.{data.latest_budget_history_no}</Caption1></div>}
    </div></Card>
    {result.error && <Notice intent="error">{result.error} <Button size="large" onClick={fallback}>本工事を表示</Button></Notice>}
    {!data && !result.error && <Notice>対象の工事が見つかりません。工事を選び直してください。<Button onClick={fallback}>本工事を表示</Button></Notice>}
    {data && <>
      {data.is_budget_exceeded && <Notice intent="warning"><Body1Strong>予算を超える見込みがあります。</Body1Strong> 現在の原価・発注済額・着地予想を確認してください。</Notice>}
      {data.requires_supervising_engineer_warning && <Notice intent="warning">監理技術者の配置要否を確認してください。4,500万円の基準は検証用の業務設定で、現行法への適合を保証するものではありません。</Notice>}
      <div className={s.metrics}>
        <Card className={mergeClasses(p.card, s.primary)}><div className={s.metric}><Body1Strong>現在の原価</Body1Strong><span className={mergeClasses(s.value, p.brand)} data-testid="actual-cost">{formatYen(data.actual_occurred_cost)}</span><Caption1 className={p.muted}>これまでに発生した原価の合計</Caption1><Divider /><div className={p.spread}><Caption1>予算の使用率</Caption1><Body1Strong>{consumption}%</Body1Strong></div><ProgressBar value={progressValue(consumption)} color={new Decimal(consumption).gt(100) ? "error" : "brand"} aria-label={`予算の使用率 ${consumption}%`} /></div></Card>
        <Card className={p.card}><div className={s.metric}><Body1Strong>予算残</Body1Strong><span className={mergeClasses(s.value, remaining < 0 && p.danger)} data-testid="remaining-budget">{formatYen(remaining)}</span><Caption1 className={p.muted}>実行予算から現在の原価を引いた金額</Caption1><Divider /><div className={p.spread}><Caption1>実行予算</Caption1><Body1>{formatYen(data.execution_budget_amount)}</Body1></div><Caption1 className={p.muted}>未発生の発注済額は差し引いていません。</Caption1></div></Card>
        <Card className={p.card}><div className={s.metric}><Body1Strong>見込粗利</Body1Strong><span className={mergeClasses(s.value, data.forecast_gross_profit < 0 && p.danger)}>{formatYen(data.forecast_gross_profit)}</span><Caption1 className={p.muted}>請負額から着地予想原価を引いた金額</Caption1><Divider /><div className={p.spread}><Caption1>見込粗利率</Caption1><Badge appearance="tint" color={data.forecast_gross_profit < 0 ? "danger" : "success"}>{new Decimal(data.forecast_profit_rate).toFixed(2)}%</Badge></div><Caption1 className={p.muted}>確定した利益ではなく、現時点の見込みです。</Caption1></div></Card>
      </div>
      <div className={s.lower}>
        <Card className={p.card}><div className={p.stack}><div className={p.spread}><Title3 as="h2">原価の内訳</Title3><Caption1 className={p.muted}>発生済み</Caption1></div>
          {([['材料費', data.actual_breakdown.material_cost], ['労務費', data.actual_breakdown.labor_cost], ['外注費', data.actual_breakdown.subcontract_cost], ['現場経費', data.actual_breakdown.expense_cost], ['機械損料', data.actual_breakdown.equipment_cost]] as [string, number][]).map(([label, value]) => <div key={label} className={p.spread}><Body1>{label}</Body1><Body1Strong className={p.number}>{formatYen(value)}</Body1Strong></div>)}
          <Divider /><div className={p.spread}><Body1Strong>合計</Body1Strong><Body1Strong>{formatYen(data.actual_breakdown.total_cost)}</Body1Strong></div>
        </div></Card>
        <Card className={p.card}><div className={p.stack}><Title3 as="h2">これからの見通し</Title3><div className={p.compact}><div className={p.spread}><Body1>請負契約額（税抜）</Body1><Body1Strong>{formatYen(data.contract_amount_tax_ex)}</Body1Strong></div><Caption1 className={p.muted}>お客様と契約した工事の金額</Caption1></div><Divider /><div className={p.compact}><div className={p.spread}><Body1>発注・確定済額</Body1><Body1Strong>{formatYen(data.ordered_committed_amount)}</Body1Strong></div><Caption1 className={p.muted}>承認済み発注の合計。現在の原価と重なるため単純加算しません。</Caption1></div><Divider /><div className={p.compact}><div className={p.spread}><Body1>着地予想原価</Body1><Body1Strong>{formatYen(data.forecast_final_cost)}</Body1Strong></div><Caption1 className={p.muted}>工事が終わるまでにかかる原価の見込み</Caption1></div></div></Card>
      </div>
      <Card className={p.card}><Accordion collapsible><AccordionItem value="work-types"><AccordionHeader expandIconPosition="end"><Title3 as="h2">工種別の明細 <Caption1 className={p.muted}>（{data.by_work_type.length}件）</Caption1></Title3></AccordionHeader><AccordionPanel>
        <div className={p.compact}><Caption1 className={p.muted}>予算残は実行予算と発生済み原価の差です。小さい画面では工種ごとに縦に表示します。</Caption1><div className={p.scroll} tabIndex={0} role="region" aria-label="工種別の予算と原価"><Table className={s.table} aria-label="工種別明細">
          <TableHeader className={s.tableHead}><TableRow>{['工種', '実行予算', '発注済額', '現在の原価', '予算残', '使用率'].map(label => <TableHeaderCell key={label}>{label}</TableHeaderCell>)}</TableRow></TableHeader><TableBody className={s.tableBody}>
            {data.by_work_type.map(row => <WorkTypeRow key={row.work_type_code} row={row} />)}
            {result.totals && <WorkTypeRow row={{ ...result.totals, work_type_code: '', work_type_name: '合計' }} />}
          </TableBody></Table></div>{data.by_work_type.length === 0 && <Body1 className={p.muted}>工種別の明細はまだありません。</Body1>}</div>
      </AccordionPanel></AccordionItem></Accordion></Card>
      <Caption1 className={p.muted}>金額は円単位。表示は取得時点のデータです。最新の状況は右上の「更新」で確認できます。</Caption1>
    </>}
  </div>;
};
function WorkTypeRow({ row }: { row: WorkTypeCostRow }) {
  const p = usePageStyles(); const s = useStyles();
  return <TableRow className={s.tableRow}><TableCell className={s.tableCell} data-label="工種"><div className={p.compact}><Body1Strong>{row.work_type_name}</Body1Strong><Caption1 className={p.muted}>{row.work_type_code}</Caption1></div></TableCell>{[row.budget_amount, row.ordered_amount, row.actual_cost, row.remaining_budget].map((value, index) => <TableCell data-label={["実行予算", "発注済額", "現在の原価", "予算残"][index]} className={mergeClasses(s.tableCell, p.number, index === 3 && value < 0 && p.danger)} key={index}>{formatYen(value)}</TableCell>)}<TableCell data-label="使用率" className={mergeClasses(s.tableCell, p.number)}>{new Decimal(row.consumption_rate_percent).toFixed(2)}%</TableCell></TableRow>;
}
