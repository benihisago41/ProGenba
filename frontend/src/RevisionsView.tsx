// 予算・発注: 工事・枝番の登録、実行予算と外注発注の案（登録）→ 承認の2段階。
// 権限の判定はサーバーが正。画面は権限のない操作のボタンを無効にし、理由を表示する。
// 表示は Fluent UI。工事・枝番の選択は「工事の状況」「原価を登録」と共有する（App の selection）。
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Body1, Body1Strong, Button, Caption1, Card, Checkbox, Divider, Field,
  Input, Select, Spinner, Tab, TabList, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Textarea, Title1, Title3,
  makeStyles, mergeClasses, tokens, useRestoreFocusTarget,
} from "@fluentui/react-components";
import {
  Add20Regular, ArrowSync20Regular, Checkmark20Regular, Delete20Regular, Dismiss20Regular, Edit20Regular, History20Regular, Save20Regular,
} from "@fluentui/react-icons";
import { API_ENDPOINTS, ProjectCostCockpitDto } from "./bindings";
import { apiFetch, MeResponse, roleLabel } from "./auth";
import { ALL_BRANCHES, ProjectSelection } from "./data";
import { describeFailure, Guidance } from "./errors";
import {
  BranchBudgetDto, BranchFieldsInput, BranchOrdersDto, BudgetDiffDto, BudgetLineDto, BudgetVersionDto, canApprove, canEditDrafts,
  completionLabel, eventLabel, formatDelta, formatRate, formatYen, OrderEntryDto, OrderFieldsInput, OrderVersionDto, previewLineAmount,
  previewOrderTax, ProjectSummaryDto, RevisionEventDto, RevisionOptionsDto, revisionsApi, statusLabel,
} from "./revisions";
import { ConfirmDialog, Facts, GuidanceNotice, Notice, usePageStyles } from "./ui";

export interface RevisionsViewProps {
  session: MeResponse;
  /** 3画面で共有する工事・枝番の選択 */
  selection: ProjectSelection;
  /** 選択の変更（未保存の入力があれば App が確認ダイアログを出す） */
  onSelect: (next: ProjectSelection) => void;
  /** 承認・登録後に「工事の状況」等の画面データを再取得する */
  onDataChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  /** ヘッダーの「更新」で増える。変わったら最新を読み直す（編集中の内容は保持） */
  reloadKey: number;
  onDraftSummaryChange?: (items: [string, string][]) => void;
}

type Selection = { project: string; branch: string };
type RunOptions = { refresh?: boolean; reflect?: boolean; kept?: string };
type Run = (label: string, action: () => Promise<unknown>, opts?: RunOptions) => Promise<boolean>;

const today = () => new Date().toISOString().slice(0, 10);
const KEPT = "入力中の内容は保持しています。";
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function decimalError(value: string, scale: number, min: string, max: string, positive = false): string | undefined {
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return "数値で入力してください。";
  if ((text.split(".")[1]?.length ?? 0) > scale) return `小数第${scale}位までで入力してください。`;
  const number = new Decimal(text);
  if ((positive ? number.lte(min) : number.lt(min)) || number.gt(max)) return `${min}${positive ? "超" : "以上"}、${max}以下で入力してください。`;
  return undefined;
}

