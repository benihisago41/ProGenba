// 予算・発注タブ: 工事・枝番の登録、実行予算と外注発注の案（登録）→ 承認の2段階。
// 権限の判定はサーバーが正。画面は権限のない操作のボタンを無効にし、理由を表示する。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { API_ENDPOINTS, ProjectCostCockpitDto } from "./bindings";
import { apiFetch, MeResponse, roleLabel } from "./auth";
import {
  BranchBudgetDto,
  BranchFieldsInput,
  BranchOrdersDto,
  BudgetDiffDto,
  BudgetLineDto,
  BudgetVersionDto,
  canApprove,
  canEditDrafts,
  completionLabel,
  eventLabel,
  formatDelta,
  formatRate,
  formatYen,
  OrderEntryDto,
  OrderFieldsInput,
  OrderVersionDto,
  previewLineAmount,
  previewOrderTax,
  ProjectSummaryDto,
  RevisionEventDto,
  RevisionOptionsDto,
  revisionsApi,
  statusLabel,
} from "./revisions";

export interface RevisionsViewProps {
  session: MeResponse;
  /** 承認・登録後にコックピット等の画面データを再取得する */
  onDataChanged: () => Promise<void>;
}

type Selection = { project: string; branch: string };
type RunOptions = { refresh?: boolean; reflect?: boolean };
type Run = (label: string, action: () => Promise<unknown>, opts?: RunOptions) => Promise<boolean>;

const today = () => new Date().toISOString().slice(0, 10);

function badgeClass(status: string): string {
  return status === "1" ? "rev-badge rev-badge-approved" : status === "9" ? "rev-badge rev-badge-rejected" : "rev-badge rev-badge-draft";
}

const StatusBadge: React.FC<{ status: string; historyNo?: number }> = ({ status, historyNo }) => (
  <span className={badgeClass(status)}>
    {statusLabel(status)}
    {historyNo !== undefined ? `（履歴 ${historyNo}）` : ""}
  </span>
);

const Reason: React.FC<{ id?: string; text: string }> = ({ id, text }) => (
  <p id={id} className="rev-reason" role="note">
    {text}
  </p>
);

