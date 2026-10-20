import React, { useCallback, useEffect, useState } from "react";
import {
  API_ENDPOINTS,
  ErrorResponse,
  LookupsDto,
  ProjectCostCockpitDto,
} from "./bindings";
import { CockpitView } from "./CockpitView";

type ActiveTab = "cockpit" | "easy-input";

export interface EasyCostInputProps {
  projects: ProjectCostCockpitDto[];
  companyCode: string;
  onRegistered: () => Promise<void>;
}

const DEFAULT_COMPANY_CODE = "0000";

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

export const App: React.FC = () => {
  const [companyCode] = useState<string>(DEFAULT_COMPANY_CODE);
  const [activeTab, setActiveTab] = useState<ActiveTab>("cockpit");

  const [projects, setProjects] = useState<ProjectCostCockpitDto[]>([]);
  const [, setLookups] = useState<LookupsDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchCockpitAndLookups = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const query = `?company_code=${encodeURIComponent(companyCode)}`;
      const [cockpitRes, lookupsRes] = await Promise.all([
        fetch(`${API_ENDPOINTS.COCKPIT}${query}`, {
          headers: { Accept: "application/json" },
        }),
        fetch(`${API_ENDPOINTS.MASTER_LOOKUPS}${query}`, {
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
      const msg =
        err instanceof Error
          ? err.message
          : "工事原価データの取得中に予期しないエラーが発生しました。";
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  }, [companyCode]);

  useEffect(() => {
    void fetchCockpitAndLookups();
  }, [fetchCockpitAndLookups]);

  const handleRegistered = useCallback(async () => {
    await fetchCockpitAndLookups();
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
        </div>
      </header>

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
        ) : activeTab === "cockpit" ? (
          <CockpitView projects={projects} />
        ) : (
          <section
            className="card"
            aria-label="かんたん原価登録（外注出来高・材料・日報・損料）"
          >
            <div className="section-header">
              <div>
                <h2 className="section-title">
                  ➕ かんたん原価登録（外注出来高・材料・日報・損料）
                </h2>
                <p className="section-subtitle">
                  現場で発生した外注出来高・材料購入・作業日報（出面）・機材損料をかんたんに登録できます（対象工事数:{" "}
                  {projects.length} 件）
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    void handleRegistered();
                  }}
                >
                  🔄 原価データを再取得
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setActiveTab("cockpit")}
                >
                  📊 工事原価コックピットへ戻る
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default App;