const useStyles = makeStyles({
  columns: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: tokens.spacingHorizontalXXL, '@media (min-width: 1280px)': { gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" } },
  block: { border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, minWidth: 0, backgroundColor: tokens.colorNeutralBackground1 },
  panel: { border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusLarge, paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, minWidth: 0, backgroundColor: tokens.colorNeutralBackground2 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalM, minWidth: 0 },
  tabs: { flexWrap: "wrap", maxWidth: "100%" },
  amountCol: { width: "128px", textAlign: "right", '@media (max-width: 640px)': { width: "auto", textAlign: "left" } },
  table: { tableLayout: "fixed", width: "100%", '@media (max-width: 640px)': { display: "block", '& thead': { display: "none" }, '& tbody': { display: "block" }, '& tr': { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", paddingBottom: tokens.spacingVerticalM }, '& td': { display: "block", width: "auto", whiteSpace: "normal", overflowWrap: "anywhere" } } },
  controls: { border: "none", padding: 0, margin: 0, minWidth: 0 },
  wrap: { overflowWrap: "anywhere", minWidth: 0 },
  add: { color: tokens.colorStatusSuccessForeground1 },
  del: { color: tokens.colorStatusDangerForeground1, textDecorationLine: "line-through" },
  chg: { color: tokens.colorStatusWarningForeground1 },
  neg: { color: tokens.colorStatusDangerForeground1 },
  diffList: { margin: 0, paddingLeft: tokens.spacingHorizontalXL },
  pair: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: tokens.spacingHorizontalS },
  fields3: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: tokens.spacingHorizontalL, '@media (max-width: 900px)': { gridTemplateColumns: "minmax(0, 1fr)" } },
});

// ---------------------------------------------------------------------------
// 未保存の変更（編集中の案・登録フォーム）を App へ伝える。各フォームが自分のキーで登録する。
// ---------------------------------------------------------------------------
const DirtyContext = createContext<(key: string, dirty: boolean, summary?: [string, string]) => void>(() => undefined);
function useDirtyPart(key: string, dirty: boolean, target?: string, amount?: string) {
  const setPart = useContext(DirtyContext);
  useEffect(() => { setPart(key, dirty, target ? [`予算・発注の編集：${target}`, amount ?? "金額未確定"] : undefined); }, [setPart, key, dirty, target, amount]);
  useEffect(() => () => setPart(key, false), [setPart, key]);
}

const StatusBadge: React.FC<{ status: string; historyNo?: number }> = ({ status, historyNo }) => (
  <Badge appearance="tint" color={status === "1" ? "success" : status === "9" ? "danger" : "informative"}>
    {statusLabel(status)}{historyNo !== undefined ? `（履歴 ${historyNo}）` : ""}
  </Badge>
);

/** 操作できない理由。無効ボタンの aria-describedby から参照する */
const Reason: React.FC<{ id?: string; text: string }> = ({ id, text }) => {
  const p = usePageStyles();
  return <Caption1 id={id} role="note" className={p.muted}>{text}</Caption1>;
};

export const RevisionsView: React.FC<RevisionsViewProps> = ({ session, selection, onSelect, onDataChanged, onDirtyChange, onBusyChange, reloadKey, onDraftSummaryChange }) => {
  const p = usePageStyles(); const s = useStyles(); const restoreFocus = useRestoreFocusTarget();
  const mayEdit = canEditDrafts(session.role);
  const mayApprove = canApprove(session.role);
  const [projects, setProjects] = useState<ProjectSummaryDto[]>([]);
  const [options, setOptions] = useState<RevisionOptionsDto | null>(null);
  const [budget, setBudget] = useState<BranchBudgetDto | null>(null);
  const [orders, setOrders] = useState<BranchOrdersDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<Guidance | null>(null);
  const [projectFailure, setProjectFailure] = useState<Guidance | null>(null);
  const [branchFailure, setBranchFailure] = useState<Guidance | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Guidance | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reflection, setReflection] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "project" | "branch">("none");
  const [pendingPanel, setPendingPanel] = useState<"none" | "project" | "branch" | null>(null);
  const running = useRef(false);
  const branchRequest = useRef(0);
  const projectRequest = useRef(0);
  const [loadedKey, setLoadedKey] = useState("");

  // 未保存の変更: キーごとに保持し、どれかがあれば App に「入力中」と伝える
  const parts = useRef(new Set<string>());
  const summaries = useRef(new Map<string, [string, string]>());
  const setPart = useCallback((key: string, dirty: boolean, summary?: [string, string]) => {
    const had = parts.current.size > 0;
    if (dirty) parts.current.add(key); else parts.current.delete(key);
    if (dirty && summary) summaries.current.set(key, summary); else summaries.current.delete(key);
    if (had !== (parts.current.size > 0)) onDirtyChange(parts.current.size > 0);
    onDraftSummaryChange?.([...summaries.current.values()]);
  }, [onDirtyChange, onDraftSummaryChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  // 共有の選択から、この画面で扱う工事・枝番を決める（工事全体（合算）は登録先にできない）
  const currentProject = projects.find((x) => x.project_code === selection.projectCode) ?? null;
  const allBranches = selection.branchCode === ALL_BRANCHES;
  const currentBranch = currentProject && !allBranches ? currentProject.branches.find((b) => b.branch_code === selection.branchCode) ?? null : null;
  const sel: Selection | null = useMemo(
    () => (currentProject && currentBranch ? { project: currentProject.project_code, branch: currentBranch.branch_code } : null),
    [currentProject, currentBranch]
  );
  const selKey = sel ? `${sel.project}::${sel.branch}` : "";
  const selectionRef = useRef(selKey);
  selectionRef.current = selKey;
  const choosePanel = (next: "none" | "project" | "branch") => {
    if (parts.current.has("project-form") || parts.current.has("branch-form")) setPendingPanel(next);
    else setPanel(next);
  };

  const loadProjects = useCallback(async (): Promise<ProjectSummaryDto[]> => {
    const request = ++projectRequest.current;
    const [list, opts] = await Promise.all([revisionsApi.listProjects(), revisionsApi.options()]);
    if (request === projectRequest.current) {
      setProjects(list.projects);
      setOptions(opts);
    }
    return list.projects;
  }, []);

  const loadBranch = useCallback(async (target: Selection) => {
    const request = ++branchRequest.current;
    const key = `${target.project}::${target.branch}`;
    const [b, o] = await Promise.all([revisionsApi.getBudget(target.project, target.branch), revisionsApi.getOrders(target.project, target.branch)]);
    if (selectionRef.current === key && request === branchRequest.current) {
      setBudget(b);
      setOrders(o);
      setLoadedKey(key);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadProjects();
        if (!cancelled) setProjectFailure(null);
      } catch (e) {
        if (!cancelled) setProjectFailure(describeFailure(e, "予算・発注を読み込み", KEPT));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadProjects, reloadKey]);

  useEffect(() => {
    if (!sel) return;
    let cancelled = false;
    loadBranch(sel).then(() => { if (!cancelled) setBranchFailure(null); }).catch((e) => {
      if (!cancelled) setBranchFailure(describeFailure(e, "枝番の予算・発注を読み込み", KEPT));
    });
    return () => { cancelled = true; };
    // selKey が同じなら読み直さない（reloadKey の変化では読み直す）
  }, [selKey, loadBranch, reloadKey]);

  // 工事・枝番を変えたら、登録フォームも閉じる（選択の変更時に App が破棄を確認済み）
  useEffect(() => { setPanel("none"); setFailure(null); }, [selKey]);

  /** 承認後: コックピットの値を再取得して、反映を利用者が確認できるように表示する */
  const showReflection = useCallback(async (target: Selection) => {
    const q = `?project_code=${encodeURIComponent(target.project)}&branch_code=${encodeURIComponent(target.branch)}`;
    const res = await apiFetch(`${API_ENDPOINTS.COCKPIT}${q}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("承認後の集計を取得できませんでした。");
    const rows = (await res.json()) as ProjectCostCockpitDto[];
    const row = rows[0];
    if (!row) return;
    setReflection(
      `${row.project_name}／${row.branch_name}：実行予算 ${formatYen(row.execution_budget_amount)}（予算履歴 ${row.latest_budget_history_no}）・発注確定 ${formatYen(row.ordered_committed_amount)}・実際原価 ${formatYen(row.actual_occurred_cost)}・見込粗利 ${formatYen(row.forecast_gross_profit)}`
    );
  }, []);

  const run: Run = useCallback(
    async (label, action, opts) => {
      if (running.current) return false;
      running.current = true;
      setBusy(true);
      setFailure(null);
      setNotice(null);
      setReflection(null);
      try {
        await action();
        setNotice(`${label}しました。`);
        try {
          await loadProjects();
          if (sel) await loadBranch(sel);
          setLoadFailure(null);
          setProjectFailure(null);
          setBranchFailure(null);
          if (opts?.refresh || opts?.reflect) await onDataChanged();
          if (opts?.reflect && sel) await showReflection(sel);
        } catch {
          setLoadFailure({ intent: "warning", title: "操作は完了しましたが、最新の状態を取得できません", body: "再登録・再承認は不要です。入力中のほかの内容は保持しています。「再読み込み」で最新の状態を確認してください。" });
        }
        return true;
      } catch (e) {
        setFailure(e instanceof TypeError
          ? { intent: "error", title: "通信結果を確認できません", body: "入力内容は保持しています。サーバーで処理済みの可能性があるため、再送信の前に「再読み込み」で最新の状態を確認してください。" }
          : describeFailure(e, label, opts?.kept ?? ""));
        return false;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [loadProjects, loadBranch, onDataChanged, showReflection, sel]
  );
  const reload = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setNotice(null);
    try {
      await loadProjects();
      if (sel) await loadBranch(sel);
      setLoadFailure(null); setProjectFailure(null); setBranchFailure(null);
      setNotice("最新の状態に更新しました。入力中の内容は保持しています。");
    } catch (error) {
      setLoadFailure(describeFailure(error, "最新の状態を取得", KEPT));
    } finally { running.current = false; setBusy(false); }
  };

  const branchClosed = budget ? budget.completion_status === "2" || budget.completion_status === "3" : false;
  const readFailure = loadFailure ?? projectFailure ?? branchFailure;
  const registerReason = mayApprove ? null : "工事・枝番の登録は承認権限の利用者のみ可能です（契約額・工期は原価管理の基準値のため）。";

  if (loading) return <Spinner label="予算・発注の情報を読み込んでいます…" />;

  return (
    <DirtyContext.Provider value={setPart}>
      <fieldset disabled={busy} className={mergeClasses(p.stack, s.controls)} aria-label="予算・発注の操作">
        <div className={p.spread}>
          <div className={p.compact}>
            <Caption1 className={p.muted}>工事原価 / 予算と発注</Caption1>
            <Title1 as="h1">予算・発注</Title1>
            <Body1 className={p.muted}>案を作り、承認すると「工事の状況」に反映されます。</Body1>
          </div>
          <Badge appearance="tint" color="brand" size="large">{roleLabel(session.role)}権限</Badge>
        </div>
        <Accordion collapsible>
          <AccordionItem value="how">
            <AccordionHeader expandIconPosition="end">承認のしくみ</AccordionHeader>
            <AccordionPanel>
              <Body1>登録権限の利用者が「案」を作成・編集し、承認権限の利用者が承認すると集計に反映されます。承認済みの版は変更できず、改定は履歴番号が1つ増えた新しい版になります。否認には理由が必要です。</Body1>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>

        {readFailure && <GuidanceNotice guidance={readFailure}><Button size="large" icon={<ArrowSync20Regular />} disabled={busy} onClick={() => void reload()}>再読み込み</Button></GuidanceNotice>}
        {failure && <GuidanceNotice guidance={failure} />}
        {notice && <div role="status"><Notice intent="success">{notice}</Notice></div>}
        {reflection && <div role="status"><Notice intent="success" title="工事の状況へ反映しました">{reflection}</Notice></div>}

        <Card className={p.card}>
          <div className={p.compact}>
            <Field label="対象の工事">
              <Select
                select={{ as: "select", ...restoreFocus }}
                id="rev-project"
                size="large"
                className={p.control}
                value={currentProject?.project_code ?? ""}
                disabled={busy}
                onChange={(_, data) => {
                  const target = projects.find((x) => x.project_code === data.value);
                  if (target) onSelect({ projectCode: target.project_code, branchCode: target.branches.find((b) => b.branch_code === "000")?.branch_code ?? target.branches[0]?.branch_code ?? "000" });
                }}
              >
                {(!currentProject || projects.length === 0) && <option value="">{projects.length === 0 ? "（工事が未登録です）" : "工事を選択してください"}</option>}
                {projects.map((x) => (
                  <option key={x.project_code} value={x.project_code}>{x.project_name} · {x.project_code}</option>
                ))}
              </Select>
            </Field>
            {currentProject && (
              <TabList className={s.tabs} selectedValue={currentBranch?.branch_code ?? ""} onTabSelect={(_, data) => onSelect({ projectCode: currentProject.project_code, branchCode: String(data.value) })} size="large" aria-label="本工事・追加工事" disabled={busy}>
                {currentProject.branches.map((b) => (
                  <Tab {...restoreFocus} key={b.branch_code} value={b.branch_code}>
                    {b.branch_code === "000" ? "本工事" : `追加工事 ${b.branch_code}`} · {b.branch_name}
                    {(b.has_budget_draft || b.order_draft_count > 0) && <> <Badge size="small" appearance="tint" color="informative">案あり</Badge></>}
                  </Tab>
                ))}
              </TabList>
            )}
            {currentProject && allBranches && <Notice intent="warning">工事全体（合算）は予算・発注の対象にできません。本工事または追加工事を選択してください。</Notice>}
            {currentProject && !allBranches && !currentBranch && <Notice>枝番が見つかりません。本工事または追加工事を選択してください。</Notice>}
            {!currentProject && projects.length > 0 && <Notice>対象の工事を選択してください。</Notice>}
            {projects.length === 0 && <Notice>登録されている工事がありません。{mayApprove ? "「工事を登録」から登録できます。" : "工事の登録は承認権限の利用者にご依頼ください。"}</Notice>}
            <Divider />
            <div className={p.row}>
              <Button size="large" icon={<Add20Regular />} disabled={!mayApprove || busy} aria-describedby={registerReason ? "rev-register-reason" : undefined} aria-expanded={panel === "project"} onClick={() => choosePanel(panel === "project" ? "none" : "project")}>工事を登録</Button>
              <Button size="large" icon={<Add20Regular />} disabled={!mayApprove || busy || !currentProject} aria-describedby={registerReason ? "rev-register-reason" : undefined} aria-expanded={panel === "branch"} onClick={() => choosePanel(panel === "branch" ? "none" : "branch")}>追加工事（枝番）を登録</Button>
              <Button size="large" appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy} onClick={() => void reload()}>再読み込み</Button>
            </div>
            {registerReason && <Reason id="rev-register-reason" text={registerReason} />}

            {panel === "project" && mayApprove && options && (
              <ProjectForm
                options={options}
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={async (req) => {
                  const ok = await run(`工事「${req.project_code}」を登録`, () => revisionsApi.createProject(req), { refresh: true, kept: KEPT });
                  if (ok) {
                    // 登録済みのフォームは未保存の変更ではない。選択の変更前に解除して、確認ダイアログを出さない
                    setPart("project-form", false);
                    setPanel("none");
                    onSelect({ projectCode: req.project_code, branchCode: "000" });
                  }
                }}
              />
            )}
            {panel === "branch" && mayApprove && options && currentProject && (
              <BranchForm
                options={options}
                project={currentProject}
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={async (req) => {
                  const ok = await run(`追加工事「${currentProject.project_code}-${req.branch_code}」を登録`, () => revisionsApi.createBranch(currentProject.project_code, req), { refresh: true, kept: KEPT });
                  if (ok) {
                    setPart("branch-form", false);
                    setPanel("none");
                    onSelect({ projectCode: currentProject.project_code, branchCode: req.branch_code });
                  }
                }}
              />
            )}
          </div>
        </Card>

        {sel && loadedKey === selKey && budget && orders && options ? (
          <>
            {branchClosed && <Notice intent="warning">完成区分が「{completionLabel(budget.completion_status)}」のため、この枝番の予算・発注は登録・改定・承認できません（閲覧のみ）。</Notice>}
            <BudgetSection
              key={`b-${selKey}`}
              budget={budget}
              options={options}
              mayEdit={mayEdit && !branchClosed}
              mayApprove={mayApprove && !branchClosed}
              editReason={!mayEdit ? "閲覧権限のため、案の作成・編集・削除はできません。" : branchClosed ? "完成区分により変更できません。" : null}
              approveReason={!mayApprove ? "承認・否認は承認権限の利用者のみ可能です。" : branchClosed ? "完成区分により承認できません。" : null}
              busy={busy}
              run={run}
              failure={failure}
            />
            <OrdersSection
              key={`o-${selKey}`}
              sel={sel}
              orders={orders}
              options={options}
              mayEdit={mayEdit && !branchClosed}
              mayApprove={mayApprove && !branchClosed}
              editReason={!mayEdit ? "閲覧権限のため、発注の案の作成・編集・削除はできません。" : branchClosed ? "完成区分により変更できません。" : null}
              approveReason={!mayApprove ? "承認・否認は承認権限の利用者のみ可能です。" : branchClosed ? "完成区分により承認できません。" : null}
              busy={busy}
              run={run}
              failure={failure}
            />
            <EventsSection events={budget.events} />
          </>
        ) : sel && !readFailure ? (
          <Spinner label="枝番の予算・発注を読み込んでいます…" />
        ) : null}
        <ConfirmDialog open={pendingPanel !== null} title="入力を破棄しますか？" action="破棄する" onCancel={() => setPendingPanel(null)} onConfirm={() => { if (pendingPanel !== null) setPanel(pendingPanel); setPendingPanel(null); }}>
          <Facts items={[...summaries.current.entries()].filter(([key]) => key === "project-form" || key === "branch-form").map(([, value]) => value)} />
          入力中の工事登録を破棄します。
        </ConfirmDialog>
      </fieldset>
    </DirtyContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// 実行予算
// ---------------------------------------------------------------------------

interface LineForm {
  key: string;
  line_no: number | null;
  work_type_code: string;
  cost_element_code: string;
  item_name: string;
  specification: string;
  unit: string;
  qty: string;
  price: string;
}

let lineKeySeq = 0;
const newKey = () => `l${++lineKeySeq}`;

function toLineForm(l: BudgetLineDto): LineForm {
  return {
    key: newKey(),
    line_no: l.line_no,
    work_type_code: l.work_type_code,
    cost_element_code: l.cost_element_code,
    item_name: l.item_name,
    specification: l.specification ?? "",
    unit: l.unit,
    qty: l.planned_quantity,
    price: l.planned_unit_price,
  };
}

interface SectionProps {
  options: RevisionOptionsDto;
  mayEdit: boolean;
  mayApprove: boolean;
  editReason: string | null;
  approveReason: string | null;
  busy: boolean;
  run: Run;
  failure: Guidance | null;
}

const BudgetLines: React.FC<{ lines: BudgetLineDto[]; label: string }> = ({ lines, label }) => {
  const p = usePageStyles(); const s = useStyles();
  if (lines.length === 0) return <Body1 className={p.muted}>明細はありません。</Body1>;
  return (
    <Table className={s.table} aria-label={label} size="small">
      <TableHeader><TableRow><TableHeaderCell>明細</TableHeaderCell><TableHeaderCell className={s.amountCol}>金額</TableHeaderCell></TableRow></TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.line_no}>
            <TableCell>
              <div className={mergeClasses(p.compact, s.wrap)} style={{ rowGap: tokens.spacingVerticalXXS, paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS }}>
                <Body1Strong>#{l.line_no} {l.item_name}{l.specification ? `（${l.specification}）` : ""}</Body1Strong>
                <Caption1 className={p.muted}>{l.work_type_name ?? l.work_type_code} ／ {l.cost_element_name ?? l.cost_element_code} ／ {l.planned_quantity} {l.unit} × {l.planned_unit_price}</Caption1>
              </div>
            </TableCell>
            <TableCell className={mergeClasses(p.number, s.amountCol)}>{formatYen(l.planned_amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const BudgetDiffView: React.FC<{ diff: BudgetDiffDto }> = ({ diff }) => {
  const p = usePageStyles(); const s = useStyles();
  return (
    <div className={mergeClasses(p.inset, s.wrap)} aria-label="案と承認済み版の差分">
      <div className={p.compact}>
        <Body1Strong>差分（{diff.base_history_no === null ? "新規予算" : `承認済み 履歴 ${diff.base_history_no}`} → 案 履歴 {diff.draft_history_no}）</Body1Strong>
        <Body1>総額 {formatYen(diff.total_before)} → {formatYen(diff.total_after)}（<span className={diff.total_delta < 0 ? s.neg : undefined}>{formatDelta(diff.total_delta)}</span>）</Body1>
        {diff.added.length + diff.changed.length + diff.removed.length === 0 ? <Caption1 className={p.muted}>明細の変更はありません。</Caption1> : (
          <ul className={s.diffList}>
            {diff.added.map((l) => <li key={`a${l.line_no}`} className={s.add}>追加 #{l.line_no} {l.item_name} {formatYen(l.planned_amount)}</li>)}
            {diff.changed.map((c) => <li key={`c${c.line_no}`} className={s.chg}>変更 #{c.line_no} {c.after.item_name}：{c.before.planned_quantity}×{c.before.planned_unit_price} → {c.after.planned_quantity}×{c.after.planned_unit_price}（{formatDelta(c.amount_delta)}）</li>)}
            {diff.removed.map((l) => <li key={`r${l.line_no}`} className={s.del}>削除 #{l.line_no} {l.item_name} {formatYen(l.planned_amount)}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
};

/** 承認・否認。どちらも対象と金額を示すダイアログで確認し、否認は理由を必須にする */
const ApproveRejectControls: React.FC<{
  label: string;
  target: string;
  amount: number;
  delta: number | null;
  mayApprove: boolean;
  approveReason: string | null;
  busy: boolean;
  onApprove: (comment: string) => Promise<boolean>;
  onReject: (reason: string) => Promise<boolean>;
  failure: Guidance | null;
  onInputChange?: (dirty: boolean) => void;
  idPrefix: string;
}> = ({ label, target, amount, delta, mayApprove, approveReason, busy, onApprove, onReject, idPrefix, failure, onInputChange }) => {
  const p = usePageStyles();
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [dialog, setDialog] = useState<"none" | "approve" | "reject">("none");
  const [rejectTried, setRejectTried] = useState(false);
  const dirty = comment.trim() !== "" || reason.trim() !== "";
  useEffect(() => { onInputChange?.(dirty); }, [dirty, onInputChange]);
  useDirtyPart(`${idPrefix}-approve`, comment.trim() !== "" || reason.trim() !== "", `${label} ${target}`, formatYen(amount));
  const facts: [string, React.ReactNode][] = [["対象", target], ["金額（税抜）", formatYen(amount)]];
  if (delta !== null) facts.push(["承認済み版との差額", formatDelta(delta)]);
  const reasonError = rejectTried && reason.trim() === "" ? "否認理由を入力してください。" : reason.length > 200 ? "200文字以内で入力してください。" : undefined;
  if (!mayApprove) {
    return (
      <div className={p.compact}>
        <Divider />
        <div className={p.row}><Button size="large" appearance="primary" icon={<Checkmark20Regular />} disabled aria-describedby={`${idPrefix}-noapprove`}>{label}を承認</Button></div>
        <Reason id={`${idPrefix}-noapprove`} text={approveReason ?? "承認できません。"} />
      </div>
    );
  }
  return (
    <div className={p.compact}>
      <Divider />
      <Field label="承認コメント（任意）" hint="200文字以内">
        <Input id={`${idPrefix}-comment`} className={p.control} maxLength={200} value={comment} onChange={(_, d) => setComment(d.value)} disabled={busy} />
      </Field>
      <div className={p.row}>
        <Button size="large" appearance="primary" icon={<Checkmark20Regular />} disabled={busy} onClick={() => setDialog("approve")}>{label}を承認</Button>
        <Button size="large" icon={<Dismiss20Regular />} disabled={busy} onClick={() => { setRejectTried(false); setDialog("reject"); }}>否認…</Button>
      </div>
      <ConfirmDialog open={dialog === "approve"} title={`${label}を承認しますか？`} action="承認する" confirmDisabled={busy} onCancel={() => { if (!busy) setDialog("none"); }} onConfirm={() => { void onApprove(comment.trim()).then(ok => { if (ok) { setComment(""); setReason(""); setDialog("none"); } }); }}>
        <Facts items={comment.trim() ? [...facts, ["コメント", comment.trim()]] : facts} />
        {failure && <GuidanceNotice guidance={failure} />}
        承認すると「工事の状況」の集計に反映され、この版は変更できなくなります。
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "reject"} title={`${label}を否認しますか？`} action="否認する" onCancel={() => { if (!busy) setDialog("none"); }} confirmDisabled={busy} onConfirm={() => {
        setRejectTried(true);
        if (reason.trim() === "" || reason.length > 200) return;
        void onReject(reason.trim()).then(ok => { if (ok) { setReason(""); setComment(""); setDialog("none"); } });
      }}>
        <Facts items={facts} />
        {failure && <GuidanceNotice guidance={failure} />}
        <Field label="否認理由" required hint="作成者に伝わります（200文字以内）" validationMessage={reasonError} validationState={reasonError ? "error" : "none"}>
          <Textarea id={`${idPrefix}-reason`} resize="vertical" maxLength={200} value={reason} onChange={(_, d) => setReason(d.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
};

const BudgetSection: React.FC<SectionProps & { budget: BranchBudgetDto }> = ({ budget, options, mayEdit, mayApprove, editReason, approveReason, busy, run, failure }) => {
  const p = usePageStyles(); const s = useStyles();
  const [editing, setEditing] = useState<{ rate: string; notes: string; lines: LineForm[]; original: string } | null>(null);
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState<"none" | "cancel" | "delete" | "create" | "save">("none");
  const [removeLine, setRemoveLine] = useState<LineForm | null>(null);
  const editorDraft = useRef<BudgetVersionDto | null>(null);
  const approvalDraft = useRef<BudgetVersionDto | null>(null);
  const approvalPendingRef = useRef(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const pc = budget.project_code;
  const b = budget.branch_code;
  const draft = editing ? editorDraft.current : approvalPending ? approvalDraft.current : budget.draft;
  const holdApproval = useCallback((dirty: boolean) => {
    if (dirty && !approvalPendingRef.current) approvalDraft.current = budget.draft;
    approvalPendingRef.current = dirty;
    setApprovalPending(dirty);
  }, [budget.draft]);
  const approved = budget.approved;
  const snapshot = (e: { rate: string; notes: string; lines: LineForm[] }) => JSON.stringify([e.rate, e.notes, e.lines.map(({ key: _k, ...rest }) => rest)]);
  const changed = editing !== null && snapshot(editing) !== editing.original;

  const startEdit = (d: BudgetVersionDto) => {
    editorDraft.current = d;
    const base = { rate: d.target_gross_profit_rate, notes: d.notes ?? "", lines: d.lines.map(toLineForm) };
    setTried(false);
    setEditing({ ...base, original: snapshot(base) });
  };

  const previewTotal = useMemo(() => {
    if (!editing) return null;
    let sum = 0;
    for (const l of editing.lines) {
      const a = previewLineAmount(l.qty, l.price);
      if (a === null) return null;
      sum += a;
    }
    return sum;
  }, [editing]);
  useDirtyPart("budget-editor", changed, `実行予算 ${pc}-${b}（履歴 ${draft?.history_no ?? "—"}）`, previewTotal === null ? "金額未確定" : formatYen(previewTotal));

  const updateLine = (key: string, patch: Partial<LineForm>) =>
    setEditing((e) => (e ? { ...e, lines: e.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : e));

  const firstWt = options.work_types.find((w) => w.hierarchy_level === 3)?.code ?? options.work_types[0]?.code ?? "";
  const firstCe = options.cost_elements[0]?.code ?? "";
  const lineErrors = (l: LineForm) => ({
    item_name: l.item_name.trim() === "" ? "細目名称を入力してください。" : undefined,
    unit: l.unit.trim() === "" ? "単位を入力してください。" : undefined,
    qty: decimalError(l.qty, 3, "0", "999999999999.999", true),
    price: decimalError(l.price, 3, "0", "999999999999.999"),
  });
  const rateError = editing ? decimalError(editing.rate.trim() || "0", 2, "-100", "100") : undefined;
  const hasErrors = editing ? Boolean(rateError) || editing.lines.some((l) => Object.values(lineErrors(l)).some(Boolean)) : false;
  const save = async () => {
    if (!editing || !draft || busy || hasErrors) return;
    const ok = await run("予算案を保存", () => revisionsApi.updateBudgetDraft(pc, b, draft.history_no, {
      target_gross_profit_rate: editing.rate.trim() || "0",
      notes: editing.notes.trim() || null,
      lines: editing.lines.map((l) => ({ line_no: l.line_no, work_type_code: l.work_type_code, cost_element_code: l.cost_element_code, item_name: l.item_name, specification: l.specification.trim() || null, unit: l.unit, planned_quantity: l.qty.trim(), planned_unit_price: l.price.trim() })),
    }), { kept: KEPT });
    if (ok) { setEditing(null); setConfirm("none"); }
  };

  return (
    <Card className={p.card}>
      <section className={p.stack} aria-labelledby="rev-budget-title">
        <div className={p.compact}>
          <Title3 as="h2" id="rev-budget-title">実行予算（{budget.project_code}-{budget.branch_code} {budget.branch_name}）</Title3>
          <Caption1 className={p.muted}>版：{budget.versions.length === 0 ? "なし" : budget.versions.map((v) => `履歴${v.history_no}=${statusLabel(v.status)}`).join("・")}</Caption1>
        </div>
        <div className={s.columns}>
          <div className={p.compact}>
            <div className={p.row}><Body1Strong as="h3">承認済み最新版</Body1Strong>{approved && <StatusBadge status="1" historyNo={approved.history_no} />}</div>
            {approved ? (
              <>
                <Body1>合計 <Body1Strong>{formatYen(approved.total_budget_amount)}</Body1Strong>（目標粗利率 {approved.target_gross_profit_rate}%）</Body1>
                <BudgetLines lines={approved.lines} label="承認済みの予算明細" />
              </>
            ) : (
              <Body1 className={p.muted}>承認済みの予算はありません（工事の状況の実行予算は ¥0）。</Body1>
            )}
          </div>

          <div className={p.compact}>
            <div className={p.row}><Body1Strong as="h3">未承認の案</Body1Strong>{draft && <StatusBadge status="0" historyNo={draft.history_no} />}</div>
            {!draft ? (
              <>
                <Body1 className={p.muted}>案はありません。</Body1>
                <div className={p.row}>
                  <Button size="large" appearance="primary" icon={<Add20Regular />} disabled={!mayEdit || busy} aria-describedby={editReason ? "rev-budget-edit-reason" : undefined}
                    onClick={() => setConfirm("create")}>
                    {approved ? "改定案を作成（承認済み版を複写）" : "予算案を作成"}
                  </Button>
                </div>
                {editReason && <Reason id="rev-budget-edit-reason" text={editReason} />}
              </>
            ) : editing ? (
              <div className={p.stack}>
                {budget.draft?.history_no !== draft.history_no && <Notice intent="warning">編集中の版が変更されています。入力は保持しています。保存先の状態を確認してください。</Notice>}
                <div className={p.fields}>
                  <Field label="目標粗利率（%）" validationMessage={tried ? rateError : undefined} validationState={tried && rateError ? "error" : "none"}><Input id="rev-rate" className={p.control} inputMode="decimal" value={editing.rate} onChange={(_, d) => setEditing({ ...editing, rate: d.value })} /></Field>
                  <Field label="予算注記"><Input id="rev-notes" className={p.control} maxLength={1000} value={editing.notes} onChange={(_, d) => setEditing({ ...editing, notes: d.value })} /></Field>
                </div>
                {editing.lines.map((l, i) => {
                  const amt = previewLineAmount(l.qty, l.price);
                  const err = tried ? lineErrors(l) : { item_name: undefined, unit: undefined, qty: undefined, price: undefined };
                  return (
                    <fieldset key={l.key} className={s.block} style={{ margin: 0 }}>
                      <legend><Body1Strong>{i + 1}行目</Body1Strong> <Badge appearance="outline" size="small">{l.line_no ? `#${l.line_no}` : "新規"}</Badge></legend>
                      <div className={p.compact}>
                        <div className={p.fields}>
                          <Field label="工種"><Select className={p.control} value={l.work_type_code} onChange={(_, d) => updateLine(l.key, { work_type_code: d.value })}>{options.work_types.map((w) => <option key={w.code} value={w.code}>{w.code}：{w.name}</option>)}</Select></Field>
                          <Field label="費目"><Select className={p.control} value={l.cost_element_code} onChange={(_, d) => updateLine(l.key, { cost_element_code: d.value })}>{options.cost_elements.map((c) => <option key={c.code} value={c.code}>{c.code}：{c.name}</option>)}</Select></Field>
                          <Field label="細目名称" required validationMessage={err.item_name} validationState={err.item_name ? "error" : "none"}><Input className={p.control} maxLength={60} value={l.item_name} onChange={(_, d) => updateLine(l.key, { item_name: d.value })} /></Field>
                          <Field label="規格・仕様"><Input className={p.control} maxLength={60} value={l.specification} onChange={(_, d) => updateLine(l.key, { specification: d.value })} /></Field>
                        </div>
                        <div className={s.fields3}>
                          <Field label="数量" required validationMessage={err.qty} validationState={err.qty ? "error" : "none"}><Input className={p.control} inputMode="decimal" value={l.qty} onChange={(_, d) => updateLine(l.key, { qty: d.value })} /></Field>
                          <Field label="単位" required validationMessage={err.unit} validationState={err.unit ? "error" : "none"}><Input className={p.control} maxLength={10} value={l.unit} onChange={(_, d) => updateLine(l.key, { unit: d.value })} /></Field>
                          <Field label="単価" required validationMessage={err.price} validationState={err.price ? "error" : "none"}><Input className={p.control} inputMode="decimal" value={l.price} onChange={(_, d) => updateLine(l.key, { price: d.value })} contentAfter="円" /></Field>
                        </div>
                        <div className={p.spread}>
                          <Body1>金額（概算）：<Body1Strong>{amt === null ? "—" : formatYen(amt)}</Body1Strong></Body1>
                          <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => setRemoveLine(l)}>行を削除</Button>
                        </div>
                      </div>
                    </fieldset>
                  );
                })}
                <div className={p.row}>
                  <Button size="large" icon={<Add20Regular />} onClick={() => setEditing({ ...editing, lines: [...editing.lines, { key: newKey(), line_no: null, work_type_code: firstWt, cost_element_code: firstCe, item_name: "", specification: "", unit: "式", qty: "1.000", price: "0.000" }] })}>明細を追加</Button>
                </div>
                <div className={p.inset}>
                  <div className={p.compact}>
                    <Body1>合計（概算）：<Body1Strong>{previewTotal === null ? "—（数量・単価を確認してください）" : formatYen(previewTotal)}</Body1Strong></Body1>
                    <Caption1 className={p.muted}>明細金額・合計は保存時にサーバーが「数量×単価（小数第1位四捨五入）」で計算します。</Caption1>
                  </div>
                </div>
                <div className={p.row}>
                  <Button size="large" appearance="primary" icon={<Save20Regular />} disabled={busy}
                    onClick={() => { setTried(true); if (!hasErrors) setConfirm("save"); }}>案を保存</Button>
                  <Button size="large" disabled={busy} onClick={() => (changed ? setConfirm("cancel") : setEditing(null))}>編集をやめる</Button>
                </div>
                {tried && hasErrors && <Notice intent="error">入力内容を確認してください。赤字の項目を直すと保存できます。</Notice>}
              </div>
            ) : (
              <>
                <Body1>合計 <Body1Strong>{formatYen(draft.total_budget_amount)}</Body1Strong>（目標粗利率 {draft.target_gross_profit_rate}%）{draft.created_by && <Caption1 className={p.muted}>　作成：{draft.created_by}</Caption1>}</Body1>
                <BudgetLines lines={draft.lines} label="案の予算明細" />
                {budget.diff && <BudgetDiffView diff={budget.diff} />}
                <div className={p.row}>
                  <Button size="large" icon={<Edit20Regular />} disabled={!mayEdit || busy || approvalPending} aria-describedby={approvalPending ? "rev-budget-pending" : editReason ? "rev-budget-edit-reason" : undefined} onClick={() => startEdit(draft)}>明細を編集</Button>
                  <Button size="large" appearance="subtle" icon={<Delete20Regular />} disabled={!mayEdit || busy} aria-describedby={editReason ? "rev-budget-edit-reason" : undefined} onClick={() => setConfirm("delete")}>案を削除</Button>
                </div>
                {editReason && <Reason id="rev-budget-edit-reason" text={editReason} />}
                {approvalPending && <Reason id="rev-budget-pending" text="承認コメント・否認理由を保持しています。承認・否認を完了するか、入力を空にしてから明細を編集してください。" />}
                <ApproveRejectControls
                  onInputChange={holdApproval}
                  idPrefix="rev-budget"
                  label="予算案"
                  target={`${budget.project_name}／${budget.branch_name}（履歴 ${draft.history_no}）`}
                  amount={draft.total_budget_amount}
                  delta={budget.diff ? budget.diff.total_delta : null}
                  mayApprove={mayApprove}
                  approveReason={approveReason}
                  busy={busy}
                  failure={failure}
                  onApprove={(comment) => run("予算案を承認", () => revisionsApi.approveBudget(pc, b, draft.history_no, comment), { reflect: true, kept: KEPT })}
                  onReject={(reason) => run("予算案を否認", () => revisionsApi.rejectBudget(pc, b, draft.history_no, reason), { kept: KEPT })}
                />
              </>
            )}
          </div>
        </div>
      </section>
      <ConfirmDialog open={confirm === "create"} title="予算案を作成しますか？" action="作成する" confirmDisabled={busy} onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); void run(approved ? "予算の改定案を作成" : "予算案を作成", () => revisionsApi.createBudgetDraft(pc, b)); }}>
        <Facts items={[["対象", `${budget.project_name}／${budget.branch_name}（${pc}-${b}）`], ["複写元の合計", formatYen(approved?.total_budget_amount ?? 0)]]} />
        案は承認するまで集計に反映されません。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "save"} title="予算案を保存しますか？" action="保存する" confirmDisabled={busy} onCancel={() => { if (!busy) setConfirm("none"); }} onConfirm={() => void save()}>
        <Facts items={[["対象", `${budget.project_name}／${budget.branch_name}（履歴 ${draft?.history_no ?? "—"}）`], ["合計（概算）", previewTotal === null ? "金額未確定" : formatYen(previewTotal)]]} />
        {failure && <GuidanceNotice guidance={failure} />}
      </ConfirmDialog>
      <ConfirmDialog open={removeLine !== null} title="明細行を削除しますか？" action="削除する" onCancel={() => setRemoveLine(null)} onConfirm={() => { if (editing && removeLine) setEditing({ ...editing, lines: editing.lines.filter(x => x.key !== removeLine.key) }); setRemoveLine(null); }}>
        <Facts items={[["対象", `${pc}-${b} ${removeLine?.item_name ?? "名称未入力"}`], ["金額（概算）", removeLine && previewLineAmount(removeLine.qty, removeLine.price) !== null ? formatYen(previewLineAmount(removeLine.qty, removeLine.price)!) : "金額未確定"]]} />
        保存するまではサーバーの明細は変更されません。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "cancel"} title="編集中の内容を破棄しますか？" action="破棄する" onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); setEditing(null); }}>
        <Facts items={[["対象", `${pc}-${b}（履歴 ${draft?.history_no ?? "—"}）`], ["合計（概算）", previewTotal === null ? "金額未確定" : formatYen(previewTotal)]]} />
        保存していない予算案の変更を破棄します。保存済みの案は変わりません。
      </ConfirmDialog>
      {draft && (
        <ConfirmDialog open={confirm === "delete"} title="予算案を削除しますか？" action="削除する" onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); void run("予算案を削除", () => revisionsApi.deleteBudgetDraft(pc, b, draft.history_no)).then(ok => { if (ok) { approvalPendingRef.current = false; setApprovalPending(false); } }); }}>
          <Facts items={[["対象", `${budget.project_name}／${budget.branch_name}`], ["案", `履歴 ${draft.history_no}`], ["合計", formatYen(draft.total_budget_amount)]]} />
          削除した案は元に戻せません（操作履歴には残ります）。
        </ConfirmDialog>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// 外注発注
