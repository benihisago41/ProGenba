import React, { useState } from "react";
import { login, MeResponse } from "./auth";

export interface LoginViewProps {
  onLoggedIn: (me: MeResponse) => void;
  /** セッション切れ等でログイン画面へ戻ったときの案内 */
  notice?: string | null;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoggedIn, notice }) => {
  const [companyCode, setCompanyCode] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);
    if (!/^[0-9A-Za-z]{4}$/.test(companyCode.trim())) {
      setError("会社コードは4文字の英数字で入力してください。");
      return;
    }
    if (userId.trim() === "" || password === "") {
      setError("利用者IDとパスワードを入力してください。");
      return;
    }
    setIsSubmitting(true);
    try {
      const me = await login({
        company_code: companyCode.trim(),
        user_id: userId.trim(),
        password,
      });
      setPassword("");
      onLoggedIn(me);
    } catch (err) {
      setPassword("");
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand-group">
            <span className="brand-badge">SIRIUS REBORN</span>
            <div>
              <h1 className="brand-title">工事原価コックピット</h1>
              <p className="brand-subtitle">ログインしてください</p>
            </div>
          </div>
        </div>
      </header>
      <main className="app-main">
        <section
          className="card"
          aria-labelledby="login-heading"
          style={{ maxWidth: "420px", width: "100%", margin: "24px auto", padding: "20px 16px" }}
        >
          <h2
            id="login-heading"
            style={{ margin: "0 0 16px", fontSize: "1.15rem", color: "var(--text-heading)" }}
          >
            ログイン
          </h2>
          {notice ? (
            <div className="alert-banner alert-warning" role="status" style={{ marginBottom: "12px" }}>
              <span>{notice}</span>
            </div>
          ) : null}
          {error ? (
            <div className="alert-banner alert-danger" role="alert" style={{ marginBottom: "12px" }}>
              <span>{error}</span>
            </div>
          ) : null}
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>
            <div className="form-field" style={{ marginBottom: "12px" }}>
              <label htmlFor="login-company" className="form-label">
                会社コード（4桁）
              </label>
              <input
                id="login-company"
                className="form-input"
                type="text"
                inputMode="text"
                autoComplete="organization"
                maxLength={4}
                value={companyCode}
                onChange={(e) => setCompanyCode(e.target.value)}
                style={{ width: "100%" }}
                required
              />
            </div>
            <div className="form-field" style={{ marginBottom: "12px" }}>
              <label htmlFor="login-user" className="form-label">
                利用者ID
              </label>
              <input
                id="login-user"
                className="form-input"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={32}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                style={{ width: "100%" }}
                required
              />
            </div>
            <div className="form-field" style={{ marginBottom: "16px" }}>
              <label htmlFor="login-password" className="form-label">
                パスワード
              </label>
              <input
                id="login-password"
                className="form-input"
                type="password"
                autoComplete="current-password"
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: "100%" }}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
              style={{ width: "100%" }}
            >
              {isSubmitting ? "確認しています..." : "ログイン"}
            </button>
          </form>
          <p style={{ margin: "16px 0 0", fontSize: "0.82rem", color: "var(--text-muted)" }}>
            利用者の追加・パスワード再設定は管理者が行います。連続して失敗すると一時的にログインできなくなります。
          </p>
        </section>
      </main>
    </div>
  );
};

export default LoginView;