export const RevisionsView: React.FC<RevisionsViewProps> = ({ session, onDataChanged }) => {
  const mayEdit = canEditDrafts(session.role);
  const mayApprove = canApprove(session.role);
  const [projects, setProjects] = useState<ProjectSummaryDto[]>([]);
  const [options, setOptions] = useState<RevisionOptionsDto | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [budget, setBudget] = useState<BranchBudgetDto | null>(null);
  const [orders, setOrders] = useState<BranchOrdersDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reflection, setReflection] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "project" | "branch">("none");

  const loadProjects = useCallback(async (): Promise<ProjectSummaryDto[]> => {
    const [list, opts] = await Promise.all([revisionsApi.listProjects(), revisionsApi.options()]);
    setProjects(list.projects);
    setOptions(opts);
    return list.projects;
  }, []);

  const loadBranch = useCallback(async (s: Selection) => {
    const [b, o] = await Promise.all([revisionsApi.getBudget(s.project, s.branch), revisionsApi.getOrders(s.project, s.branch)]);
    setBudget(b);
    setOrders(o);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await loadProjects();
        const first = list.find((p) => p.branches.length > 0);
        if (!cancelled && first && first.branches[0]) {
          setSel({ project: first.project_code, branch: first.branches[0].branch_code });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (!sel) return;
    let cancelled = false;
    setBudget(null);
    setOrders(null);
    loadBranch(sel).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    });
    return () => {
      cancelled = true;
    };
  }, [sel, loadBranch]);

  /** 承認後: コックピットの値を再取得して、反映を利用者が確認できるように表示する */
  const showReflection = useCallback(async (s: Selection) => {
    const q = `?project_code=${encodeURIComponent(s.project)}&branch_code=${encodeURIComponent(s.branch)}`;
    const res = await apiFetch(`${API_ENDPOINTS.COCKPIT}${q}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const rows = (await res.json()) as ProjectCostCockpitDto[];
    const row = rows[0];
    if (!row) return;
    setReflection(
      `コックピットへ反映済み（${row.project_name}／${row.branch_name}）：実行予算 ${formatYen(row.execution_budget_amount)}（予算履歴 ${row.latest_budget_history_no}）・発注確定 ${formatYen(row.ordered_committed_amount)}・実際原価 ${formatYen(row.actual_occurred_cost)}・見込粗利 ${formatYen(row.forecast_gross_profit)}`
    );
  }, []);

  const run: Run = useCallback(
    async (label, action, opts) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      setReflection(null);
      try {
        await action();
        setNotice(`${label}しました。`);
        await loadProjects();
        if (sel) await loadBranch(sel);
        // 集計に影響する操作（承認・工事登録）の後はコックピット等を再取得する
        if (opts?.refresh || opts?.reflect) await onDataChanged();
        if (opts?.reflect && sel) await showReflection(sel);
        return true;
      } catch (e) {
        setError(`${label}できませんでした：${e instanceof Error ? e.message : String(e)}`);
        if (sel) {
          // 他の利用者の操作で状態が変わった可能性があるため最新を取り直す
          await loadBranch(sel).catch(() => undefined);
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadProjects, loadBranch, onDataChanged, showReflection, sel]
  );

  const currentProject = projects.find((p) => p.project_code === sel?.project) ?? null;
  const branchClosed = budget ? budget.completion_status === "2" || budget.completion_status === "3" : false;

  if (loading) {
    return (
      <section className="card state-box" aria-live="polite">
        <p style={{ margin: 0 }}>予算・発注の情報を読み込んでいます...</p>
      </section>
    );
  }

  return (
    <div className="rev-root">
      <section className="card">
        <div className="section-header">
          <div style={{ minWidth: 0 }}>
            <h2 className="section-title">📝 予算・発注の登録と承認</h2>
            <p className="section-subtitle">
              登録権限で「案」を作り、承認権限の利用者が承認すると集計（コックピット）に反映されます。承認済みの版は変更できず、改定は履歴番号+1の新しい版になります。
            </p>
          </div>
          <span className="kpi-tag">役割：{roleLabel(session.role)}</span>
        </div>

        {error ? (
          <div className="alert-banner alert-danger" role="alert" style={{ marginBottom: 10 }}>
            <span>⚠️ {error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="alert-banner alert-success" role="status" style={{ marginBottom: 10 }}>
            <span>✅ {notice}</span>
          </div>
        ) : null}
        {reflection ? (
          <div className="alert-banner alert-success" role="status" style={{ marginBottom: 10 }}>
            <span>📊 {reflection}</span>
          </div>
        ) : null}

        <div className="form-grid form-grid-2">
          <div className="form-field">
            <label className="form-label" htmlFor="rev-project">
              工事
            </label>
            <select
              id="rev-project"
              className="form-select"
              value={sel?.project ?? ""}
              onChange={(e) => {
                const p = projects.find((x) => x.project_code === e.target.value);
                if (p && p.branches[0]) setSel({ project: p.project_code, branch: p.branches[0].branch_code });
              }}
            >
              {projects.length === 0 ? <option value="">（工事が未登録です）</option> : null}
              {projects.map((p) => (
                <option key={p.project_code} value={p.project_code}>
                  {p.project_code}：{p.project_name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <span className="form-label">枝番（本工事・追加工事）</span>
            <div className="branch-tabs" role="tablist" aria-label="工事枝番">
              {(currentProject?.branches ?? []).map((b) => (
                <button
                  key={b.branch_code}
                  type="button"
                  role="tab"
                  aria-selected={sel?.branch === b.branch_code}
                  className={`branch-tab-btn ${sel?.branch === b.branch_code ? "active" : ""}`}
                  onClick={() => sel && setSel({ project: sel.project, branch: b.branch_code })}
                >
                  {b.branch_code}：{b.branch_name}
                  {b.has_budget_draft || b.order_draft_count > 0 ? " ●案あり" : ""}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rev-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!mayApprove || busy}
            aria-describedby={mayApprove ? undefined : "rev-register-reason"}
            onClick={() => setPanel(panel === "project" ? "none" : "project")}
          >
            ＋ 工事を登録
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!mayApprove || busy || !currentProject}
            aria-describedby={mayApprove ? undefined : "rev-register-reason"}
            onClick={() => setPanel(panel === "branch" ? "none" : "branch")}
          >
            ＋ 追加工事の枝番を登録
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => {
              void run("最新の状態に更新", async () => undefined);
            }}
          >
            🔄 再読み込み
          </button>
        </div>
        {!mayApprove ? (
          <Reason id="rev-register-reason" text="工事・枝番の登録は承認権限の利用者のみ可能です（契約額・工期は原価管理の基準値のため）。" />
        ) : null}

        {panel === "project" && mayApprove && options ? (
          <ProjectForm
            options={options}
            busy={busy}
            onCancel={() => setPanel("none")}
            onSubmit={async (req) => {
              const ok = await run(`工事「${req.project_code}」を登録`, () => revisionsApi.createProject(req), { refresh: true });
              if (ok) {
                setPanel("none");
                setSel({ project: req.project_code, branch: "000" });
              }
            }}
          />
        ) : null}
        {panel === "branch" && mayApprove && options && currentProject ? (
          <BranchForm
            options={options}
            project={currentProject}
            busy={busy}
            onCancel={() => setPanel("none")}
            onSubmit={async (req) => {
              const ok = await run(`枝番「${currentProject.project_code}-${req.branch_code}」を登録`, () => revisionsApi.createBranch(currentProject.project_code, req), {
                refresh: true,
              });
              if (ok) {
                setPanel("none");
                setSel({ project: currentProject.project_code, branch: req.branch_code });
              }
            }}
          />
        ) : null}
      </section>

      {sel && budget && orders && options ? (
        <>
          {branchClosed ? (
            <div className="alert-banner alert-warning" role="note" style={{ marginBottom: 12 }}>
              <span>完成区分が「{completionLabel(budget.completion_status)}」のため、この枝番の予算・発注は登録・改定・承認できません（閲覧のみ）。</span>
            </div>
          ) : null}
          <BudgetSection
            key={`b-${sel.project}-${sel.branch}`}
            budget={budget}
            options={options}
            mayEdit={mayEdit && !branchClosed}
            mayApprove={mayApprove && !branchClosed}
            editReason={!mayEdit ? "閲覧権限のため、案の作成・編集・削除はできません。" : branchClosed ? "完成区分により変更できません。" : null}
            approveReason={!mayApprove ? "承認・否認は承認権限の利用者のみ可能です。" : branchClosed ? "完成区分により承認できません。" : null}
            busy={busy}
            run={run}
          />
          <OrdersSection
            key={`o-${sel.project}-${sel.branch}`}
            sel={sel}
            orders={orders}
            options={options}
            mayEdit={mayEdit && !branchClosed}
            mayApprove={mayApprove && !branchClosed}
            editReason={!mayEdit ? "閲覧権限のため、発注の案の作成・編集・削除はできません。" : branchClosed ? "完成区分により変更できません。" : null}
            approveReason={!mayApprove ? "承認・否認は承認権限の利用者のみ可能です。" : branchClosed ? "完成区分により承認できません。" : null}
            busy={busy}
            run={run}
          />
          <EventsSection events={budget.events} />
        </>
      ) : sel ? (
        <section className="card state-box" aria-live="polite">
          <p style={{ margin: 0 }}>枝番の予算・発注を読み込んでいます...</p>
        </section>
      ) : null}
    </div>
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
}

const BudgetLines: React.FC<{ lines: BudgetLineDto[] }> = ({ lines }) =>
  lines.length === 0 ? (
    <p className="rev-muted">明細はありません。</p>
  ) : (
    <ul className="rev-list">
      {lines.map((l) => (
        <li key={l.line_no} className="rev-row">
          <div className="rev-row-main">
            <span className="code-pill">#{l.line_no}</span> <strong>{l.item_name}</strong>
            {l.specification ? `（${l.specification}）` : ""}
            <div className="rev-muted">
              {l.work_type_name ?? l.work_type_code} ／ {l.cost_element_name ?? l.cost_element_code} ／ {l.planned_quantity} {l.unit} × {l.planned_unit_price}
            </div>
          </div>
          <div className="rev-row-amount">{formatYen(l.planned_amount)}</div>
        </li>
      ))}
    </ul>
  );

const BudgetDiffView: React.FC<{ diff: BudgetDiffDto }> = ({ diff }) => (
  <div className="preview-box" aria-label="案と承認済み版の差分">
    <strong>
      差分（{diff.base_history_no === null ? "新規予算" : `承認済み 履歴 ${diff.base_history_no}`} → 案 履歴 {diff.draft_history_no}）
    </strong>
    <div>
      総額 {formatYen(diff.total_before)} → {formatYen(diff.total_after)}（<span className={diff.total_delta < 0 ? "text-danger" : ""}>{formatDelta(diff.total_delta)}</span>）
    </div>
    {diff.added.length + diff.changed.length + diff.removed.length === 0 ? <div className="rev-muted">明細の変更はありません。</div> : null}
    <ul className="rev-diff">
      {diff.added.map((l) => (
        <li key={`a${l.line_no}`} className="rev-diff-add">
          追加 #{l.line_no} {l.item_name} {formatYen(l.planned_amount)}
        </li>
      ))}
      {diff.changed.map((c) => (
        <li key={`c${c.line_no}`} className="rev-diff-chg">
          変更 #{c.line_no} {c.after.item_name}：{c.before.planned_quantity}×{c.before.planned_unit_price} → {c.after.planned_quantity}×{c.after.planned_unit_price}（{formatDelta(c.amount_delta)}）
        </li>
      ))}
      {diff.removed.map((l) => (
        <li key={`r${l.line_no}`} className="rev-diff-del">
          削除 #{l.line_no} {l.item_name} {formatYen(l.planned_amount)}
        </li>
      ))}
    </ul>
  </div>
);

const ApproveRejectControls: React.FC<{
  label: string;
  mayApprove: boolean;
  approveReason: string | null;
  busy: boolean;
  onApprove: (comment: string) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
  idPrefix: string;
}> = ({ label, mayApprove, approveReason, busy, onApprove, onReject, idPrefix }) => {
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  return (
    <div className="rev-approve">
      {mayApprove ? (
        <>
          <div className="form-field">
            <label className="form-label" htmlFor={`${idPrefix}-comment`}>
              承認コメント（任意）
            </label>
            <input id={`${idPrefix}-comment`} className="form-input" maxLength={200} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="rev-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onApprove(comment.trim())}>
              ✅ {label}を承認
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRejecting(!rejecting)}>
              否認…
            </button>
          </div>
          {rejecting ? (
            <div className="form-field" style={{ marginTop: 8 }}>
              <label className="form-label" htmlFor={`${idPrefix}-reason`}>
                否認理由（必須・200文字以内）
              </label>
              <textarea id={`${idPrefix}-reason`} className="form-textarea" rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="rev-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || reason.trim() === ""}
                  onClick={() => void onReject(reason.trim())}
                >
                  否認する
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="rev-actions">
            <button type="button" className="btn btn-primary" disabled aria-describedby={`${idPrefix}-noapprove`}>
              ✅ {label}を承認
            </button>
          </div>
          <Reason id={`${idPrefix}-noapprove`} text={approveReason ?? "承認できません。"} />
        </>
      )}
    </div>
  );
};

const BudgetSection: React.FC<SectionProps & { budget: BranchBudgetDto }> = ({ budget, options, mayEdit, mayApprove, editReason, approveReason, busy, run }) => {
  const [editing, setEditing] = useState<{ rate: string; notes: string; lines: LineForm[] } | null>(null);
  const p = budget.project_code;
  const b = budget.branch_code;
  const draft = budget.draft;
  const approved = budget.approved;

  const startEdit = (d: BudgetVersionDto) =>
    setEditing({ rate: d.target_gross_profit_rate, notes: d.notes ?? "", lines: d.lines.map(toLineForm) });

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

  const updateLine = (key: string, patch: Partial<LineForm>) =>
    setEditing((e) => (e ? { ...e, lines: e.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : e));

  const firstWt = options.work_types.find((w) => w.hierarchy_level === 3)?.code ?? options.work_types[0]?.code ?? "";
  const firstCe = options.cost_elements[0]?.code ?? "";

  return (
    <section className="card" aria-labelledby="rev-budget-title">
      <div className="section-header">
        <div style={{ minWidth: 0 }}>
          <h2 id="rev-budget-title" className="section-title">
            💴 実行予算（{budget.project_code}-{budget.branch_code} {budget.branch_name}）
          </h2>
          <p className="section-subtitle">
            版：{budget.versions.length === 0 ? "なし" : budget.versions.map((v) => `履歴${v.history_no}=${statusLabel(v.status)}`).join("・")}
          </p>
        </div>
      </div>

      <div className="rev-columns">
        <div className="rev-col">
          <h3 className="rev-h3">
            承認済み最新版 {approved ? <StatusBadge status="1" historyNo={approved.history_no} /> : null}
          </h3>
          {approved ? (
            <>
              <div className="rev-total">
                合計 <strong>{formatYen(approved.total_budget_amount)}</strong>（目標粗利率 {approved.target_gross_profit_rate}%）
              </div>
              <BudgetLines lines={approved.lines} />
            </>
          ) : (
            <p className="rev-muted">承認済みの予算はありません（コックピットの実行予算は ¥0）。</p>
          )}
        </div>

        <div className="rev-col">
          <h3 className="rev-h3">未承認の案 {draft ? <StatusBadge status="0" historyNo={draft.history_no} /> : null}</h3>
          {!draft ? (
            <>
              <p className="rev-muted">案はありません。</p>
              <div className="rev-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!mayEdit || busy}
                  aria-describedby={mayEdit ? undefined : "rev-budget-edit-reason"}
                  onClick={() => void run(approved ? "予算の改定案を作成" : "予算案を作成", () => revisionsApi.createBudgetDraft(p, b))}
                >
                  {approved ? "＋ 改定案を作成（承認済み版を複写）" : "＋ 予算案を作成"}
                </button>
              </div>
              {editReason ? <Reason id="rev-budget-edit-reason" text={editReason} /> : null}
            </>
          ) : editing ? (
            <div className="rev-editor">
              <div className="form-grid form-grid-2">
                <div className="form-field">
                  <label className="form-label" htmlFor="rev-rate">
                    目標粗利率（%）
                  </label>
                  <input id="rev-rate" className="form-input" inputMode="decimal" value={editing.rate} onChange={(e) => setEditing({ ...editing, rate: e.target.value })} />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="rev-notes">
                    予算注記
                  </label>
                  <input id="rev-notes" className="form-input" maxLength={1000} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
                </div>
              </div>
              {editing.lines.map((l, i) => {
                const amt = previewLineAmount(l.qty, l.price);
                return (
                  <fieldset key={l.key} className="rev-line-editor">
                    <legend>
                      {i + 1}行目 {l.line_no ? <span className="code-pill">#{l.line_no}</span> : <span className="code-pill">新規</span>}
                    </legend>
                    <div className="form-grid form-grid-2">
                      <div className="form-field">
                        <label className="form-label">工種</label>
                        <select className="form-select" value={l.work_type_code} onChange={(e) => updateLine(l.key, { work_type_code: e.target.value })}>
                          {options.work_types.map((w) => (
                            <option key={w.code} value={w.code}>
                              {w.code}：{w.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="form-field">
                        <label className="form-label">費目</label>
                        <select className="form-select" value={l.cost_element_code} onChange={(e) => updateLine(l.key, { cost_element_code: e.target.value })}>
                          {options.cost_elements.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code}：{c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="form-field">
                        <label className="form-label">細目名称</label>
                        <input className="form-input" maxLength={60} value={l.item_name} onChange={(e) => updateLine(l.key, { item_name: e.target.value })} />
                      </div>
                      <div className="form-field">
                        <label className="form-label">規格・仕様</label>
                        <input className="form-input" maxLength={60} value={l.specification} onChange={(e) => updateLine(l.key, { specification: e.target.value })} />
                      </div>
                    </div>
                    <div className="form-grid form-grid-3">
                      <div className="form-field">
                        <label className="form-label">数量</label>
                        <input className="form-input" inputMode="decimal" value={l.qty} onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                      </div>
                      <div className="form-field">
                        <label className="form-label">単位</label>
                        <input className="form-input" maxLength={10} value={l.unit} onChange={(e) => updateLine(l.key, { unit: e.target.value })} />
                      </div>
                      <div className="form-field">
                        <label className="form-label">単価</label>
                        <input className="form-input" inputMode="decimal" value={l.price} onChange={(e) => updateLine(l.key, { price: e.target.value })} />
                      </div>
                    </div>
                    <div className="rev-actions" style={{ justifyContent: "space-between" }}>
                      <span>金額（概算）：{amt === null ? "—" : formatYen(amt)}</span>
                      <button type="button" className="btn btn-secondary" onClick={() => setEditing({ ...editing, lines: editing.lines.filter((x) => x.key !== l.key) })}>
                        行を削除
                      </button>
                    </div>
                  </fieldset>
                );
              })}
              <div className="rev-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      lines: [
                        ...editing.lines,
                        { key: newKey(), line_no: null, work_type_code: firstWt, cost_element_code: firstCe, item_name: "", specification: "", unit: "式", qty: "1.000", price: "0.000" },
                      ],
                    })
                  }
                >
                  ＋ 明細を追加
                </button>
              </div>
              <div className="preview-box">
                合計（概算）：{previewTotal === null ? "—（数量・単価を確認してください）" : formatYen(previewTotal)}
                <div className="rev-muted">明細金額・合計は保存時にサーバーが「数量×単価（小数第1位四捨五入）」で計算します。</div>
              </div>
              <div className="rev-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await run("予算案を保存", () =>
                      revisionsApi.updateBudgetDraft(p, b, draft.history_no, {
                        target_gross_profit_rate: editing.rate.trim() || "0",
                        notes: editing.notes.trim() || null,
                        lines: editing.lines.map((l) => ({
                          line_no: l.line_no,
                          work_type_code: l.work_type_code,
                          cost_element_code: l.cost_element_code,
                          item_name: l.item_name,
                          specification: l.specification.trim() || null,
                          unit: l.unit,
                          planned_quantity: l.qty.trim(),
                          planned_unit_price: l.price.trim(),
                        })),
                      })
                    );
                    if (ok) setEditing(null);
                  }}
                >
                  💾 案を保存
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(null)}>
                  編集をやめる
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="rev-total">
                合計 <strong>{formatYen(draft.total_budget_amount)}</strong>（目標粗利率 {draft.target_gross_profit_rate}%）
                {draft.created_by ? <span className="rev-muted">　作成：{draft.created_by}</span> : null}
              </div>
              <BudgetLines lines={draft.lines} />
              {budget.diff ? <BudgetDiffView diff={budget.diff} /> : null}
              <div className="rev-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!mayEdit || busy}
                  aria-describedby={mayEdit ? undefined : "rev-budget-edit-reason"}
                  onClick={() => startEdit(draft)}
                >
                  ✏️ 明細を編集
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!mayEdit || busy}
                  aria-describedby={mayEdit ? undefined : "rev-budget-edit-reason"}
                  onClick={() => {
                    if (window.confirm(`予算案（履歴 ${draft.history_no}）を削除しますか？`)) {
                      void run("予算案を削除", () => revisionsApi.deleteBudgetDraft(p, b, draft.history_no));
                    }
                  }}
                >
                  🗑 案を削除
                </button>
              </div>
              {editReason ? <Reason id="rev-budget-edit-reason" text={editReason} /> : null}
              <ApproveRejectControls
                idPrefix="rev-budget"
                label="予算案"
                mayApprove={mayApprove}
                approveReason={approveReason}
                busy={busy}
                onApprove={async (comment) => {
                  await run("予算案を承認", () => revisionsApi.approveBudget(p, b, draft.history_no, comment), { reflect: true });
                }}
                onReject={async (reason) => {
                  await run("予算案を否認", () => revisionsApi.rejectBudget(p, b, draft.history_no, reason));
                }}
              />
            </>
          )}
        </div>
      </div>
    </section>
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

function orderFieldsFrom(f: OrderForm): OrderFieldsInput | string {
  const amount = Number(f.amount.replace(/,/g, "").trim());
  if (!Number.isSafeInteger(amount) || amount < 0) return "発注額（税抜）は0以上の整数（円）で入力してください";
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
}> = ({ form, setForm, options, isNew, fixedParties }) => {
  const amount = Number(form.amount.replace(/,/g, ""));
  const tax = Number.isSafeInteger(amount) ? previewOrderTax(amount, form.tax_rate) : null;
  const set = (patch: Partial<OrderForm>) => setForm({ ...form, ...patch });
  return (
    <div className="rev-editor">
      <div className="form-grid form-grid-2">
        {isNew ? (
          <div className="form-field">
            <label className="form-label" htmlFor="rev-order-no">
              注文番号（空欄なら ORD-年-連番 を自動採番）
            </label>
            <input id="rev-order-no" className="form-input" maxLength={12} value={form.order_number} onChange={(e) => set({ order_number: e.target.value })} />
          </div>
        ) : null}
        <div className="form-field">
          <label className="form-label">外注先</label>
          <select className="form-select" disabled={fixedParties} value={form.subcontractor_code} onChange={(e) => set({ subcontractor_code: e.target.value })}>
            {options.subcontractors.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code}：{s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="form-label">工種</label>
          <select className="form-select" disabled={fixedParties} value={form.work_type_code} onChange={(e) => set({ work_type_code: e.target.value })}>
            {options.work_types.map((w) => (
              <option key={w.code} value={w.code}>
                {w.code}：{w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="form-label">発注額（税抜・円）</label>
          <input className="form-input" inputMode="numeric" value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
        </div>
      </div>
      {fixedParties ? <Reason text="承認済みの注文の改定では外注先・工種は変更できません。" /> : null}
      <div className="form-grid form-grid-3">
        <div className="form-field">
          <label className="form-label">発注日</label>
          <input type="date" className="form-input" value={form.order_date} onChange={(e) => set({ order_date: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">施工開始</label>
          <input type="date" className="form-input" value={form.work_start_date} onChange={(e) => set({ work_start_date: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">施工終了</label>
          <input type="date" className="form-input" value={form.work_end_date} onChange={(e) => set({ work_end_date: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">消費税率</label>
          <input className="form-input" inputMode="decimal" value={form.tax_rate} onChange={(e) => set({ tax_rate: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">保留金率（分子/分母）</label>
          <div className="rev-pair">
            <input className="form-input" inputMode="decimal" aria-label="保留金率 分子" value={form.retainage_rate_num} onChange={(e) => set({ retainage_rate_num: e.target.value })} />
            <input className="form-input" inputMode="decimal" aria-label="保留金率 分母" value={form.retainage_rate_den} onChange={(e) => set({ retainage_rate_den: e.target.value })} />
          </div>
        </div>
        <div className="form-field">
          <label className="form-label">安全協力会費率（分子/分母）</label>
          <div className="rev-pair">
            <input className="form-input" inputMode="decimal" aria-label="安全協力会費率 分子" value={form.safety_assoc_rate_num} onChange={(e) => set({ safety_assoc_rate_num: e.target.value })} />
            <input className="form-input" inputMode="decimal" aria-label="安全協力会費率 分母" value={form.safety_assoc_rate_den} onChange={(e) => set({ safety_assoc_rate_den: e.target.value })} />
          </div>
        </div>
      </div>
      <label className="rev-check">
        <input type="checkbox" checked={form.is_unit_price_contract} onChange={(e) => set({ is_unit_price_contract: e.target.checked })} /> 単価契約
      </label>
      <div className="preview-box">
        消費税額（概算・切捨）：{tax === null ? "—" : formatYen(tax)}
        <div className="rev-muted">税額は保存・承認時にサーバーが計算します。出来高査定の累計を下回る発注額は承認できません。</div>
      </div>
    </div>
  );
};

const OrderSummary: React.FC<{ o: OrderVersionDto }> = ({ o }) => (
  <div className="rev-muted">
    {o.subcontractor_name ?? o.subcontractor_code} ／ {o.work_type_name ?? o.work_type_code} ／ 工期 {o.work_start_date}〜{o.work_end_date} ／ 税 {formatYen(o.order_tax_amount)}（税率 {o.tax_rate}）／ 保留 {formatRate(o.retainage_rate_num, o.retainage_rate_den)} ／ 協力会費{" "}
    {formatRate(o.safety_assoc_rate_num, o.safety_assoc_rate_den)}
  </div>
);

const OrderCard: React.FC<SectionProps & { entry: OrderEntryDto }> = ({ entry, options, mayEdit, mayApprove, editReason, approveReason, busy, run }) => {
  const [form, setForm] = useState<OrderForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const { approved, draft } = entry;
  const n = entry.order_number;
  const idp = `rev-order-${n.replace(/[^0-9A-Za-z]/g, "_")}`;
  return (
    <li className="rev-order">
      <div className="rev-order-head">
        <strong>{n}</strong>
        {approved ? <StatusBadge status="1" historyNo={approved.history_no} /> : null}
        {draft ? <StatusBadge status="0" historyNo={draft.history_no} /> : null}
        {!approved && !draft ? <span className="rev-muted">（承認済みの版なし）</span> : null}
      </div>
      {approved ? (
        <div className="rev-row">
          <div className="rev-row-main">
            承認済み：発注額 <strong>{formatYen(approved.order_amount_tax_ex)}</strong>
            <OrderSummary o={approved} />
            <div className="rev-muted">
              出来高査定累計 {formatYen(entry.accum_assessed_amount_tax_ex)} ／ 発注残高 {entry.remaining_order_balance === null ? "—" : formatYen(entry.remaining_order_balance)}
            </div>
          </div>
        </div>
      ) : null}
      {draft ? (
        form ? (
          <>
            <OrderFormView form={form} setForm={setForm} options={options} isNew={false} fixedParties={approved !== null} />
            {formError ? <div className="alert-banner alert-danger">{formError}</div> : null}
            <div className="rev-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  const f = orderFieldsFrom(form);
                  if (typeof f === "string") {
                    setFormError(f);
                    return;
                  }
                  setFormError(null);
                  const ok = await run(`発注案 ${n} を保存`, () => revisionsApi.updateOrderDraft(n, draft.history_no, f));
                  if (ok) setForm(null);
                }}
              >
                💾 案を保存
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setForm(null)}>
                編集をやめる
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="rev-row">
              <div className="rev-row-main">
                案：発注額 <strong>{formatYen(draft.order_amount_tax_ex)}</strong>
                {draft.created_by ? <span className="rev-muted">　作成：{draft.created_by}</span> : null}
                <OrderSummary o={draft} />
              </div>
            </div>
            {entry.diff ? (
              <div className="preview-box">
                <strong>差分（{entry.diff.base_history_no === null ? "新規発注" : `承認済み 履歴 ${entry.diff.base_history_no}`} → 案 履歴 {entry.diff.draft_history_no}）</strong>
                <div>
                  発注額 {formatYen(entry.diff.amount_before)} → {formatYen(entry.diff.amount_after)}（
                  <span className={entry.diff.amount_delta < 0 ? "text-danger" : ""}>{formatDelta(entry.diff.amount_delta)}</span>）
                </div>
                {entry.diff.base_history_no !== null ? (
                  <ul className="rev-diff">
                    {entry.diff.changed_fields.length === 0 ? <li className="rev-muted">項目の変更はありません。</li> : null}
                    {entry.diff.changed_fields.map((c) => (
                      <li key={c.field} className="rev-diff-chg">
                        {c.label}：{c.before} → {c.after}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {draft.order_amount_tax_ex < entry.accum_assessed_amount_tax_ex ? (
                  <div className="text-danger">出来高査定の累計（{formatYen(entry.accum_assessed_amount_tax_ex)}）を下回るため、このままでは承認できません。</div>
                ) : null}
              </div>
            ) : null}
            <div className="rev-actions">
              <button type="button" className="btn btn-secondary" disabled={!mayEdit || busy} aria-describedby={mayEdit ? undefined : `${idp}-edit`} onClick={() => setForm(orderFormFrom(draft))}>
                ✏️ 案を編集
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!mayEdit || busy}
                aria-describedby={mayEdit ? undefined : `${idp}-edit`}
                onClick={() => {
                  if (window.confirm(`発注案 ${n}（履歴 ${draft.history_no}）を削除しますか？`)) {
                    void run(`発注案 ${n} を削除`, () => revisionsApi.deleteOrderDraft(n, draft.history_no));
                  }
                }}
              >
                🗑 案を削除
              </button>
            </div>
            {editReason ? <Reason id={`${idp}-edit`} text={editReason} /> : null}
            <ApproveRejectControls
              idPrefix={idp}
              label={`発注案 ${n}`}
              mayApprove={mayApprove}
              approveReason={approveReason}
              busy={busy}
              onApprove={async (comment) => {
                await run(`発注案 ${n} を承認`, () => revisionsApi.approveOrder(n, draft.history_no, comment), { reflect: true });
              }}
              onReject={async (reason) => {
                await run(`発注案 ${n} を否認`, () => revisionsApi.rejectOrder(n, draft.history_no, reason));
              }}
            />
          </>
        )
      ) : (
        <>
          <div className="rev-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!mayEdit || busy}
              aria-describedby={mayEdit ? undefined : `${idp}-edit`}
              onClick={() => void run(`注文 ${n} の改定案を作成`, () => revisionsApi.createOrderRevision(n))}
            >
              ＋ 改定案を作成（承認済み版を複写）
            </button>
          </div>
          {editReason ? <Reason id={`${idp}-edit`} text={editReason} /> : null}
        </>
      )}
    </li>
  );
};

const OrdersSection: React.FC<SectionProps & { sel: Selection; orders: BranchOrdersDto }> = (props) => {
  const { sel, orders, options, mayEdit, editReason, busy, run } = props;
  const [form, setForm] = useState<OrderForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const totalApproved = orders.orders.reduce((s, o) => s + (o.approved?.order_amount_tax_ex ?? 0), 0);
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
  return (
    <section className="card" aria-labelledby="rev-orders-title">
      <div className="section-header">
        <div style={{ minWidth: 0 }}>
          <h2 id="rev-orders-title" className="section-title">
            🧾 外注発注（下請注文書）
          </h2>
          <p className="section-subtitle">承認済み発注額の合計（税抜）：{formatYen(totalApproved)}　※案は承認するまで発注確定額・出来高登録に反映されません。</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!mayEdit || busy || options.subcontractors.length === 0}
          aria-describedby={mayEdit ? undefined : "rev-order-new-reason"}
          onClick={() => setForm(form ? null : blank())}
        >
          ＋ 新規発注案
        </button>
      </div>
      {editReason ? <Reason id="rev-order-new-reason" text={editReason} /> : null}
      {form ? (
        <div className="rev-new-order">
          <OrderFormView form={form} setForm={setForm} options={options} isNew fixedParties={false} />
          {formError ? <div className="alert-banner alert-danger">{formError}</div> : null}
          <div className="rev-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                const f = orderFieldsFrom(form);
                if (typeof f === "string") {
                  setFormError(f);
                  return;
                }
                setFormError(null);
                const ok = await run("新規発注案を作成", () =>
                  revisionsApi.createOrder({ ...f, order_number: form.order_number.trim() || null, project_code: sel.project, branch_code: sel.branch })
                );
                if (ok) setForm(null);
              }}
            >
              💾 発注案を作成
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setForm(null)}>
              やめる
            </button>
          </div>
        </div>
      ) : null}
      {orders.orders.length === 0 ? (
        <p className="rev-muted">この枝番の外注発注はありません。</p>
      ) : (
        <ul className="rev-list">
          {orders.orders.map((o) => (
            <OrderCard key={o.order_number} {...props} entry={o} />
          ))}
        </ul>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// 操作履歴
// ---------------------------------------------------------------------------

const EventsSection: React.FC<{ events: RevisionEventDto[] }> = ({ events }) => (
  <section className="card" aria-labelledby="rev-events-title">
    <div className="section-header">
      <h2 id="rev-events-title" className="section-title">
        🕘 操作履歴（この枝番）
      </h2>
    </div>
    {events.length === 0 ? (
      <p className="rev-muted">操作履歴はまだありません。</p>
    ) : (
      <ul className="rev-list">
        {events.map((e) => (
          <li key={e.event_no} className="rev-row">
            <div className="rev-row-main">
              <strong>{eventLabel(e)}</strong>
              {e.order_number ? ` ${e.order_number}` : ""}
              {e.history_no !== null ? `（履歴 ${e.history_no}）` : ""}
              <div className="rev-muted">
                {new Date(e.occurred_at).toLocaleString("ja-JP")} ／ {e.actor_user_id}（{e.actor_role}）
                {e.amount_before !== null || e.amount_after !== null
                  ? ` ／ ${e.amount_before === null ? "—" : formatYen(e.amount_before)} → ${e.amount_after === null ? "—" : formatYen(e.amount_after)}`
                  : ""}
              </div>
              {e.reason ? <div>{e.action === "reject" ? "否認理由" : "コメント"}：{e.reason}</div> : null}
            </div>
          </li>
        ))}
      </ul>
    )}
  </section>
);

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

function branchFieldsFrom(s: BranchFormState): BranchFieldsInput | string {
  const num = (v: string) => Number(v.replace(/,/g, "").trim());
  const a = num(s.contract_amount);
  const t = num(s.contract_tax);
  const c = num(s.estimated_cost);
  if (![a, t, c].every((x) => Number.isSafeInteger(x) && x >= 0)) return "金額は0以上の整数（円）で入力してください";
  return {
    branch_name: s.branch_name,
    site_manager_code: s.site_manager_code,
    supervising_engineer_code: s.supervising_engineer_code || null,
    chief_engineer_code: null,
    client_partner_code: s.client_partner_code,
    contract_start_date: s.contract_start_date,
    contract_end_date: s.contract_end_date,
    internal_start_date: s.internal_start_date,
    internal_end_date: s.internal_end_date,
    contract_amount_tax_ex: a,
    contract_tax_amount: t,
    estimated_total_cost: c,
  };
}

const BranchFieldsForm: React.FC<{ s: BranchFormState; set: (s: BranchFormState) => void; options: RevisionOptionsDto }> = ({ s, set, options }) => {
  const u = (patch: Partial<BranchFormState>) => set({ ...s, ...patch });
  return (
    <>
      <div className="form-grid form-grid-2">
        <div className="form-field">
          <label className="form-label">枝番名称</label>
          <input className="form-input" maxLength={80} value={s.branch_name} onChange={(e) => u({ branch_name: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">発注者（得意先）</label>
          <select className="form-select" value={s.client_partner_code} onChange={(e) => u({ client_partner_code: e.target.value })}>
            {options.customers.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}：{c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="form-label">現場代理人（社員）</label>
          <select className="form-select" value={s.site_manager_code} onChange={(e) => u({ site_manager_code: e.target.value })}>
            {options.employees.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}：{c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label className="form-label">監理技術者（任意）</label>
          <select className="form-select" value={s.supervising_engineer_code} onChange={(e) => u({ supervising_engineer_code: e.target.value })}>
            <option value="">（未設定）</option>
            {options.employees.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}：{c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-grid form-grid-2">
        {(
          [
            ["contract_start_date", "契約工期（開始）"],
            ["contract_end_date", "契約工期（終了）"],
            ["internal_start_date", "社内工期（開始）"],
            ["internal_end_date", "社内工期（終了）"],
          ] as const
        ).map(([k, label]) => (
          <div className="form-field" key={k}>
            <label className="form-label">{label}</label>
            <input type="date" className="form-input" value={s[k]} onChange={(e) => u({ [k]: e.target.value } as Partial<BranchFormState>)} />
          </div>
        ))}
      </div>
      <div className="form-grid form-grid-3">
        <div className="form-field">
          <label className="form-label">請負金額（税抜・円）</label>
          <input className="form-input" inputMode="numeric" value={s.contract_amount} onChange={(e) => u({ contract_amount: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">請負消費税額（円）</label>
          <input className="form-input" inputMode="numeric" value={s.contract_tax} onChange={(e) => u({ contract_tax: e.target.value })} />
        </div>
        <div className="form-field">
          <label className="form-label">見積総原価（円）</label>
          <input className="form-input" inputMode="numeric" value={s.estimated_cost} onChange={(e) => u({ estimated_cost: e.target.value })} />
        </div>
      </div>
    </>
  );
};

const ProjectForm: React.FC<{
  options: RevisionOptionsDto;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (req: Parameters<typeof revisionsApi.createProject>[0]) => Promise<void>;
}> = ({ options, busy, onCancel, onSubmit }) => {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [doken, setDoken] = useState("2");
  const [branch, setBranch] = useState<BranchFormState>(() => blankBranch(options, "本工事"));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="rev-panel">
      <h3 className="rev-h3">工事の登録（本工事 枝番 000 を同時に作成）</h3>
      <div className="form-grid form-grid-2">
        <div className="form-field">
          <label className="form-label" htmlFor="rev-new-project-code">
            工事コード（英数字と - _、10文字以内）
          </label>
          <input id="rev-new-project-code" className="form-input" maxLength={10} value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="form-field">
          <label className="form-label">土建区分</label>
          <select className="form-select" value={doken} onChange={(e) => setDoken(e.target.value)}>
            <option value="1">1：土木</option>
            <option value="2">2：建築</option>
            <option value="9">9：その他</option>
          </select>
        </div>
        <div className="form-field">
          <label className="form-label">工事名称</label>
          <input className="form-input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-field">
          <label className="form-label">工事略称</label>
          <input className="form-input" maxLength={40} value={short} onChange={(e) => setShort(e.target.value)} />
        </div>
      </div>
      <BranchFieldsForm s={branch} set={setBranch} options={options} />
      {err ? <div className="alert-banner alert-danger">{err}</div> : null}
      <div className="rev-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            const b = branchFieldsFrom(branch);
            if (typeof b === "string") {
              setErr(b);
              return;
            }
            setErr(null);
            void onSubmit({ project_code: code.trim(), project_name: name, project_short_name: short, doken_type: doken, honzatsu_type: "1", kanmin_type1: "2", main_branch: b });
          }}
        >
          💾 工事を登録
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          やめる
        </button>
      </div>
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
  const nextCode = useMemo(() => {
    const used = project.branches.map((b) => Number(b.branch_code)).filter((n) => Number.isInteger(n));
    const n = Math.max(0, ...used) + 1;
    return n <= 999 ? String(n).padStart(3, "0") : "";
  }, [project]);
  const [code, setCode] = useState(nextCode);
  const [branch, setBranch] = useState<BranchFormState>(() => blankBranch(options, "追加工事"));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="rev-panel">
      <h3 className="rev-h3">追加工事の枝番を登録（{project.project_code}）</h3>
      <div className="form-field" style={{ maxWidth: 240 }}>
        <label className="form-label" htmlFor="rev-new-branch-code">
          枝番（001〜999）
        </label>
        <input id="rev-new-branch-code" className="form-input" maxLength={3} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <BranchFieldsForm s={branch} set={setBranch} options={options} />
      {err ? <div className="alert-banner alert-danger">{err}</div> : null}
      <div className="rev-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            const b = branchFieldsFrom(branch);
            if (typeof b === "string") {
              setErr(b);
              return;
            }
            setErr(null);
            void onSubmit({ ...b, branch_code: code.trim() });
          }}
        >
          💾 枝番を登録
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
};