// ---------------------------------------------------------------------------

interface OrderForm {
  order_number: string;
  subcontractor_code: string;
  work_type_code: string;
  order_date: string;
  work_start_date: string;
  work_end_date: string;
  is_unit_price_contract: boolean;
  amount: string;
  tax_rate: string;
  retainage_rate_num: string;
  retainage_rate_den: string;
  safety_assoc_rate_num: string;
  safety_assoc_rate_den: string;
}

function orderFormFrom(o: OrderVersionDto): OrderForm {
  return {
    order_number: o.order_number,
    subcontractor_code: o.subcontractor_code,
    work_type_code: o.work_type_code,
    order_date: o.order_date,
    work_start_date: o.work_start_date,
    work_end_date: o.work_end_date,
    is_unit_price_contract: o.is_unit_price_contract,
    amount: String(o.order_amount_tax_ex),
    tax_rate: o.tax_rate,
    retainage_rate_num: o.retainage_rate_num,
    retainage_rate_den: o.retainage_rate_den,
    safety_assoc_rate_num: o.safety_assoc_rate_num,
    safety_assoc_rate_den: o.safety_assoc_rate_den,
  };
}

const AMOUNT_ERROR = "発注額（税抜）は0以上の整数（円）で入力してください";
const enteredAmount = (value: string) => {
  const amount = Number(value.replace(/,/g, "").trim());
  return value.trim() !== "" && Number.isSafeInteger(amount) && amount >= 0 ? formatYen(amount) : "金額未確定";
};
function orderFormErrors(f: OrderForm): Partial<Record<keyof OrderForm, string>> {
  const amount = Number(f.amount.replace(/,/g, "").trim());
  return {
    amount: f.amount.trim() === "" || !Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999999 ? AMOUNT_ERROR : undefined,
    subcontractor_code: !f.subcontractor_code ? "外注先を選択してください。" : undefined,
    work_type_code: !/^\d{12}$/.test(f.work_type_code) ? "工種を選択してください。" : undefined,
    order_date: !validDate(f.order_date) ? "有効な発注日を入力してください。" : undefined,
    work_start_date: !validDate(f.work_start_date) ? "有効な施工開始日を入力してください。" : undefined,
    work_end_date: !validDate(f.work_end_date) ? "有効な施工終了日を入力してください。" : f.work_start_date > f.work_end_date ? "施工開始日以降にしてください。" : undefined,
    tax_rate: decimalError(f.tax_rate, 3, "0", "1"),
    retainage_rate_num: decimalError(f.retainage_rate_num, 2, "0", "999.99"),
    retainage_rate_den: decimalError(f.retainage_rate_den, 2, "0", "99999.99", true),
    safety_assoc_rate_num: decimalError(f.safety_assoc_rate_num, 2, "0", "999.99"),
    safety_assoc_rate_den: decimalError(f.safety_assoc_rate_den, 2, "0", "99999.99", true),
  };
}
function orderFieldsFrom(f: OrderForm): OrderFieldsInput | string {
  const error = Object.values(orderFormErrors(f)).find(Boolean);
  if (error) return error;
  const amount = Number(f.amount.replace(/,/g, "").trim());
  if (!Number.isSafeInteger(amount) || amount < 0) return AMOUNT_ERROR;
  return {
    subcontractor_code: f.subcontractor_code,
    work_type_code: f.work_type_code,
    order_date: f.order_date,
    work_start_date: f.work_start_date,
    work_end_date: f.work_end_date,
    is_unit_price_contract: f.is_unit_price_contract,
    order_amount_tax_ex: amount,
    tax_rate: f.tax_rate.trim(),
    retainage_rate_num: f.retainage_rate_num.trim(),
    retainage_rate_den: f.retainage_rate_den.trim(),
    safety_assoc_rate_num: f.safety_assoc_rate_num.trim(),
    safety_assoc_rate_den: f.safety_assoc_rate_den.trim(),
  };
}

