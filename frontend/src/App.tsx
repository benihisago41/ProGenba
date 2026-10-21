import React, { useCallback, useEffect, useMemo, useState } from "react";
import useSWR, { SWRConfig } from "swr";
import { Avatar, Badge, Body1, Button, Caption1, Divider, Spinner, Title3, makeStyles, mergeClasses, tokens, useRestoreFocusTarget } from "@fluentui/react-components";
import { Add24Regular, ArrowSync20Regular, Building24Regular, Grid24Regular, SignOut20Regular } from "@fluentui/react-icons";
import { CockpitView } from "./CockpitView";
import { EasyCostInput, EasyCostInputProps } from "./EasyCostInput";
import { canRegisterCompleted, canRegisterCost, fetchMe, logout, MeResponse, roleLabel, setUnauthorizedHandler } from "./auth";
import { LoginView } from "./LoginView";
import { ProjectSelection, useProjectData } from "./data";
import { ConfirmDialog, Notice, ThemeButton, usePageStyles } from "./ui";
export type { EasyCostInputProps };

const useStyles = makeStyles({
  root: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: tokens.spacingHorizontalL, minHeight: "68px", paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalXXL, paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS, backgroundColor: tokens.colorNeutralBackground1, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
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
  user: { '@media (max-width: 600px)': { display: "none" } },
  skip: { position: "absolute", top: "-100px", left: tokens.spacingHorizontalL, zIndex: 10, backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorBrandForeground1, paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, ':focus': { top: tokens.spacingVerticalS } },
});

export const App: React.FC = () => {
  const { data: session, error, mutate, isLoading } = useSWR("progenba-session", fetchMe, { shouldRetryOnError: false, revalidateOnFocus: false });
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const styles = useStyles(); const p = usePageStyles();
  useEffect(() => {
    setUnauthorizedHandler(() => { setLoginNotice("ログインの有効期限が切れました。再度ログインしてください。入力途中の内容は安全のため破棄しました。"); void mutate(null, false); });
    return () => setUnauthorizedHandler(null);
  }, [mutate]);
  const handleLogout = useCallback(async () => {
    try { await logout(); setLoginNotice("ログアウトしました。"); }
    catch { setLoginNotice("この端末の入力は破棄しましたが、サーバー側のログアウトを確認できませんでした。通信状況をご確認ください。"); }
    finally { void mutate(null, false); }
  }, [mutate]);
  if (isLoading) return <main className={styles.session}><Spinner label="ログイン状態を確認しています…" /></main>;
  if (error) return <main className={styles.session}><div className={p.compact}><Notice intent="error">ログイン状態を確認できませんでした。通信状況をご確認ください。</Notice><Button size="large" onClick={() => void mutate()}>もう一度確認する</Button></div></main>;
  if (!session) return <LoginView notice={loginNotice} onLoggedIn={me => { setLoginNotice(null); void mutate(me, false); }} />;
  return <SessionWorkspace key={`${session.company_code}:${session.user_id}`} session={session} onLogout={handleLogout} />;
};

function SessionWorkspace(props: { session: MeResponse; onLogout: () => Promise<void> }) {
  // 会社・利用者が変わる際、取得データのキャッシュも一緒に破棄する。
  const cache = useMemo(() => new Map(), []);
  return <SWRConfig value={{ provider: () => cache }}><AuthenticatedApp {...props} /></SWRConfig>;
}

