import React, { useEffect, useRef, useState } from "react";
import { Badge, Body1, Body1Strong, Button, Caption1, Card, Divider, Field, Select, Spinner, Tab, TabList, Title1, Title3, makeStyles, mergeClasses, tokens, useRestoreFocusTarget } from "@fluentui/react-components";
import { ArrowRight20Regular, Box24Regular, CheckmarkCircle20Regular, ClipboardTask24Regular, People24Regular, Toolbox24Regular } from "@fluentui/react-icons";
import { LookupsDto, ProjectCostCockpitDto } from "./bindings";
import { ALL_BRANCHES, branchKey, branchLabel, ProjectSelection } from "./data";
import { describeFailure } from "./errors";
import { formatYen } from "./cockpitData";
import { ConfirmDialog, Facts, GuidanceNotice, Notice, usePageStyles } from "./ui";
import { completionLabel, InputMode, isBranchLocked, modeLabels, useCostDraft } from "./useCostDraft";
import { DailyForm, DirectForm, EquipmentForm, modeDescriptions, SubcontractForm } from "./CostForms";

/** 登録できない工事の理由（完成区分ごと）。区分1は承認権限のない利用者のみ登録不可 */
function lockedReason(status: string): string {
  return status === "1"
    ? "この工事は完成（区分1）のため、承認権限の利用者のみ原価を登録できます。施工中の工事を選択してください。"
    : "この工事は前期完成または計上ロック済のため、どの権限でも原価を登録できません。施工中または当期完成の工事を選択してください。";
}

export interface EasyCostInputProps {
  projects: ProjectCostCockpitDto[]; companyCode: string; selection: ProjectSelection; onSelect: (next: ProjectSelection) => void;
  lookups: LookupsDto | null; lookupsLoading: boolean; lookupsError: unknown; onRetryLookups: () => Promise<void>;
  onRegistered: () => Promise<boolean>; canRegisterCompleted?: boolean; onDirtyChange: (value: boolean) => void; onDraftSummaryChange?: (items: [string, string][]) => void; onBusyChange: (value: boolean) => void; onShowCockpit: () => void;
}
const useStyles = makeStyles({
  layout: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: tokens.spacingHorizontalXXL, alignItems: "start", '@media (max-width: 1180px)': { gridTemplateColumns: "minmax(0, 1fr)" } },
  steps: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalXL },
  tabs: { flexWrap: "wrap", '& button': { minHeight: "48px" } },
  amount: { overflowWrap: "anywhere", fontVariantNumeric: "tabular-nums", color: tokens.colorBrandForeground1 },
  summary: { backgroundColor: tokens.colorNeutralBackground1, minWidth: 0 },
  fullButton: { width: "100%", minHeight: "48px" },
});
const icons = { subcontract: <People24Regular />, direct: <Box24Regular />, daily: <ClipboardTask24Regular />, equipment: <Toolbox24Regular /> };