const OrderFormView: React.FC<{
  form: OrderForm;
  setForm: (f: OrderForm) => void;
  options: RevisionOptionsDto;
  isNew: boolean;
  fixedParties: boolean;
  amountError?: string;
}> = ({ form, setForm, options, isNew, fixedParties, amountError }) => {
  const p = usePageStyles(); const s = useStyles();
  const amount = Number(form.amount.replace(/,/g, ""));
  const tax = Number.isSafeInteger(amount) ? previewOrderTax(amount, form.tax_rate) : null;
  const set = (patch: Partial<OrderForm>) => setForm({ ...form, ...patch });
  const errors = amountError ? orderFormErrors(form) : {};
  return (
    <div className={p.stack}>
      <div className={p.fields}>
        {isNew && (
          <Field label="注文番号" hint="空欄なら ORD-年-連番 を自動採番">
            <Input id="rev-order-no" className={p.control} maxLength={12} value={form.order_number} onChange={(_, d) => set({ order_number: d.value })} />
          </Field>
        )}
        <Field label="外注先" validationMessage={errors.subcontractor_code} validationState={errors.subcontractor_code ? "error" : "none"}>
          <Select className={p.control} disabled={fixedParties} value={form.subcontractor_code} onChange={(_, d) => set({ subcontractor_code: d.value })}>
            {options.subcontractors.map((x) => <option key={x.code} value={x.code}>{x.code}：{x.name}</option>)}
          </Select>
        </Field>
        <Field label="工種" validationMessage={errors.work_type_code} validationState={errors.work_type_code ? "error" : "none"}>
          <Select className={p.control} disabled={fixedParties} value={form.work_type_code} onChange={(_, d) => set({ work_type_code: d.value })}>
            {options.work_types.map((w) => <option key={w.code} value={w.code}>{w.code}：{w.name}</option>)}
          </Select>
        </Field>
        <Field label="発注額（税抜）" required validationMessage={errors.amount} validationState={errors.amount ? "error" : "none"}>
          <Input className={p.control} inputMode="numeric" value={form.amount} onChange={(_, d) => set({ amount: d.value })} contentAfter="円" />
        </Field>
      </div>
      {fixedParties && <Reason text="承認済みの注文の改定では外注先・工種は変更できません。" />}
      <div className={s.fields3}>
        <Field label="発注日" validationMessage={errors.order_date} validationState={errors.order_date ? "error" : "none"}><Input type="date" className={p.control} value={form.order_date} onChange={(_, d) => set({ order_date: d.value })} /></Field>
        <Field label="施工開始" validationMessage={errors.work_start_date} validationState={errors.work_start_date ? "error" : "none"}><Input type="date" className={p.control} value={form.work_start_date} onChange={(_, d) => set({ work_start_date: d.value })} /></Field>
        <Field label="施工終了" validationMessage={errors.work_end_date} validationState={errors.work_end_date ? "error" : "none"}><Input type="date" className={p.control} value={form.work_end_date} onChange={(_, d) => set({ work_end_date: d.value })} /></Field>
        <Field label="消費税率" validationMessage={errors.tax_rate} validationState={errors.tax_rate ? "error" : "none"}><Input className={p.control} inputMode="decimal" value={form.tax_rate} onChange={(_, d) => set({ tax_rate: d.value })} /></Field>
        <Field label="保留金率（分子/分母）" validationMessage={errors.retainage_rate_num || errors.retainage_rate_den} validationState={errors.retainage_rate_num || errors.retainage_rate_den ? "error" : "none"}>
          <div className={s.pair}>
            <Input className={p.control} inputMode="decimal" aria-label="保留金率 分子" value={form.retainage_rate_num} onChange={(_, d) => set({ retainage_rate_num: d.value })} />
            <Input className={p.control} inputMode="decimal" aria-label="保留金率 分母" value={form.retainage_rate_den} onChange={(_, d) => set({ retainage_rate_den: d.value })} />
          </div>
        </Field>
        <Field label="安全協力会費率（分子/分母）" validationMessage={errors.safety_assoc_rate_num || errors.safety_assoc_rate_den} validationState={errors.safety_assoc_rate_num || errors.safety_assoc_rate_den ? "error" : "none"}>
          <div className={s.pair}>
            <Input className={p.control} inputMode="decimal" aria-label="安全協力会費率 分子" value={form.safety_assoc_rate_num} onChange={(_, d) => set({ safety_assoc_rate_num: d.value })} />
            <Input className={p.control} inputMode="decimal" aria-label="安全協力会費率 分母" value={form.safety_assoc_rate_den} onChange={(_, d) => set({ safety_assoc_rate_den: d.value })} />
          </div>
        </Field>
      </div>
      <Checkbox label="単価契約" checked={form.is_unit_price_contract} onChange={(_, d) => set({ is_unit_price_contract: d.checked === true })} />
      <div className={p.inset}>
        <div className={p.compact}>
          <Body1>消費税額（概算・切捨）：<Body1Strong>{tax === null ? "—" : formatYen(tax)}</Body1Strong></Body1>
          <Caption1 className={p.muted}>税額は保存・承認時にサーバーが計算します。出来高査定の累計を下回る発注額は承認できません。</Caption1>
        </div>
      </div>
    </div>
  );
};