function AuthenticatedApp({ session, onLogout }: { session: MeResponse; onLogout: () => Promise<void> }) {
  const s = useStyles(); const p = usePageStyles();
  const restoreFocus = useRestoreFocusTarget();
  const { cockpit, lookups, refresh } = useProjectData(session.company_code);
  const projects = cockpit.data ?? [];
  const [activeTab, setActiveTab] = useState<"cockpit" | "input">("cockpit");
  const [selection, setSelection] = useState<ProjectSelection | null>(null);
  const current = selection ?? { projectCode: projects[0]?.key.project_code ?? "", branchCode: projects[0]?.key.branch_code ?? "000" };
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [pending, setPending] = useState<ProjectSelection | "logout" | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const mayRegister = canRegisterCost(session.role);
  useEffect(() => {
    if (!dirty && !busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);
  const choose = (next: ProjectSelection) => {
    if (busy || (next.projectCode === current.projectCode && next.branchCode === current.branchCode)) return;
    if (dirty) { setPending(next); return; }
    setSelection(next); setDraftVersion(value => value + 1);
  };
  const update = async () => {
    setRefreshing(true); setRefreshNotice(null);
    const success = await refresh();
    setRefreshFailed(!success);
    setRefreshNotice(success ? "最新の状態に更新しました。入力途中の内容は保持しています。" : "更新できないデータがあります。表示中の内容と入力は保持しています。「更新」で再取得してください。");
    setRefreshing(false);
  };
  const confirm = () => {
    if (pending === "logout") { setDirty(false); void onLogout(); }
    else if (pending) { setDirty(false); setSelection(pending); setDraftVersion(value => value + 1); }
    setPending(null);
  };
  return <div className={s.root}>
    <a className={s.skip} href="#main-content">本文へ移動</a>
    <header className={s.header}>
      <div className={p.row}><span className={s.mark}><Building24Regular /></span><Title3 as="span">ProGenba</Title3><Divider vertical /><Body1>工事原価</Body1></div>
      <div className={p.row}><Button size="large" appearance="subtle" icon={refreshing ? <Spinner size="tiny" /> : <ArrowSync20Regular />} disabled={refreshing || busy} onClick={() => void update()}>更新</Button><ThemeButton /><Avatar name={session.display_name ?? session.user_id} size={32} /><div className={mergeClasses(p.compact, s.user)}><Body1>{session.display_name ?? session.user_id}</Body1><Caption1 className={p.muted}>会社 {session.company_code} · {roleLabel(session.role)}権限</Caption1></div><Button {...restoreFocus} size="large" appearance="subtle" icon={<SignOut20Regular />} disabled={busy} onClick={() => { if (dirty) setPending("logout"); else void onLogout(); }}>ログアウト</Button></div>
    </header>
    <div className={s.workspace}>
      <aside className={s.sidebar}><nav className={s.nav} aria-label="メイン機能">
        <Button appearance="subtle" size="large" className={mergeClasses(s.navButton, activeTab === "cockpit" && s.active)} icon={<Grid24Regular />} aria-current={activeTab === "cockpit" ? "page" : undefined} onClick={() => setActiveTab("cockpit")}>工事の状況</Button>
        <Button appearance="subtle" size="large" className={mergeClasses(s.navButton, activeTab === "input" && s.active)} icon={<Add24Regular />} disabled={!mayRegister} aria-describedby={!mayRegister ? "role-reason" : undefined} aria-current={activeTab === "input" ? "page" : undefined} onClick={() => setActiveTab("input")}>原価を登録 {dirty && <Badge size="small" appearance="tint" color="informative">入力中</Badge>}</Button>
      </nav><div className={s.sidebarFoot}><div className={p.compact}><Divider /><Caption1 className={p.muted}>現場の記録から、<br />工事の状況を見える化。</Caption1><Caption1 className={p.muted}>ProGenba · 工事原価管理</Caption1></div></div></aside>
      <main id="main-content" tabIndex={-1} className={s.main}><div className={mergeClasses(s.content, p.stack)}>
        {!mayRegister && <Notice><span id="role-reason">閲覧権限で利用しています。原価の登録は、登録・承認権限の利用者にご依頼ください。</span></Notice>}
        {refreshNotice && <Notice intent={refreshFailed ? "warning" : "success"}>{refreshNotice}</Notice>}
        {cockpit.error && <Notice intent="error">工事の状況を取得できませんでした：{cockpit.error.message} <Button size="large" onClick={() => void update()} disabled={refreshing}>再試行</Button></Notice>}
        {!cockpit.data && cockpit.isLoading ? <Spinner label="工事の状況を読み込んでいます…" /> : cockpit.data && projects.length === 0 ? <Notice>登録されている工事がありません。対象工事を管理者にご確認ください。</Notice> : cockpit.data ? <>
          <section hidden={activeTab !== "cockpit"} aria-label="工事の状況"><CockpitView projects={projects} selection={current} onSelect={choose} onRegister={mayRegister ? () => setActiveTab("input") : undefined} /></section>
          {mayRegister && <section hidden={activeTab !== "input"} aria-label="原価を登録"><EasyCostInput key={draftVersion} projects={projects} selection={current} onSelect={choose} companyCode={session.company_code} lookups={lookups.data ?? null} lookupsLoading={lookups.isLoading} lookupsError={lookups.error?.message ?? null} onRetryLookups={async () => { try { await lookups.mutate(); } catch { /* エラーはSWRの状態から表示する */ } }} onRegistered={refresh} canRegisterCompleted={canRegisterCompleted(session.role)} onDirtyChange={setDirty} onBusyChange={setBusy} onShowCockpit={() => setActiveTab("cockpit")} /></section>}
        </> : null}
      </div></main>
    </div>
    <ConfirmDialog open={pending !== null} title={pending === "logout" ? "入力を破棄してログアウトしますか？" : "入力を破棄して工事を変更しますか？"} action={pending === "logout" ? "破棄してログアウト" : "破棄して変更"} onCancel={() => setPending(null)} onConfirm={confirm}>まだ登録していない入力があります。画面を切り替えるだけなら入力は保持されますが、この操作では入力途中の内容を破棄します。</ConfirmDialog>
  </div>;
}
export default App;
