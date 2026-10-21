import React, { useEffect, useRef, useState } from "react";
import { Badge, Body1, Button, Card, Divider, Field, Input, Spinner, Title1, Title3, makeStyles, tokens } from "@fluentui/react-components";
import { Building24Regular, ArrowRight20Regular } from "@fluentui/react-icons";
import { login, MeResponse } from "./auth";
import { Notice, ThemeButton, usePageStyles } from "./ui";

export interface LoginViewProps { onLoggedIn: (me: MeResponse) => void; notice?: string | null }
const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL, paddingLeft: tokens.spacingHorizontalXXL, paddingRight: tokens.spacingHorizontalXXL, backgroundColor: tokens.colorNeutralBackground1, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
  main: { flex: 1, display: "flex", justifyContent: "center", alignItems: "center", paddingTop: tokens.spacingVerticalXXXL, paddingBottom: tokens.spacingVerticalXXXL, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL },
  layout: { width: "100%", maxWidth: "960px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.spacingHorizontalXXXL, alignItems: "center", '@media (max-width: 760px)': { gridTemplateColumns: "minmax(0, 1fr)", maxWidth: "460px" } },
  intro: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXXL },
  mark: { display: "flex", alignItems: "center", justifyContent: "center", width: "44px", height: "44px", backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, borderRadius: tokens.borderRadiusLarge },
  footer: { textAlign: "center", color: tokens.colorNeutralForeground3, paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL },
});

export const LoginView: React.FC<LoginViewProps> = ({ onLoggedIn, notice }) => {
  const s = useStyles(); const p = usePageStyles();
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const restore = () => {
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) root.removeAttribute("aria-hidden");
    };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(root, { attributes: true, attributeFilter: ["aria-hidden"] });
    return () => observer.disconnect();
  }, []);
  const [companyCode, setCompanyCode] = useState("");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null); const busy = useRef(false);
  const errors = { company: /^[0-9A-Za-z]{4}$/.test(companyCode.trim()) ? "" : "4文字の英数字を入力してください。", user: userId.trim() ? "" : "利用者IDを入力してください。", password: password ? "" : "パスワードを入力してください。" };
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy.current) return;
    setAttempted(true); setError(null);
    if (Object.values(errors).some(Boolean)) { requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()); return; }
    busy.current = true; setIsSubmitting(true);
    try { const me = await login({ company_code: companyCode.trim(), user_id: userId.trim(), password }); setPassword(""); onLoggedIn(me); }
    catch (err) { setPassword(""); setError(err instanceof Error ? err.message : "ログインできませんでした。通信状況をご確認ください。"); }
    finally { busy.current = false; setIsSubmitting(false); }
  };
  return <div className={s.page}>
    <header className={s.header}><div className={p.row}><span className={s.mark}><Building24Regular /></span><Title3>ProGenba</Title3><Badge appearance="tint" color="informative">工事原価</Badge></div><ThemeButton /></header>
    <main className={s.main}><div className={s.layout}>
      <section className={s.intro} aria-labelledby="welcome-heading"><Badge appearance="outline" color="brand">現場の記録を、もっとシンプルに。</Badge><Title1 as="h1" id="welcome-heading">工事のいまが、<br />ひと目でわかる。</Title1><Body1 className={p.muted}>予算と原価の確認から、日々の記録まで。<br />いつもの工事を選んで、はじめましょう。</Body1><Divider /><div className={p.compact}><Body1>工事ごとの予算・原価・見込粗利を確認</Body1><Body1>出来高・材料・日報・資機材をかんたん登録</Body1></div></section>
      <Card className={p.card}><div className={p.stack}><div className={p.compact}><Title3 as="h2">ログイン</Title3><Body1 className={p.muted}>管理者から案内された情報を入力してください。</Body1></div>
        {notice && <Notice>{notice}</Notice>}{error && <Notice intent="error">{error}</Notice>}
        <form ref={formRef} className={p.stack} onSubmit={event => void handleSubmit(event)} noValidate aria-busy={isSubmitting}>
          <Field label="会社コード" required hint="4文字の英数字（例：0000）" validationMessage={attempted ? errors.company : undefined} validationState={attempted && errors.company ? "error" : "none"}><Input id="login-company" size="large" className={p.control} autoComplete="organization" autoCapitalize="none" spellCheck={false} maxLength={4} value={companyCode} onChange={(_, data) => setCompanyCode(data.value)} disabled={isSubmitting} /></Field>
          <Field label="利用者ID" required validationMessage={attempted ? errors.user : undefined} validationState={attempted && errors.user ? "error" : "none"}><Input id="login-user" size="large" className={p.control} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} value={userId} onChange={(_, data) => setUserId(data.value)} disabled={isSubmitting} /></Field>
          <Field label="パスワード" required validationMessage={attempted ? errors.password : undefined} validationState={attempted && errors.password ? "error" : "none"}><Input id="login-password" size="large" className={p.control} type="password" autoComplete="current-password" maxLength={256} value={password} onChange={(_, data) => setPassword(data.value)} disabled={isSubmitting} /></Field>
          <Button size="large" appearance="primary" className={p.control} type="submit" disabled={isSubmitting} icon={isSubmitting ? <Spinner size="tiny" /> : <ArrowRight20Regular />} iconPosition="after">{isSubmitting ? "確認しています…" : "ログイン"}</Button>
        </form><Body1 className={p.muted}>ID・パスワードがわからない場合は、社内の管理者にご確認ください。連続して失敗すると一時的にログインできなくなります。</Body1>
      </div></Card>
    </div></main><footer className={s.footer}><Body1>ProGenba · 工事原価管理</Body1></footer>
  </div>;
};
export default LoginView;