const OrderSummary: React.FC<{ o: OrderVersionDto }> = ({ o }) => {
  const p = usePageStyles();
  return (
    <Caption1 className={p.muted}>
      {o.subcontractor_name ?? o.subcontractor_code} ／ {o.work_type_name ?? o.work_type_code} ／ 工期 {o.work_start_date}〜{o.work_end_date} ／ 税 {formatYen(o.order_tax_amount)}（税率 {o.tax_rate}）／ 保留 {formatRate(o.retainage_rate_num, o.retainage_rate_den)} ／ 協力会費 {formatRate(o.safety_assoc_rate_num, o.safety_assoc_rate_den)}
    </Caption1>
  );
};

const OrderCard: React.FC<SectionProps & { entry: OrderEntryDto }> = ({ entry, options, mayEdit, mayApprove, editReason, approveReason, busy, run, failure }) => {
  const p = usePageStyles(); const s = useStyles();
  const [form, setForm] = useState<{ value: OrderForm; original: string } | null>(null);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<"none" | "cancel" | "delete" | "save" | "create">("none");
  const editorDraft = useRef<OrderVersionDto | null>(null);
  const approvalDraft = useRef<OrderVersionDto | null>(null);
  const approvalPendingRef = useRef(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const { approved } = entry;
  const draft = form ? editorDraft.current : approvalPending ? approvalDraft.current : entry.draft;
  const holdApproval = useCallback((dirty: boolean) => {
    if (dirty && !approvalPendingRef.current) approvalDraft.current = entry.draft;
    approvalPendingRef.current = dirty;
    setApprovalPending(dirty);
  }, [entry.draft]);
  const n = entry.order_number;
  const idp = `rev-order-${n.replace(/[^0-9A-Za-z]/g, "_")}`;
  const changed = form !== null && JSON.stringify(form.value) !== form.original;
  useDirtyPart(`${idp}-editor`, changed, `発注案 ${n}（履歴 ${draft?.history_no ?? "—"}）`, form ? enteredAmount(form.value.amount) : undefined);
  const save = async () => {
    if (!form || !draft || busy) return;
    const f = orderFieldsFrom(form.value);
    if (typeof f === "string") { setFormError(f); return; }
    const ok = await run(`発注案 ${n} を保存`, () => revisionsApi.updateOrderDraft(n, draft.history_no, f), { kept: KEPT });
    if (ok) { setForm(null); setConfirm("none"); }
  };
  return (
    <li className={mergeClasses(s.block, s.wrap)}>
      <div className={p.compact}>
        <div className={p.row}>
          <Body1Strong>{n}</Body1Strong>
          {approved && <StatusBadge status="1" historyNo={approved.history_no} />}
          {draft && <StatusBadge status="0" historyNo={draft.history_no} />}
          {!approved && !draft && <Caption1 className={p.muted}>（承認済みの版なし）</Caption1>}
        </div>
        {approved && (
          <div className={p.compact} style={{ rowGap: tokens.spacingVerticalXXS }}>
            <Body1>承認済み：発注額 <Body1Strong>{formatYen(approved.order_amount_tax_ex)}</Body1Strong></Body1>
            <OrderSummary o={approved} />
            <Caption1 className={p.muted}>出来高査定累計 {formatYen(entry.accum_assessed_amount_tax_ex)} ／ 発注残高 {entry.remaining_order_balance === null ? "—" : formatYen(entry.remaining_order_balance)}</Caption1>
          </div>
        )}
        {draft ? (
          form ? (
            <>
              {entry.draft?.history_no !== draft.history_no && <Notice intent="warning">編集中の版が変更されています。入力は保持しています。保存先の状態を確認してください。</Notice>}
              <OrderFormView form={form.value} setForm={(value) => setForm({ ...form, value })} options={options} isNew={false} fixedParties={approved !== null} amountError={formError} />
              <div className={p.row}>
                <Button size="large" appearance="primary" icon={<Save20Regular />} disabled={busy}
                  onClick={() => {
                    const f = orderFieldsFrom(form.value);
                    if (typeof f === "string") { setFormError(f); return; }
                    setFormError(undefined);
                    setConfirm("save");
                  }}>案を保存</Button>
                <Button size="large" disabled={busy} onClick={() => (changed ? setConfirm("cancel") : setForm(null))}>編集をやめる</Button>
              </div>
            </>
          ) : (
            <>
              <div className={p.compact} style={{ rowGap: tokens.spacingVerticalXXS }}>
                <Body1>案：発注額 <Body1Strong>{formatYen(draft.order_amount_tax_ex)}</Body1Strong>{draft.created_by && <Caption1 className={p.muted}>　作成：{draft.created_by}</Caption1>}</Body1>
                <OrderSummary o={draft} />
              </div>
              {entry.diff && (
                <div className={p.inset}>
                  <div className={p.compact}>
                    <Body1Strong>差分（{entry.diff.base_history_no === null ? "新規発注" : `承認済み 履歴 ${entry.diff.base_history_no}`} → 案 履歴 {entry.diff.draft_history_no}）</Body1Strong>
                    <Body1>発注額 {formatYen(entry.diff.amount_before)} → {formatYen(entry.diff.amount_after)}（{formatDelta(entry.diff.amount_delta)}）</Body1>
                    {entry.diff.base_history_no !== null && (
                      entry.diff.changed_fields.length === 0 ? <Caption1 className={p.muted}>項目の変更はありません。</Caption1> : (
                        <ul className={s.diffList}>{entry.diff.changed_fields.map((c) => <li key={c.field} className={s.chg}>{c.label}：{c.before} → {c.after}</li>)}</ul>
                      )
                    )}
                  </div>
                </div>
              )}
              {draft.order_amount_tax_ex < entry.accum_assessed_amount_tax_ex && <Notice intent="warning">出来高査定の累計（{formatYen(entry.accum_assessed_amount_tax_ex)}）を下回るため、このままでは承認できません。</Notice>}
              <div className={p.row}>
                <Button size="large" icon={<Edit20Regular />} disabled={!mayEdit || busy || approvalPending} aria-describedby={approvalPending ? `${idp}-pending` : editReason ? `${idp}-edit` : undefined} onClick={() => { editorDraft.current = draft; const value = orderFormFrom(draft); setFormError(undefined); setForm({ value, original: JSON.stringify(value) }); }}>案を編集</Button>
                <Button size="large" appearance="subtle" icon={<Delete20Regular />} disabled={!mayEdit || busy} aria-describedby={editReason ? `${idp}-edit` : undefined} onClick={() => setConfirm("delete")}>案を削除</Button>
              </div>
              {editReason && <Reason id={`${idp}-edit`} text={editReason} />}
              {approvalPending && <Reason id={`${idp}-pending`} text="承認コメント・否認理由を保持しています。承認・否認を完了するか、入力を空にしてから案を編集してください。" />}
              <ApproveRejectControls
                onInputChange={holdApproval}
                idPrefix={idp}
                label={`発注案 ${n}`}
                target={`${n}（${draft.subcontractor_name ?? draft.subcontractor_code}・履歴 ${draft.history_no}）`}
                amount={draft.order_amount_tax_ex}
                delta={entry.diff ? entry.diff.amount_delta : null}
                mayApprove={mayApprove}
                approveReason={approveReason}
                busy={busy}
                failure={failure}
                onApprove={(comment) => run(`発注案 ${n} を承認`, () => revisionsApi.approveOrder(n, draft.history_no, comment), { reflect: true, kept: KEPT })}
                onReject={(reason) => run(`発注案 ${n} を否認`, () => revisionsApi.rejectOrder(n, draft.history_no, reason), { kept: KEPT })}
              />
            </>
          )
        ) : (
          <>
            <div className={p.row}>
              <Button size="large" icon={<Add20Regular />} disabled={!mayEdit || busy} aria-describedby={editReason ? `${idp}-edit` : undefined} onClick={() => setConfirm("create")}>改定案を作成（承認済み版を複写）</Button>
            </div>
            {editReason && <Reason id={`${idp}-edit`} text={editReason} />}
          </>
        )}
      </div>
      <ConfirmDialog open={confirm === "create"} title="発注の改定案を作成しますか？" action="作成する" confirmDisabled={busy} onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); void run(`注文 ${n} の改定案を作成`, () => revisionsApi.createOrderRevision(n)); }}>
        <Facts items={[["注文番号", n], ["対象", approved ? `${approved.project_code}-${approved.branch_code}` : "—"], ["複写元の発注額（税抜）", formatYen(approved?.order_amount_tax_ex ?? 0)]]} />
        承認済みの版を複写します。案は承認するまで集計に反映されません。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "save"} title="発注案を保存しますか？" action="保存する" confirmDisabled={busy} onCancel={() => { if (!busy) setConfirm("none"); }} onConfirm={() => void save()}>
        <Facts items={[["注文番号", n], ["案", `履歴 ${draft?.history_no ?? "—"}`], ["対象", draft ? `${draft.project_code}-${draft.branch_code}` : "—"], ["外注先", form ? nameOf(options.subcontractors, form.value.subcontractor_code) : "—"], ["発注額（税抜）", form ? enteredAmount(form.value.amount) : "金額未確定"]]} />
        {failure && <GuidanceNotice guidance={failure} />}
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "cancel"} title="編集中の内容を破棄しますか？" action="破棄する" onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); setForm(null); }}>
        <Facts items={[["注文番号", n], ["案", `履歴 ${draft?.history_no ?? "—"}`], ["発注額（税抜）", form ? enteredAmount(form.value.amount) : "金額未確定"]]} />
        保存していない発注案 {n} の変更を破棄します。保存済みの案は変わりません。
      </ConfirmDialog>
      {draft && (
        <ConfirmDialog open={confirm === "delete"} title={`発注案 ${n} を削除しますか？`} action="削除する" onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); void run(`発注案 ${n} を削除`, () => revisionsApi.deleteOrderDraft(n, draft.history_no)).then(ok => { if (ok) { approvalPendingRef.current = false; setApprovalPending(false); } }); }}>
          <Facts items={[["注文番号", n], ["案", `履歴 ${draft.history_no}`], ["外注先", draft.subcontractor_name ?? draft.subcontractor_code], ["発注額（税抜）", formatYen(draft.order_amount_tax_ex)]]} />
          削除した案は元に戻せません（操作履歴には残ります）。
        </ConfirmDialog>
      )}
    </li>
  );
};

