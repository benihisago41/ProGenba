import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import { Avatar, Badge, Body1, Button, Caption1, Divider, Spinner, Title3, makeStyles, mergeClasses, tokens, useRestoreFocusTarget } from "@fluentui/react-components";
import { Add24Regular, ArrowSync20Regular, Building24Regular, DocumentBulletList24Regular, Grid24Regular, SignOut20Regular } from "@fluentui/react-icons";
import { CockpitView } from "./CockpitView";
import { EasyCostInput, EasyCostInputProps } from "./EasyCostInput";
import { canRegisterCompleted, canRegisterCost, fetchMe, logout, MeResponse, roleLabel, setUnauthorizedHandler, resumeApiSession } from "./auth";
import { LoginView } from "./LoginView";
import { RevisionsView } from "./RevisionsView";
import { ProjectSelection, useProjectData } from "./data";
import { describeFailure } from "./errors";
import { ConfirmDialog, Facts, GuidanceNotice, Notice, SessionSuspendedContext, ThemeButton, usePageStyles } from "./ui";
export type { EasyCostInputProps };

const useStyles = makeStyles({
  root: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: tokens.spacingHorizontalL, minHeight: "68px", paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalXXL, paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS, backgroundColor: tokens.colorNeutralBackground1, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, '@media (max-width: 640px)': { paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL } },
  mark: { display: "flex", alignItems: "center", justifyContent: "center", width: "36px", height: "36px", borderRadius: tokens.borderRadiusLarge, color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorBrandBackground },
  workspace: { display: "flex", flex: 1, minWidth: 0, '@media (max-width: 800px)': { flexDirection: "column" } },
  sidebar: { display: "flex", flexDirection: "column", width: "220px", flexShrink: 0, backgroundColor: tokens.colorNeutralBackground1, borderRight: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalL, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, '@media (max-width: 800px)': { width: "100%", borderRightWidth: 0, paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS } },
  nav: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, '@media (max-width: 800px)': { flexDirection: "row", flexWrap: "wrap" } },
  navButton: { justifyContent: "flex-start", minHeight: "48px", borderRadius: tokens.borderRadiusMedium },
  active: { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2 },
  sidebarFoot: { marginTop: "auto", paddingTop: tokens.spacingVerticalXXXL, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM, '@media (max-width: 800px)': { display: "none" } },
  main: { flex: 1, minWidth: 0, paddingTop: tokens.spacingVerticalXXXL, paddingBottom: tokens.spacingVerticalXXXL, paddingLeft: tokens.spacingHorizontalXXXL, paddingRight: tokens.spacingHorizontalXXXL, '@media (max-width: 640px)': { paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, paddingTop: tokens.spacingVerticalXXL } },
  content: { maxWidth: "1440px", marginLeft: "auto", marginRight: "auto", minWidth: 0 },
  session: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL },
  sessionBox: { maxWidth: "480px", width: "100%" },
  user: { '@media (max-width: 600px)': { display: "none" } },
  skip: { position: "absolute", top: "-100px", left: tokens.spacingHorizontalL, zIndex: 10, backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorBrandForeground1, paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, ':focus': { top: tokens.spacingVerticalS } },
});

