# Session 3: 工事原価コックピットUIの実装 (`CockpitView.tsx`, `App.tsx`)

あなたは建設原価管理システム「Project Sirius Reborn」のフロントエンド担当エンジニアです。
Read-Onlyで提供された `CONVENTIONS.md` および `frontend/src/bindings.ts` に100%従い、`frontend/index.html`, `frontend/vite.config.ts`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/CockpitView.tsx` を実装してください。

## 厳守ルール
1. `frontend/src/bindings.ts` はロック済アンカーです。変更しないでください。
2. 画面上に「借方」「貸方」「勘定科目」「未成工事支出金」「仕訳」といった経理用語を一切表示しないでください。
3. 会計ソフトのfreeeのように、建築・土木の現場監督や経営者がパッと見て「今この工事でいくら原価が発生していて、予算に対して安全か危険か」が直感的にわかるモダンで軽快なUIにしてください。

## 実装内容

### 1. `frontend/vite.config.ts` & `frontend/index.html` & `frontend/src/main.tsx`
- 開発時に `/api` を `http://localhost:8080` へプロキシするVite設定と、クリーンで視認性の高い日本語ゴシックフォント・CSSスタイルを定義してください。

### 2. `frontend/src/CockpitView.tsx`（リアルタイム工事原価コックピット）
`API_ENDPOINTS.COCKPIT` から取得した `ProjectCostCockpitDto[]` を受け取り、以下を表示します：
- **工事・枝番セレクター**:
  - 「本工事（`000`）」「追加工事（`001`〜）」をワンクリックで切り替えられるタブ、および「全枝番合算（工事全体）」ビューの切り替え。
- **アラートバナー（スマートガードレール）**:
  - `is_budget_exceeded === true` の場合：「⚠️ 予算超過アラート：発注額または実発生原価が実行予算を上回っています」を赤色で強調表示。
  - `requires_supervising_engineer_warning === true` の場合：「⚠️ 建設業法アラート：下請発注総額が4,500万円以上ですが監理技術者が未設定です」を表示。
- **5大指標サマリーカード（日本円カンマ区切りフォーマット）**:
  1. **① 請負契約額（税抜）** (`contract_amount_tax_ex`)
  2. **② 実行予算額（上限）** (`execution_budget_amount` / 改定番号 `Rev.${latest_budget_history_no}`)
  3. **③ 発注・確定済額** (`ordered_committed_amount`)
  4. **④ 今実際に発生した原価（最重要強調表示）** (`actual_occurred_cost`)
  5. **⑤ 着地予想原価 ＆ 見込粗利** (`forecast_final_cost` / `forecast_gross_profit` / 粗利率 `forecast_profit_rate`%)
- **原価5要素の内訳プログレスバー (`actual_breakdown`)**:
  - 外注費（出来高）・材料費・労務費（出面）・現場経費・機械損料の5要素がそれぞれ何円・何％発生しているかを色分けバーと数値で可視化。
- **工種別（12桁工種）予実対比テーブル (`by_work_type`)**:
  - 工種コード・工種名・実行予算額・発注済額・**実際発生原価**・予算残高・消化率（%プログレスバー、100%超は赤表示）を一覧表示。

### 3. `frontend/src/App.tsx`
- ヘッダーナビゲーションで **「📊 工事原価コックピット」** と **「➕ かんたん原価登録（外注出来高・材料・日報・損料）」** を切り替えられるようにし、原価登録完了時にコックピットデータを自動再取得（リフレッシュ）する構成にしてください（※Session 4で `EasyCostInput.tsx` を実装するため、このセッションではプレースホルダーまたは基本接続を用意してください）。

## 管理者による確定補足
- 他者の変更を戻さず、アンカーbindings.ts・依存は変更しない。コマンド・commit・pushは禁止。strict/noUncheckedIndexedAccessを守る。金額・率計算はdecimal.js、表示時のみ安全なnumberへ変換。
- UIは日本語。背景#f5f7fb、濃紺の見出し、白カード、青緑アクセント、十分な余白・読みやすい金額・ボタン・フォームを備えた業務ダッシュボード。スマホ375pxでも横溢れしない（表だけ横スクロール可）。外部画像・フォント取得は不要。
- 工事全体集計は枝番指標の金額を合算し、粗利率/消化率は合算金額から再計算。金額比率を単純平均しない。工事ごとに限定し、別工事を合算しない。履歴番号を全体で単一Revとして表示しない。
- 警告文の4,500万円は提供資料の内部警告値で、現行法判定と称さず「監理技術者の設定を確認してください」と表示。
- API取得中・空データ・失敗・再試行を実装。失敗時に成功風のダミー値を表示しない。全ボタン/入力/タブにアクセシブルな名称とフォームlabelをつける。
- Session4用のEasyCostInputの予定propsを固定: {projects:ProjectCostCockpitDto[],companyCode:string,onRegistered:()=>Promise<void>}。Appで登録成功時のcockpit+lookups更新に備える。Phase3中は未作成コンポーネントimportをしない。
この回は画面のみ。編集対象はfrontend/src/App.tsx,frontend/src/CockpitView.tsxの2つ。前回作成したindex.htmlの共有CSSクラスを使う。CockpitView propsは {projects:ProjectCostCockpitDto[]} とする。Appは取得/再試行/ナビを担当し、初期companyCodeは0000。必要な会社・工事選択は名称を使い専門コード暗記不要にする。