const OrdersSection: React.FC<SectionProps & { sel: Selection; orders: BranchOrdersDto }> = (props) => {
  const { sel, orders, options, mayEdit, editReason, busy, run, failure } = props;
  const p = usePageStyles(); const s = useStyles();
  const [form, setForm] = useState<{ value: OrderForm; original: string } | null>(null);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const changed = form !== null && JSON.stringify(form.value) !== form.original;
  useDirtyPart("new-order-form", changed, `新規発注案 ${sel.project}-${sel.branch} ${form?.value.order_number || "自動採番"}`, form ? enteredAmount(form.value.amount) : undefined);
  const totalApproved = orders.orders.reduce((sum, o) => sum + (o.approved?.order_amount_tax_ex ?? 0), 0);
  const blank = (): OrderForm => ({
    order_number: "",
    subcontractor_code: options.subcontractors[0]?.code ?? "",
    work_type_code: options.work_types.find((w) => w.hierarchy_level === 3)?.code ?? options.work_types[0]?.code ?? "",
    order_date: today(),
    work_start_date: today(),
    work_end_date: today(),
    is_unit_price_contract: false,
    amount: "0",
    tax_rate: "0.100",
    retainage_rate_num: "10.00",
    retainage_rate_den: "100.00",
    safety_assoc_rate_num: "3.00",
    safety_assoc_rate_den: "1000.00",
  });
  const close = () => (changed ? setConfirmCancel(true) : setForm(null));
  const create = async () => {
    if (!form || busy) return;
    const f = orderFieldsFrom(form.value);
    if (typeof f === "string") { setFormError(f); return; }
    const ok = await run("新規発注案を作成", () => revisionsApi.createOrder({ ...f, order_number: form.value.order_number.trim() || null, project_code: sel.project, branch_code: sel.branch }), { kept: KEPT });
    if (ok) { setForm(null); setConfirmCreate(false); }
  };
  return (
    <Card className={p.card}>
      <section className={p.stack} aria-labelledby="rev-orders-title">
        <div className={p.spread}>
          <div className={p.compact}>
            <Title3 as="h2" id="rev-orders-title">外注発注</Title3>
            <Caption1 className={p.muted}>承認済み発注額の合計（税抜）：{formatYen(totalApproved)}。案は承認するまで発注確定額・出来高登録に反映されません。</Caption1>
          </div>
          <Button size="large" appearance="primary" icon={<Add20Regular />} disabled={!mayEdit || busy || options.subcontractors.length === 0} aria-describedby={editReason ? "rev-order-new-reason" : undefined}
            onClick={() => { if (form) close(); else { const value = blank(); setFormError(undefined); setForm({ value, original: JSON.stringify(value) }); } }}>新規発注案</Button>
        </div>
        {editReason && <Reason id="rev-order-new-reason" text={editReason} />}
        {form && (
          <div className={s.panel}>
            <div className={p.stack}>
              <Body1Strong as="h3">新規発注案</Body1Strong>
              <OrderFormView form={form.value} setForm={(value) => setForm({ ...form, value })} options={options} isNew fixedParties={false} amountError={formError} />
              <div className={p.row}>
                <Button size="large" appearance="primary" icon={<Save20Regular />} disabled={busy}
                  onClick={() => {
                    const f = orderFieldsFrom(form.value);
                    if (typeof f === "string") { setFormError(f); return; }
                    setFormError(undefined);
                    setConfirmCreate(true);
                  }}>発注案を作成</Button>
                <Button size="large" disabled={busy} onClick={close}>やめる</Button>
              </div>
            </div>
          </div>
        )}
        {orders.orders.length === 0 ? <Body1 className={p.muted}>この枝番の外注発注はありません。</Body1> : (
          <ul className={s.list}>{orders.orders.map((o) => <OrderCard key={o.order_number} {...props} entry={o} />)}</ul>
        )}
      </section>
      <ConfirmDialog open={confirmCreate} title="新規発注案を作成しますか？" action="作成する" confirmDisabled={busy} onCancel={() => { if (!busy) setConfirmCreate(false); }} onConfirm={() => void create()}>
        <Facts items={[["対象", `${sel.project}-${sel.branch}`], ["注文番号", form?.value.order_number.trim() || "自動採番"], ["外注先", form ? nameOf(options.subcontractors, form.value.subcontractor_code) : "—"], ["発注額（税抜）", form ? enteredAmount(form.value.amount) : "金額未確定"]]} />
        {failure && <GuidanceNotice guidance={failure} />}
        案は承認するまで集計に反映されません。
      </ConfirmDialog>
      <ConfirmDialog open={confirmCancel} title="入力中の発注案を破棄しますか？" action="破棄する" onCancel={() => setConfirmCancel(false)} onConfirm={() => { setConfirmCancel(false); setForm(null); }}>
        <Facts items={[["対象", `${sel.project}-${sel.branch}`], ["注文番号", form?.value.order_number.trim() || "自動採番"], ["発注額（税抜）", form ? enteredAmount(form.value.amount) : "金額未確定"]]} />
        まだ作成していない新規発注案の入力を破棄します。
      </ConfirmDialog>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// 操作履歴
// ---------------------------------------------------------------------------

const EventsSection: React.FC<{ events: RevisionEventDto[] }> = ({ events }) => {
  const p = usePageStyles(); const s = useStyles();
  return (
    <Card className={p.card}>
      <Accordion collapsible>
        <AccordionItem value="events">
          <AccordionHeader expandIconPosition="end" icon={<History20Regular />}><Title3 as="h2">操作履歴 <Caption1 className={p.muted}>（この枝番・{events.length}件）</Caption1></Title3></AccordionHeader>
          <AccordionPanel>
            {events.length === 0 ? <Body1 className={p.muted}>操作履歴はまだありません。</Body1> : (
              <ul className={s.list}>
                {events.map((e) => (
                  <li key={e.event_no} className={mergeClasses(s.block, s.wrap)}>
                    <div className={p.compact} style={{ rowGap: tokens.spacingVerticalXXS }}>
                      <Body1Strong>{eventLabel(e)}{e.order_number ? ` ${e.order_number}` : ""}{e.history_no !== null ? `（履歴 ${e.history_no}）` : ""}</Body1Strong>
                      <Caption1 className={p.muted}>
                        {new Date(e.occurred_at).toLocaleString("ja-JP")} ／ {e.actor_user_id}（{e.actor_role}）
                        {e.amount_before !== null || e.amount_after !== null ? ` ／ ${e.amount_before === null ? "—" : formatYen(e.amount_before)} → ${e.amount_after === null ? "—" : formatYen(e.amount_after)}` : ""}
                      </Caption1>
                      {e.reason && <Body1>{e.action === "reject" ? "否認理由" : "コメント"}：{e.reason}</Body1>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// 工事・枝番の登録（approver）
// ---------------------------------------------------------------------------

interface BranchFormState {
  branch_name: string;
  site_manager_code: string;
  supervising_engineer_code: string;
  client_partner_code: string;
  contract_start_date: string;
  contract_end_date: string;
  internal_start_date: string;
  internal_end_date: string;
  contract_amount: string;
  contract_tax: string;
  estimated_cost: string;
}

function blankBranch(options: RevisionOptionsDto, name: string): BranchFormState {
  return {
    branch_name: name,
    site_manager_code: options.employees[0]?.code ?? "",
    supervising_engineer_code: "",
    client_partner_code: options.customers[0]?.code ?? "",
    contract_start_date: today(),
    contract_end_date: today(),
    internal_start_date: today(),
    internal_end_date: today(),
    contract_amount: "0",
    contract_tax: "0",
    estimated_cost: "0",
  };
}

const MONEY_ERROR = "0以上の整数（円）で入力してください。";
const moneyValid = (v: string) => { const x = Number(v.replace(/,/g, "").trim()); return v.trim() !== "" && Number.isSafeInteger(x) && x >= 0 && x <= 999999999999999; };

function branchFieldsFrom(st: BranchFormState): BranchFieldsInput | string {
  if (!st.branch_name.trim()) return "枝番名称を入力してください。";
  if (!st.site_manager_code || !st.client_partner_code) return "発注者と現場代理人を選択してください。";
  if (![st.contract_start_date, st.contract_end_date, st.internal_start_date, st.internal_end_date].every(validDate)) return "有効な工期を入力してください。";
  if (st.contract_start_date > st.contract_end_date || st.internal_start_date > st.internal_end_date) return "工期の終了日は開始日以降にしてください。";
  if (![st.contract_amount, st.contract_tax, st.estimated_cost].every(moneyValid)) return MONEY_ERROR;
  const num = (v: string) => Number(v.replace(/,/g, "").trim());
  const a = num(st.contract_amount);
  const t = num(st.contract_tax);
  const c = num(st.estimated_cost);
  if (![a, t, c].every((x) => Number.isSafeInteger(x) && x >= 0)) return "金額は0以上の整数（円）で入力してください";
  return {
    branch_name: st.branch_name,
    site_manager_code: st.site_manager_code,
    supervising_engineer_code: st.supervising_engineer_code || null,
    chief_engineer_code: null,
    client_partner_code: st.client_partner_code,
    contract_start_date: st.contract_start_date,
    contract_end_date: st.contract_end_date,
    internal_start_date: st.internal_start_date,
    internal_end_date: st.internal_end_date,
    contract_amount_tax_ex: a,
    contract_tax_amount: t,
    estimated_total_cost: c,
  };
}

const BranchFieldsForm: React.FC<{ s: BranchFormState; set: (s: BranchFormState) => void; options: RevisionOptionsDto; tried: boolean }> = ({ s: st, set, options, tried }) => {
  const p = usePageStyles(); const s = useStyles();
  const u = (patch: Partial<BranchFormState>) => set({ ...st, ...patch });
  const money = (v: string) => (tried && !moneyValid(v) ? MONEY_ERROR : undefined);
  const nameError = tried && st.branch_name.trim() === "" ? "枝番名称を入力してください。" : undefined;
  return (
    <>
      <div className={p.fields}>
        <Field label="枝番名称" required validationMessage={nameError} validationState={nameError ? "error" : "none"}><Input className={p.control} maxLength={80} value={st.branch_name} onChange={(_, d) => u({ branch_name: d.value })} /></Field>
        <Field label="発注者（得意先）" validationMessage={tried && !st.client_partner_code ? "発注者を選択してください。" : undefined} validationState={tried && !st.client_partner_code ? "error" : "none"}><Select className={p.control} value={st.client_partner_code} onChange={(_, d) => u({ client_partner_code: d.value })}>{options.customers.map((c) => <option key={c.code} value={c.code}>{c.code}：{c.name}</option>)}</Select></Field>
        <Field label="現場代理人（社員）" validationMessage={tried && !st.site_manager_code ? "現場代理人を選択してください。" : undefined} validationState={tried && !st.site_manager_code ? "error" : "none"}><Select className={p.control} value={st.site_manager_code} onChange={(_, d) => u({ site_manager_code: d.value })}>{options.employees.map((c) => <option key={c.code} value={c.code}>{c.code}：{c.name}</option>)}</Select></Field>
        <Field label="監理技術者（任意）"><Select className={p.control} value={st.supervising_engineer_code} onChange={(_, d) => u({ supervising_engineer_code: d.value })}><option value="">（未設定）</option>{options.employees.map((c) => <option key={c.code} value={c.code}>{c.code}：{c.name}</option>)}</Select></Field>
      </div>
      <div className={p.fields}>
        {([["contract_start_date", "契約工期（開始）"], ["contract_end_date", "契約工期（終了）"], ["internal_start_date", "社内工期（開始）"], ["internal_end_date", "社内工期（終了）"]] as const).map(([k, label]) => {
          const error = !tried ? undefined : !validDate(st[k]) ? "有効な日付を入力してください。" : (k === "contract_end_date" && st.contract_start_date > st.contract_end_date) || (k === "internal_end_date" && st.internal_start_date > st.internal_end_date) ? "開始日以降にしてください。" : undefined;
          return <Field label={label} key={k} validationMessage={error} validationState={error ? "error" : "none"}><Input type="date" className={p.control} value={st[k]} onChange={(_, d) => u({ [k]: d.value } as Partial<BranchFormState>)} /></Field>;
        })}
      </div>
      <div className={s.fields3}>
        <Field label="請負金額（税抜）" validationMessage={money(st.contract_amount)} validationState={money(st.contract_amount) ? "error" : "none"}><Input className={p.control} inputMode="numeric" value={st.contract_amount} onChange={(_, d) => u({ contract_amount: d.value })} contentAfter="円" /></Field>
        <Field label="請負消費税額" validationMessage={money(st.contract_tax)} validationState={money(st.contract_tax) ? "error" : "none"}><Input className={p.control} inputMode="numeric" value={st.contract_tax} onChange={(_, d) => u({ contract_tax: d.value })} contentAfter="円" /></Field>
        <Field label="見積総原価" validationMessage={money(st.estimated_cost)} validationState={money(st.estimated_cost) ? "error" : "none"}><Input className={p.control} inputMode="numeric" value={st.estimated_cost} onChange={(_, d) => u({ estimated_cost: d.value })} contentAfter="円" /></Field>
      </div>
    </>
  );
};

const nameOf = (list: { code: string; name: string }[], code: string) => list.find((x) => x.code === code)?.name ?? code;

const ProjectForm: React.FC<{
  options: RevisionOptionsDto;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (req: Parameters<typeof revisionsApi.createProject>[0]) => Promise<void>;
}> = ({ options, busy, onCancel, onSubmit }) => {
  const p = usePageStyles(); const s = useStyles();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [doken, setDoken] = useState("2");
  const [branch, setBranch] = useState<BranchFormState>(() => blankBranch(options, "本工事"));
  const [original] = useState(() => JSON.stringify(["", "", "", "2", blankBranch(options, "本工事")]));
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState<"none" | "submit" | "cancel">("none");
  const changed = JSON.stringify([code, name, short, doken, branch]) !== original;
  useDirtyPart("project-form", changed, `工事登録 ${code || "コード未入力"} ${name}`, enteredAmount(branch.contract_amount));
  const codeError = tried && !/^[0-9A-Za-z_-]{1,10}$/.test(code.trim()) ? "英数字と - _ で10文字以内で入力してください。" : undefined;
  const nameError = tried && name.trim() === "" ? "工事名称を入力してください。" : undefined;
  const fields = branchFieldsFrom(branch);
  const valid = !codeError && !nameError && /^[0-9A-Za-z_-]{1,10}$/.test(code.trim()) && name.trim() !== "" && branch.branch_name.trim() !== "" && typeof fields !== "string";
  return (
    <div className={s.panel}>
      <div className={p.stack}>
        <Body1Strong as="h3">工事の登録（本工事 枝番 000 を同時に作成）</Body1Strong>
        <div className={p.fields}>
          <Field label="工事コード" required hint="英数字と - _、10文字以内" validationMessage={codeError} validationState={codeError ? "error" : "none"}><Input id="rev-new-project-code" className={p.control} maxLength={10} value={code} onChange={(_, d) => setCode(d.value)} /></Field>
          <Field label="土建区分"><Select className={p.control} value={doken} onChange={(_, d) => setDoken(d.value)}><option value="1">1：土木</option><option value="2">2：建築</option><option value="9">9：その他</option></Select></Field>
          <Field label="工事名称" required validationMessage={nameError} validationState={nameError ? "error" : "none"}><Input id="rev-new-project-name" className={p.control} maxLength={120} value={name} onChange={(_, d) => setName(d.value)} /></Field>
          <Field label="工事略称"><Input className={p.control} maxLength={40} value={short} onChange={(_, d) => setShort(d.value)} /></Field>
        </div>
        <BranchFieldsForm s={branch} set={setBranch} options={options} tried={tried} />
        <div className={p.row}>
          <Button size="large" appearance="primary" icon={<Save20Regular />} disabled={busy} onClick={() => { setTried(true); if (valid) setConfirm("submit"); }}>登録内容を確認</Button>
          <Button size="large" disabled={busy} onClick={() => (changed ? setConfirm("cancel") : onCancel())}>やめる</Button>
        </div>
      </div>
      <ConfirmDialog open={confirm === "submit"} title="この内容で工事を登録しますか？" action="登録する" onCancel={() => setConfirm("none")} onConfirm={() => {
        setConfirm("none");
        if (typeof fields === "string") return;
        void onSubmit({ project_code: code.trim(), project_name: name, project_short_name: short, doken_type: doken, honzatsu_type: "1", kanmin_type1: "2", main_branch: fields });
      }}>
        {typeof fields !== "string" && <Facts items={[["工事コード", code.trim()], ["工事名称", name], ["発注者", nameOf(options.customers, fields.client_partner_code)], ["請負金額（税抜）", formatYen(fields.contract_amount_tax_ex)], ["契約工期", `${fields.contract_start_date}〜${fields.contract_end_date}`]]} />}
        請負金額・工期は原価管理の基準値です。登録後はこの画面から変更できません。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "cancel"} title="入力中の工事登録を破棄しますか？" action="破棄する" onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); onCancel(); }}>
        <Facts items={[["対象", `${code || "コード未入力"} ${name}`], ["請負金額（税抜）", enteredAmount(branch.contract_amount)]]} />
        まだ登録していない工事の入力を破棄します。
      </ConfirmDialog>
    </div>
  );
};

const BranchForm: React.FC<{
  options: RevisionOptionsDto;
  project: ProjectSummaryDto;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (req: Parameters<typeof revisionsApi.createBranch>[1]) => Promise<void>;
}> = ({ options, project, busy, onCancel, onSubmit }) => {
  const p = usePageStyles(); const s = useStyles();
  const nextCode = useMemo(() => {
    const used = project.branches.map((b) => Number(b.branch_code)).filter((x) => Number.isInteger(x));
    const next = Math.max(0, ...used) + 1;
    return next <= 999 ? String(next).padStart(3, "0") : "";
  }, [project]);
  const [code, setCode] = useState(nextCode);
  const [branch, setBranch] = useState<BranchFormState>(() => blankBranch(options, "追加工事"));
  const [original] = useState(() => JSON.stringify([nextCode, blankBranch(options, "追加工事")]));
  const [tried, setTried] = useState(false);
  const [confirm, setConfirm] = useState<"none" | "submit" | "cancel">("none");
  const changed = JSON.stringify([code, branch]) !== original;
  useDirtyPart("branch-form", changed, `追加工事登録 ${project.project_code}-${code} ${branch.branch_name}`, enteredAmount(branch.contract_amount));
  const codeOk = /^\d{3}$/.test(code.trim()) && code.trim() !== "000";
  const codeError = tried && !codeOk ? "001〜999 の3桁で入力してください。" : undefined;
  const fields = branchFieldsFrom(branch);
  const valid = codeOk && branch.branch_name.trim() !== "" && typeof fields !== "string";
  return (
    <div className={s.panel}>
      <div className={p.stack}>
        <Body1Strong as="h3">追加工事の登録（{project.project_code}）</Body1Strong>
        <Field label="枝番" required hint="001〜999" validationMessage={codeError} validationState={codeError ? "error" : "none"} style={{ maxWidth: 240 }}>
          <Input id="rev-new-branch-code" className={p.control} maxLength={3} inputMode="numeric" value={code} onChange={(_, d) => setCode(d.value)} />
        </Field>
        <BranchFieldsForm s={branch} set={setBranch} options={options} tried={tried} />
        <div className={p.row}>
          <Button size="large" appearance="primary" icon={<Save20Regular />} disabled={busy} onClick={() => { setTried(true); if (valid) setConfirm("submit"); }}>登録内容を確認</Button>
          <Button size="large" disabled={busy} onClick={() => (changed ? setConfirm("cancel") : onCancel())}>やめる</Button>
        </div>
      </div>
      <ConfirmDialog open={confirm === "submit"} title="この内容で追加工事を登録しますか？" action="登録する" onCancel={() => setConfirm("none")} onConfirm={() => {
        setConfirm("none");
        if (typeof fields === "string") return;
        void onSubmit({ ...fields, branch_code: code.trim() });
      }}>
        {typeof fields !== "string" && <Facts items={[["工事", `${project.project_name}（${project.project_code}）`], ["枝番", code.trim()], ["枝番名称", fields.branch_name], ["請負金額（税抜）", formatYen(fields.contract_amount_tax_ex)], ["契約工期", `${fields.contract_start_date}〜${fields.contract_end_date}`]]} />}
        請負金額・工期は原価管理の基準値です。登録後はこの画面から変更できません。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "cancel"} title="入力中の追加工事登録を破棄しますか？" action="破棄する" onCancel={() => setConfirm("none")} onConfirm={() => { setConfirm("none"); onCancel(); }}>
        <Facts items={[["対象", `${project.project_code}-${code} ${branch.branch_name}`], ["請負金額（税抜）", enteredAmount(branch.contract_amount)]]} />
        まだ登録していない追加工事の入力を破棄します。
      </ConfirmDialog>
    </div>
  );
};
