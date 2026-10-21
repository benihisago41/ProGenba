import React, { useCallback, useEffect, useState } from "react";
import {
  API_ENDPOINTS,
  ErrorResponse,
  LookupsDto,
  ProjectCostCockpitDto,
} from "./bindings";
import { CockpitView } from "./CockpitView";
import { EasyCostInput, EasyCostInputProps } from "./EasyCostInput";
import {
  apiFetch,
  canRegisterCompleted,
  canRegisterCost,
  fetchMe,
  logout,
  MeResponse,
  roleLabel,
  setUnauthorizedHandler,
} from "./auth";
import { LoginView } from "./LoginView";

type ActiveTab = "cockpit" | "easy-input";

export type { EasyCostInputProps };

async function parseApiError(res: Response): Promise<string> {
  try {
    const err = (await res.json()) as Partial<ErrorResponse>;
    if (err && typeof err.message === "string" && err.message.trim() !== "") {
      return err.message;
    }
  } catch {
    // ignore JSON parse failure
  }
  return `サーバー通信エラーが発生しました（HTTP ${res.status}）`;
}

// セッション確認中は undefined、未ログインは null
type SessionState = MeResponse | null | undefined;

export const App: React.FC = () => {
  const [session, setSession] = useState<SessionState>(undefined);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);

  useEffect(() => {
    // 業務APIが 401 を返したらログイン画面へ戻す
    setUnauthorizedHandler(() => {
      setLoginNotice("ログインの有効期限が切れました。再度ログインしてください。");
      setSession(null);
    });
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setSession(me);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 通信失敗時も画面はログイン画面へ戻す（サーバー側は無操作8時間で失効）
    } finally {
      setLoginNotice("ログアウトしました。");
      setSession(null);
    }
  }, []);

  if (session === undefined) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <section className="card state-box" aria-live="polite">
            <p style={{ margin: 0 }}>ログイン状態を確認しています...</p>
          </section>
        </main>
      </div>
    );
  }

  if (session === null) {
    return (
      <LoginView
        notice={loginNotice}
        onLoggedIn={(me) => {
          setLoginNotice(null);
          setSession(me);
        }}
      />
    );
  }

  // 利用者が変わったら画面状態を作り直す
  return (
    <AuthenticatedApp
      key={`${session.company_code}:${session.user_id}`}
      session={session}
      onLogout={handleLogout}
    />
  );
};

interface AuthenticatedAppProps {
  session: MeResponse;
  onLogout: () => Promise<void>;
}