export const App: React.FC = () => {
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [replacement, setReplacement] = useState<MeResponse | null>(null);
  const [draftSummary, setDraftSummary] = useState<[string, string][]>([]);
  const [logoutDrafts, setLogoutDrafts] = useState<[string, string][] | null>(null);
  const [logoutAfterDialog, setLogoutAfterDialog] = useState(false);
  const lastSession = useRef<MeResponse | null>(null);
  const fetchSession = useCallback(async () => {
    const current = await fetchMe();
    if (current === null && lastSession.current) {
      setExpired(true);
      setLoginNotice("ログインの有効期限が切れました。入力内容はこの画面のメモリに保持しています。同じ会社・利用者で再ログインしてください。");
      return lastSession.current;
    }
    return current;
  }, []);
  const { data: session, error, mutate, isLoading, isValidating } = useSWR("progenba-session", fetchSession, { shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: true });
  if (session) lastSession.current = session;
  const styles = useStyles(); const p = usePageStyles();
  const acceptLogin = (me: MeResponse) => {
    resumeApiSession(); setExpired(false); setReplacement(null); setLoginNotice(null);
    void mutate(me, false);
  };
  const loggedIn = (me: MeResponse) => {
    if (session && (session.company_code !== me.company_code || session.user_id !== me.user_id || session.role !== me.role)) {
      setReplacement(me);
    } else acceptLogin(me);
  };
  useEffect(() => {
    setUnauthorizedHandler(() => { setExpired(true); setLoginNotice("ログインの有効期限が切れました。入力内容はこの画面のメモリに保持しています。同じ会社・利用者で再ログインしてください。"); });
    return () => setUnauthorizedHandler(null);
  }, [mutate]);
  const handleLogout = useCallback(async () => {
    try { await logout(); setLoginNotice("ログアウトしました。"); }
    catch { setLoginNotice("この端末の入力は破棄しましたが、サーバー側のログアウトを確認できませんでした。通信状況をご確認ください。"); }
    finally { setExpired(false); setReplacement(null); setDraftSummary([]); setLogoutDrafts(null); lastSession.current = null; resumeApiSession(); void mutate(null, false); }
  }, [mutate]);
  if (isLoading) return <main className={styles.session}><Spinner label="ログイン状態を確認しています…" /></main>;
  // サーバーに接続できない場合は再試行だけを案内する（架空データは表示しない）
  if (error && !session) return <main className={styles.session}><div className={mergeClasses(p.compact, styles.sessionBox)}>
    <Notice intent="error" title="サーバーに接続できません">ログイン状態を確認できませんでした。通信状況を確認して、もう一度お試しください。続く場合は管理者にご連絡ください。</Notice>
    <Button appearance="primary" size="large" icon={isValidating ? <Spinner size="tiny" /> : <ArrowSync20Regular />} disabled={isValidating} onClick={() => void mutate()}>再試行</Button>
  </div></main>;
  const logoutDialog = <ConfirmDialog open={logoutDrafts !== null} title="入力を破棄してログアウトしますか？" action="破棄してログアウト" onConfirm={() => { setLogoutDrafts(null); setLogoutAfterDialog(true); }} onCancel={() => setLogoutDrafts(null)} onCloseComplete={() => { if (logoutAfterDialog) { setLogoutAfterDialog(false); void handleLogout(); } }}><Facts items={logoutDrafts ?? []} />この操作では入力途中の内容を破棄します。</ConfirmDialog>;
  return <>
    {session ? <SessionSuspendedContext.Provider value={expired}><div hidden={expired}><SessionWorkspace key={`${session.company_code}:${session.user_id}:${session.role}`} session={session} onLogout={handleLogout} onRequestLogout={setLogoutDrafts} onDraftSummaryChange={setDraftSummary} /></div></SessionSuspendedContext.Provider> : null}
    {!session || expired ? <LoginView notice={loginNotice} onLoggedIn={loggedIn} /> : null}
    {logoutDialog}
    {session ? <ConfirmDialog open={replacement !== null} title="入力を破棄して利用者を切り替えますか？" action="破棄して切り替え" onConfirm={() => { if (replacement) acceptLogin(replacement); }} onCancel={() => { setReplacement(null); void logout().catch(() => undefined); }}>
      <Facts items={[["現在の利用者", `${session.company_code} / ${session.user_id}`], ["切替先", replacement ? `${replacement.company_code} / ${replacement.user_id}（${roleLabel(replacement.role)}）` : ""], ...draftSummary]} />
      保持している入力と取得済みデータを破棄します。戻る場合は同じ会社・利用者で再ログインしてください。
    </ConfirmDialog> : null}
  </>;
};

function SessionWorkspace(props: { session: MeResponse; onLogout: () => Promise<void>; onRequestLogout: (items: [string, string][]) => void; onDraftSummaryChange: (items: [string, string][]) => void }) {
  // 会社・利用者が変わる際、取得データのキャッシュも一緒に破棄する。
  const cache = useMemo(() => new Map(), []);
  return <SWRConfig value={{ provider: () => cache }}><AuthenticatedApp {...props} /></SWRConfig>;
}

type ActiveTab = "cockpit" | "input" | "revisions";