export const EasyCostInput: React.FC<EasyCostInputProps> = ({ projects, companyCode, selection, onSelect, lookups, lookupsLoading, lookupsError, onRetryLookups, onRegistered, canRegisterCompleted = true, onDirtyChange, onDraftSummaryChange, onBusyChange, onShowCockpit }) => {
  const p = usePageStyles(); const s = useStyles(); const restoreFocus = useRestoreFocusTarget(); const form = useRef<HTMLFormElement>(null); const successRef = useRef<HTMLDivElement>(null);
  const project = projects.find(item => item.key.project_code === selection.projectCode && item.key.branch_code === selection.branchCode) ?? null;
  const d = useCostDraft({ lookups, project, companyCode, allowCompleted: canRegisterCompleted, onRegistered, onDirtyChange, onBusyChange });
  const [pending, setPending] = useState<{ kind: "order" | "template" | "discard" | "submit" | "completed"; value?: string } | null>(null);
  const locked = !project || isBranchLocked(project.completion_status, canRegisterCompleted);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => { setRetrying(true); try { await onRetryLookups(); } finally { setRetrying(false); } };
  const changeOrder = (value: string) => { if (value === d.sub.orderNo) return; if (d.dirtyModes.includes("subcontract")) setPending({ kind: "order", value }); else d.selectOrder(value); };
  const changeTemplate = (value: string) => { if (d.dirtyModes.includes("direct")) setPending({ kind: "template", value }); else { const tpl = lookups?.quick_templates.find(item => item.template_code === value); if (tpl) d.applyTemplate(tpl); } };
  const focusInvalid = () => requestAnimationFrame(() => { (form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form.current?.querySelector<HTMLElement>('input, select'))?.focus(); });
  const performSubmit = async () => { await d.submit(); requestAnimationFrame(() => successRef.current?.focus()); };
  // 登録は取り消せないため、工事・内容・金額を示すダイアログで確認してから送信する
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (d.isSubmitting || locked || pending) return;
    if (!d.validate()) { focusInvalid(); return; }
    setPending({ kind: project?.completion_status === "1" ? "completed" : "submit" });
  };
  const confirm = () => {
    if (pending?.kind === "order") d.selectOrder(pending.value ?? "");
    if (pending?.kind === "template") { const tpl = lookups?.quick_templates.find(item => item.template_code === pending.value); if (tpl) d.applyTemplate(tpl); }
    if (pending?.kind === "discard") { d.clearMode(d.mode); d.setSuccess(null); }
    if (pending?.kind === "submit" || pending?.kind === "completed") void performSubmit();
    setPending(null);
  };
  const registering = pending?.kind === "submit" || pending?.kind === "completed";
  const dates = { subcontract: d.sub.month.replace('-', '年') + '月', direct: d.direct.date, daily: d.daily.date, equipment: d.equip.date };
  const targets = { subcontract: d.order ? `${d.order.subcontractor_name} · ${d.order.work_type_name}` : "発注を選択してください", direct: d.direct.itemName || "品名を入力してください", daily: d.employee?.employee_name ?? "作業員を選択してください", equipment: d.equipment?.equipment_name ?? "資機材を選択してください" };
  useEffect(() => {
    onDraftSummaryChange?.(d.dirtyModes.map(mode => [
      `${project?.project_name ?? selection.projectCode} / ${selection.branchCode}・${modeLabels[mode]}・${targets[mode]}`,
      Object.keys(d.previews[mode].errors).length ? "金額未確定（入力途中）" : formatYen(d.previews[mode].amount),
    ]));
  }, [d.dirtyModes, d.subPreview, d.directPreview, d.dailyPreview, d.equipPreview, project?.project_name, selection.projectCode, selection.branchCode, targets.subcontract, targets.direct, targets.daily, targets.equipment, onDraftSummaryChange]);
  return <div className={p.stack}>
    <div className={p.compact}><Caption1 className={p.muted}>工事原価 / 現場の記録</Caption1><Title1 as="h1">原価を登録</Title1><Body1 className={p.muted}>工事と記録する内容を選んで、入力してください。</Body1></div>
    <div className={s.steps} aria-label="登録の流れ">{['工事を確認', '記録内容を選ぶ', '入力・確認'].map((label, index) => <div className={p.row} key={label}><Badge appearance={project ? 'filled' : 'tint'} color="brand">{index + 1}</Badge><Caption1>{label}</Caption1></div>)}<div className={p.row}><Badge appearance={d.success ? 'filled' : 'outline'} color={d.success ? 'success' : 'subtle'}>4</Badge><Caption1>登録完了</Caption1></div></div>
    <Card className={p.card}><div className={p.compact}><Field label="1. 登録する工事を確認" required hint="原価は、選択した本工事または追加工事に登録されます。"><Select select={{ as: "select", ...restoreFocus }} id="easy-branch-select" size="large" className={p.control} value={project ? branchKey(project) : ""} disabled={d.isSubmitting} onChange={(_, data) => { const target = projects.find(item => branchKey(item) === data.value); if (target) onSelect({ projectCode: target.key.project_code, branchCode: target.key.branch_code }); }}><option value="">本工事または追加工事を選択してください</option>{projects.map(item => <option key={branchKey(item)} value={branchKey(item)} disabled={isBranchLocked(item.completion_status, canRegisterCompleted)}>{item.project_name} / {branchLabel(item.key.branch_code, item.branch_name)} · {completionLabel(item.completion_status, canRegisterCompleted)}</option>)}</Select></Field>
      {selection.branchCode === ALL_BRANCHES && <Notice intent="warning">工事全体の合計は登録先にできません。本工事・追加工事のどちらに登録するか選択してください。</Notice>}
      {project && <div className={p.row}><Badge appearance="tint" color={locked || project.completion_status === '1' ? 'warning' : 'success'}>{completionLabel(project.completion_status, canRegisterCompleted)}</Badge><Caption1 className={p.muted}>{project.key.project_code} / {project.key.branch_code} · 現在の原価 {formatYen(project.actual_occurred_cost)}</Caption1></div>}
      {project?.completion_status === "1" && canRegisterCompleted && <Notice intent="warning">完成済みの工事です。登録時に確認し、完成後の登録として警告が記録されます。</Notice>}
      {project && locked && <Notice intent="error">{lockedReason(project.completion_status)}</Notice>}
    </div></Card>
    {!!lookupsError && <GuidanceNotice guidance={describeFailure(lookupsError, '入力用データを取得', '取得済みデータと入力内容は保持しています。')}><Button size="large" disabled={retrying || d.isSubmitting} onClick={() => void retry()}>再取得</Button></GuidanceNotice>}
    {d.success && <div tabIndex={-1} ref={successRef} data-testid="registration-success"><Notice intent="success"><div className={p.compact}><Body1Strong>{d.success.label}を登録しました</Body1Strong><Body1>伝票番号：{d.success.documentNo}</Body1>{d.success.warnings.map((warning, index) => <Body1 key={index}>{warning}</Body1>)}<div className={p.row}><Button size="large" icon={<CheckmarkCircle20Regular />} onClick={() => { d.setSuccess(null); form.current?.querySelector<HTMLElement>('input, select')?.focus(); }} disabled={d.isSubmitting}>続けて登録する</Button><Button size="large" onClick={onShowCockpit}>工事の状況を確認</Button></div></div></Notice></div>}
    {d.refreshWarning && <Notice intent="warning">登録は完了していますが、最新データの取得に失敗しました。再登録は不要です。右上の「更新」でデータを再取得してください。</Notice>}
    {lookupsLoading && !lookups ? <Spinner label="入力に必要なデータを読み込んでいます…" /> : lookups && <>
      <Card className={p.card}><div className={p.compact}><Title3 as="h2">2. 記録する内容を選ぶ</Title3><TabList className={s.tabs} selectedValue={d.mode} onTabSelect={(_, data) => { if (!d.isSubmitting) { d.setMode(data.value as InputMode); d.setError(null); d.setFailure(null); } }} size="large" aria-label="記録する内容">{(Object.keys(modeLabels) as InputMode[]).map(mode => <Tab key={mode} id={`mode-${mode}`} aria-controls={`panel-${mode}`} value={mode} icon={icons[mode]} disabled={d.isSubmitting}>{modeLabels[mode]}{d.dirtyModes.includes(mode) && <Badge size="small" appearance="tint">入力中</Badge>}</Tab>)}</TabList><Body1 className={p.muted}>{modeDescriptions[d.mode]}</Body1></div></Card>
      <form ref={form} onSubmit={submit} noValidate aria-busy={d.isSubmitting} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}>
        <div className={s.layout}>
          <Card className={p.card}><div className={p.stack} role="tabpanel" id={`panel-${d.mode}`} aria-labelledby={`mode-${d.mode}`}><div className={p.spread}><Title3 as="h2">3. {modeLabels[d.mode]}を入力</Title3><Caption1 className={p.muted}>＊は必須項目</Caption1></div>
            {d.mode === 'subcontract' && <SubcontractForm draft={d} onChangeOrder={changeOrder} />}
            {d.mode === 'direct' && <DirectForm draft={d} lookups={lookups} onTemplate={changeTemplate} />}
            {d.mode === 'daily' && <DailyForm draft={d} lookups={lookups} />}
            {d.mode === 'equipment' && <EquipmentForm draft={d} lookups={lookups} />}
          </div></Card>
          <Card className={mergeClasses(p.card, s.summary)}><div className={p.stack}><Title3 as="h2">登録内容の確認</Title3><div className={p.compact}><Caption1 className={p.muted}>対象の工事</Caption1><Body1Strong>{project?.project_name ?? '工事を選択してください'}</Body1Strong><Body1>{project ? branchLabel(project.key.branch_code, project.branch_name) : '本工事または追加工事を指定'}</Body1></div><div className={p.compact}><Caption1 className={p.muted}>{d.mode === 'subcontract' ? '対象年月' : '日付'}</Caption1><Body1>{dates[d.mode]}</Body1></div><div className={p.compact}><Caption1 className={p.muted}>記録する対象</Caption1><Body1>{targets[d.mode]}</Body1></div><Divider />
            <div className={p.compact}><Caption1 className={p.muted}>{d.mode === 'daily' ? '概算労務原価' : '今回の原価（概算）'}</Caption1><Title1 as="p" className={s.amount} data-testid="cost-preview">{Object.keys(d.activePreview.errors).length === 0 ? formatYen(d.activePreview.amount) : '—'}</Title1><Caption1 className={p.muted}>{d.mode === 'equipment' ? '数量 × 日額 × 日数 ＋ 運賃・整備費' : d.mode === 'direct' ? '数量 × 単価（四捨五入）' : d.mode === 'subcontract' ? '控除前の出来高金額（税抜）' : '標準日額 × 作業時間 ÷ 8'}</Caption1></div>
            {d.fieldError('amount') && <Notice intent="error">{d.fieldError('amount')}</Notice>}
            {d.error && <Notice intent="error">{d.error}</Notice>}
            {d.failure && <GuidanceNotice guidance={d.failure} />}
            <Button {...restoreFocus} type="submit" appearance="primary" size="large" className={s.fullButton} disabled={d.isSubmitting || locked} icon={d.isSubmitting ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />}>{d.isSubmitting ? '登録しています…' : 'この内容で登録'}</Button>
            <Caption1 className={p.muted}>登録前に内容を確認します。金額は登録時にサーバーで再計算します。</Caption1>
            {d.dirtyModes.includes(d.mode) && <Button {...restoreFocus} type="button" appearance="subtle" size="large" disabled={d.isSubmitting} onClick={() => setPending({ kind: 'discard' })}>この方式の入力をやり直す</Button>}
            <Divider /><div className={p.row}><ArrowRight20Regular /><Caption1 className={p.muted}>画面を切り替えても入力は保持されます。再読込後は復元されません。</Caption1></div>
          </div></Card>
        </div>
      </form>
    </>}
    <ConfirmDialog open={!!pending} title={pending?.kind === 'submit' ? 'この内容で登録しますか？' : pending?.kind === 'completed' ? '完成済みの工事に登録しますか？' : pending?.kind === 'discard' ? '入力をやり直しますか？' : pending?.kind === 'order' ? '入力を破棄して発注先を変更しますか？' : '品目の入力を置き換えますか？'} action={pending?.kind === 'submit' ? '登録する' : pending?.kind === 'completed' ? '確認して登録' : pending?.kind === 'discard' ? '入力を破棄' : '変更する'} onCancel={() => setPending(null)} onConfirm={confirm}>
      {!registering && <Facts items={[["対象の工事", project ? `${project.project_name} / ${branchLabel(project.key.branch_code, project.branch_name)}` : selection.projectCode], ["方式", modeLabels[d.mode]], ["対象", targets[d.mode]], ["今回の原価（概算）", Object.keys(d.activePreview.errors).length ? "金額未確定（入力途中）" : formatYen(d.activePreview.amount)]]} />}
      {registering ? <>
        <Facts items={[["登録先", project ? `${project.project_name} / ${branchLabel(project.key.branch_code, project.branch_name)}` : '—'], ["記録する内容", modeLabels[d.mode]], ["対象", targets[d.mode]], [d.mode === 'subcontract' ? '対象年月' : '日付', dates[d.mode]], [d.mode === 'daily' ? '概算労務原価' : '今回の原価（概算）', <span data-testid="confirm-amount">{formatYen(d.activePreview.amount)}</span>]]} />
        {pending?.kind === 'completed' ? '完成後の原価登録として警告が記録されます。' : ''}登録した原価はこの画面から取り消せません。
      </> : pending?.kind === 'template' ? '品名・作業内容・単位・数量・単価・仕様を選んだ品目の内容に置き換えます。日付・購入先・備考は保持します。' : 'この方式で入力途中の内容は破棄します。他の方式の入力は保持されます。'}
    </ConfirmDialog>
  </div>;
};