const AuthenticatedApp: React.FC<AuthenticatedAppProps> = ({ session, onLogout }) => {
  // 会社コードはサーバーのセッション（/auth/me）から取得した値のみを使う
  const companyCode = session.company_code;
  const mayRegister = canRegisterCost(session.role);
  const [activeTab, setActiveTab] = useState<ActiveTab>("cockpit");

  const [projects, setProjects] = useState<ProjectCostCockpitDto[]>([]);
  const [, setLookups] = useState<LookupsDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchCockpitAndLookups = useCallback(
    async (background = false) => {
      if (!background) {
        setIsLoading(true);
        setErrorMessage(null);
      }
      try {
        const query = `?company_code=${encodeURIComponent(companyCode)}`;
        const [cockpitRes, lookupsRes] = await Promise.all([
          apiFetch(`${API_ENDPOINTS.COCKPIT}${query}`, {
            headers: { Accept: "application/json" },
          }),
          apiFetch(`${API_ENDPOINTS.MASTER_LOOKUPS}${query}`, {
            headers: { Accept: "application/json" },
          }),
        ]);

        if (!cockpitRes.ok) {
          const msg = await parseApiError(cockpitRes);
          throw new Error(msg);
        }

        const cockpitData = (await cockpitRes.json()) as ProjectCostCockpitDto[];
        setProjects(Array.isArray(cockpitData) ? cockpitData : []);

        if (lookupsRes.ok) {
          const lookupsData = (await lookupsRes.json()) as LookupsDto;
          setLookups(lookupsData);
        }
      } catch (err) {
        if (!background) {
          const msg =
            err instanceof Error
              ? err.message
              : "工事原価データの取得中に予期しないエラーが発生しました。";
          setErrorMessage(msg);
        }
      } finally {
        if (!background) {
          setIsLoading(false);
        }
      }
    },
    [companyCode]
  );

  useEffect(() => {
    void fetchCockpitAndLookups(false);
  }, [fetchCockpitAndLookups]);

  const handleRegistered = useCallback(async () => {
    await fetchCockpitAndLookups(true);
  }, [fetchCockpitAndLookups]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand-group">
            <span className="brand-badge">SIRIUS REBORN</span>
            <div>
              <h1 className="brand-title">工事原価コックピット</h1>
              <p className="brand-subtitle">
                本工事・追加工事の予算・実発生原価・見込粗利リアルタイム可視化
              </p>
            </div>
          </div>

          <nav className="nav-tabs" aria-label="メイン機能切り替え">
            <button
              type="button"
              className={`nav-tab-btn ${activeTab === "cockpit" ? "active" : ""}`}
              aria-current={activeTab === "cockpit" ? "page" : undefined}
              onClick={() => setActiveTab("cockpit")}
            >
              📊 工事原価コックピット
            </button>
            <button
              type="button"
              className={`nav-tab-btn ${
                activeTab === "easy-input" ? "active" : ""
              }`}
              aria-current={activeTab === "easy-input" ? "page" : undefined}
              onClick={() => setActiveTab("easy-input")}
              disabled={!mayRegister}
              aria-describedby={mayRegister ? undefined : "register-disabled-reason"}
              title={mayRegister ? undefined : "閲覧権限のため原価登録はできません"}
            >
              ➕ かんたん原価登録（外注出来高・材料・日報・損料）
            </button>
            <button
              type="button"
              className="nav-tab-btn"
              onClick={() => {
                void fetchCockpitAndLookups();
              }}
              disabled={isLoading}
              aria-label="最新の原価データを再取得"
            >
              🔄 最新状態に更新
            </button>
          </nav>

          <div
            className="user-bar"
            aria-label="ログイン中の利用者"
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
              fontSize: "0.85rem",
              minWidth: 0,
            }}
          >
            <span style={{ overflowWrap: "anywhere" }}>
              👤 {session.display_name ?? session.user_id}（会社 {session.company_code}）
            </span>
            <span className="kpi-tag" data-role={session.role}>
              役割：{roleLabel(session.role)}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: "4px 12px" }}
              onClick={() => {
                void onLogout();
              }}
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {!mayRegister ? (
        <p
          id="register-disabled-reason"
          className="alert-banner alert-warning"
          role="note"
          style={{ margin: "12px auto 0", maxWidth: "1360px", width: "calc(100% - 32px)" }}
        >
          閲覧権限のため、原価登録はできません（登録・承認権限の利用者のみ登録できます）。
        </p>
      ) : null}

      <main className="app-main">
        {isLoading ? (
          <section className="card state-box" aria-live="polite">
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "1.05rem",
                fontWeight: 700,
                color: "var(--text-heading)",
              }}
            >
              工事原価データを読み込んでいます...
            </p>
            <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-muted)" }}>
              最新の実行予算・発注コミット額・実発生原価を集計しています
            </p>
          </section>
        ) : errorMessage ? (
          <section className="card state-box" role="alert">
            <div
              className="alert-banner alert-danger"
              style={{ justifyContent: "center", marginBottom: "16px" }}
            >
              <span>⚠️ データの取得に失敗しました：{errorMessage}</span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                void fetchCockpitAndLookups();
              }}
            >
              🔄 再試行する
            </button>
          </section>
        ) : projects.length === 0 ? (
          <section className="card state-box">
            <p
              style={{
                margin: "0 0 12px",
                fontSize: "1.05rem",
                fontWeight: 700,
                color: "var(--text-heading)",
              }}
            >
              登録されている工事データがありません
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void fetchCockpitAndLookups();
              }}
            >
              🔄 再読み込み
            </button>
          </section>
        ) : activeTab === "cockpit" || !mayRegister ? (
          <CockpitView projects={projects} />
        ) : (
          <>
            {!canRegisterCompleted(session.role) ? (
              <div
                className="alert-banner alert-warning"
                role="note"
                style={{ marginBottom: "12px" }}
              >
                <span>
                  完成区分が「完成(1)」の工事への登録は承認権限の利用者のみ可能です（登録しようとするとサーバーで拒否されます）。
                </span>
              </div>
            ) : null}
            <EasyCostInput
              projects={projects}
              companyCode={companyCode}
              onRegistered={handleRegistered}
            />
          </>
        )}
      </main>
    </div>
  );
};

export default App;