function AuthenticatedApp({ session, onLogout, onRequestLogout, onDraftSummaryChange }: { session: MeResponse; onLogout: () => Promise<void>; onRequestLogout: (items: [string, string][]) => void; onDraftSummaryChange: (items: [string, string][]) => void }) {
  const s = useStyles(); const p = usePageStyles();
  const restoreFocus = useRestoreFocusTarget();
  const { cockpit, lookups, refresh } = useProjectData(session.company_code);
  const projects = cockpit.data ?? [];
  const hadProjects = useRef(false);
  if (projects.length > 0) hadProjects.current = true;
  const [activeTab, setActiveTab] = useState<ActiveTab>("cockpit");
  // 工事・枝番の選択は「工事の状況」「原価を登録」「予算・発注」で1つを共有する
  const [selection, setSelection] = useState<ProjectSelection | null>(null);
  const current = selection ?? { projectCode: projects[0]?.key.project_code ?? "", branchCode: projects[0]?.key.branch_code ?? "000" };
  // 初回の既定選択を確定し、更新による一覧の並び替えで登録先が変わるのを防ぐ。
  useEffect(() => {
    if (!selection && projects[0]) setSelection({ projectCode: projects[0].key.project_code, branchCode: projects[0].key.branch_code });
  }, [selection, projects]);
  // 未保存の入力: 原価の4方式（costDirty）と予算・発注の編集中の案・登録フォーム（revDirty）
  const [costDirty, setCostDirty] = useState(false);
  const [revDirty, setRevDirty] = useState(false);
  const [costSummary, setCostSummary] = useState<[string, string][]>([]);
  const [revSummary, setRevSummary] = useState<[string, string][]>([]);
  useEffect(() => { onDraftSummaryChange([...costSummary, ...revSummary]); }, [costSummary, revSummary, onDraftSummaryChange]);
  const [costBusy, setCostBusy] = useState(false);
  const [revBusy, setRevBusy] = useState(false);
  // 選択の変更判定は同じイベント内の更新も反映するため ref でも持つ（登録直後の選択変更で誤って確認しない）
  const dirtyRef = useRef({ cost: false, rev: false });
  const onCostDirty = useCallback((value: boolean) => { dirtyRef.current.cost = value; setCostDirty(value); }, []);
  const onRevDirty = useCallback((value: boolean) => { dirtyRef.current.rev = value; setRevDirty(value); }, []);
  const dirty = costDirty || revDirty;
  const busy = costBusy || revBusy;
  const [draftVersion, setDraftVersion] = useState(0);
  const [pending, setPending] = useState<ProjectSelection | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const mayRegister = canRegisterCost(session.role);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current.cost && !dirtyRef.current.rev) return;
      event.preventDefault(); event.returnValue = "入力途中の内容が失われます。";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const choose = useCallback((next: ProjectSelection) => {
    if (busy || (next.projectCode === current.projectCode && next.branchCode === current.branchCode)) return;
    if (dirtyRef.current.cost || dirtyRef.current.rev) { setPending(next); return; }
    setSelection(next); setDraftVersion(value => value + 1);
  }, [busy, current.projectCode, current.branchCode]);
  const update = async () => {
    setRefreshing(true); setRefreshNotice(null);
    setReloadKey(value => value + 1);
    const success = await refresh();
    setRefreshFailed(!success);
    setRefreshNotice(success ? "最新の状態に更新しました。入力途中の内容は保持しています。" : "更新できないデータがあります。表示中の内容と入力は保持しています。「更新」で再取得してください。");
    setRefreshing(false);
  };
  const onRevisionsChanged = useCallback(async () => { if (!(await refresh())) throw new Error("工事の状況を更新できませんでした。"); }, [refresh]);
  const confirm = () => {
    // 工事変更では、確認済みの原価入力と予算・発注の案を破棄する。
    if (pending) { onCostDirty(false); setSelection(pending); setDraftVersion(value => value + 1); }
    setPending(null);
  };
  const nav = (tab: ActiveTab, label: string, icon: React.ReactElement, extra?: React.ReactNode, disabled = false) =>
    <Button appearance="subtle" size="large" className={mergeClasses(s.navButton, activeTab === tab && s.active)} icon={icon} disabled={disabled} aria-describedby={disabled ? "role-reason" : undefined} aria-current={activeTab === tab ? "page" : undefined} onClick={() => setActiveTab(tab)}>{label}{extra}</Button>;
  const cockpitFailure = cockpit.error ? describeFailure(cockpit.error, "工事の状況を取得", "") : null;
  return <div className={s.root}>
    <a className={s.skip} href="#main-content">本文へ移動</a>
    <header className={s.header}>
      <div className={p.row}><span className={s.mark}><Building24Regular /></span><Title3 as="span">ProGenba</Title3><Divider vertical /><Body1>工事原価</Body1></div>
      <div className={p.row}><Button size="large" appearance="subtle" icon={refreshing ? <Spinner size="tiny" /> : <ArrowSync20Regular />} disabled={refreshing || busy} onClick={() => void update()}>更新</Button><ThemeButton /><Avatar name={session.display_name ?? session.user_id} size={32} /><div className={mergeClasses(p.compact, s.user)}><Body1>{session.display_name ?? session.user_id}</Body1><Caption1 className={p.muted}>会社 {session.company_code} · {roleLabel(session.role)}権限</Caption1></div><Button {...restoreFocus} size="large" appearance="subtle" icon={<SignOut20Regular />} disabled={busy} onClick={() => { if (dirty) onRequestLogout([["対象の工事", `${current.projectCode} / ${current.branchCode}`], ...costSummary, ...revSummary]); else void onLogout(); }}>ログアウト</Button></div>
    </header>
    <div className={s.workspace}>
      <aside className={s.sidebar}><nav className={s.nav} aria-label="メイン機能">
        {nav("cockpit", "工事の状況", <Grid24Regular />)}
        {nav("input", "原価を登録", <Add24Regular />, costDirty && <> <Badge size="small" appearance="tint" color="informative">入力中</Badge></>, !mayRegister)}
        {nav("revisions", "予算・発注", <DocumentBulletList24Regular />, revDirty && <> <Badge size="small" appearance="tint" color="informative">編集中</Badge></>)}
      </nav><div className={s.sidebarFoot}><div className={p.compact}><Divider /><Caption1 className={p.muted}>現場の記録から、<br />工事の状況を見える化。</Caption1><Caption1 className={p.muted}>ProGenba · 工事原価管理</Caption1></div></div></aside>
      <main id="main-content" tabIndex={-1} className={s.main}><div className={mergeClasses(s.content, p.stack)}>
        {!mayRegister && <Notice><span id="role-reason">閲覧権限で利用しています。原価の登録は、登録・承認権限の利用者にご依頼ください。</span></Notice>}
        {refreshNotice && <Notice intent={refreshFailed ? "warning" : "success"}>{refreshNotice}</Notice>}
        {cockpitFailure && activeTab !== "revisions" && <GuidanceNotice guidance={cockpitFailure}><Button size="large" onClick={() => void update()} disabled={refreshing}>再試行</Button></GuidanceNotice>}
        {activeTab !== "revisions" && (!cockpit.data && cockpit.isLoading ? <Spinner label="工事の状況を読み込んでいます…" /> : cockpit.data && projects.length === 0 ? <Notice>登録されている工事がありません。工事の登録は「予算・発注」から承認権限の利用者が行えます。</Notice> : null)}
        {/* 3画面とも表示を切り替えるだけで作り直さない（入力途中の内容とスクロール以外の状態を保持する） */}
        {cockpit.data && hadProjects.current && <>
          <section hidden={activeTab !== "cockpit"} aria-label="工事の状況"><CockpitView allowCompleted={canRegisterCompleted(session.role)} projects={projects} selection={current} onSelect={choose} onRegister={mayRegister ? () => setActiveTab("input") : undefined} /></section>
          {mayRegister && <section hidden={activeTab !== "input"} aria-label="原価を登録"><EasyCostInput key={draftVersion} projects={projects} selection={current} onSelect={choose} companyCode={session.company_code} lookups={lookups.data ?? null} lookupsLoading={lookups.isLoading} lookupsError={lookups.error ?? null} onRetryLookups={async () => { try { await lookups.mutate(); } catch { /* エラーはSWRの状態から表示する */ } }} onRegistered={refresh} canRegisterCompleted={canRegisterCompleted(session.role)} onDirtyChange={onCostDirty} onDraftSummaryChange={setCostSummary} onBusyChange={setCostBusy} onShowCockpit={() => setActiveTab("cockpit")} /></section>}
        </>}
        {/* 予算・発注は閲覧権限以上で表示。工事が0件・工事の状況の取得失敗でも工事を登録できるよう、コックピットの状態に依存しない */}
        <section hidden={activeTab !== "revisions"} aria-label="予算・発注"><RevisionsView session={session} selection={current} onSelect={choose} onDataChanged={onRevisionsChanged} onDirtyChange={onRevDirty} onDraftSummaryChange={setRevSummary} onBusyChange={setRevBusy} reloadKey={reloadKey} /></section>
      </div></main>
    </div>
    <ConfirmDialog open={pending !== null} title="入力を破棄して工事を変更しますか？" action="破棄して変更" onCancel={() => setPending(null)} onConfirm={confirm}><Facts items={[["現在の工事", `${current.projectCode} / ${current.branchCode}`], ...costSummary, ...revSummary]} />画面を切り替えるだけなら入力は保持されますが、この操作では入力途中の内容を破棄します。</ConfirmDialog>
  </div>;
}
export default App;
