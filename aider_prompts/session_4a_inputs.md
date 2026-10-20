# Session 4: freee型・前提知識ゼロの「かんたん原価入力UI」実装 (`EasyCostInput.tsx`)

あなたは建設原価管理システム「Project Sirius Reborn」のUX/フロントエンド担当エンジニアです。
Read-Onlyで提供された `CONVENTIONS.md` および `frontend/src/bindings.ts` に従い、`frontend/src/EasyCostInput.tsx` を実装し、`frontend/src/App.tsx` に組み込んでください。

## 厳守ルール
1. `frontend/src/bindings.ts` はロック済アンカーです。変更しないでください。
2. ユーザーが「勘定科目」「借方・貸方」「費目コード」「工種コードの暗記」を一切必要としない、会計ソフトfreeeのような質問・カード選択型UIを実装してください。
3. 端数計算のプレビューには `decimal.js` を使用し、JavaScriptの浮動小数点誤差を出さないでください。

## 実装する4つの原価入力モード (`frontend/src/EasyCostInput.tsx`)

`GET /api/v1/lookups` から取得したマスタ辞書を使い、以下の4つのタブ（大きなアイコン付きカードボタン）を提供します：

### タブ1：🏗️ 「外注さんの今月の出来高を入れる」（外注費）
- 発注済みの注文書一覧（`subcontract_orders`）から対象の注文書を選択。
- **「今回どこまで進みましたか？」** をスライダー（0%〜100%）または今回査定税抜金額で入力。
- 画面上でリアルタイムに以下を自動計算プレビュー表示（`CONVENTIONS.md` §3.2 準拠）：
  - 今回工事原価として計上される外注費（税抜）
  - 自動計算された消費税額、保留金控除（10%・端数切捨）、安全協力会費控除（0.3%・端数切捨）、差引振込予定額
- 「この内容で出来高を確定する」ボタンで `API_ENDPOINTS.SUBMIT_SUBCONTRACT_PROGRESS` へPOSTし、コックピットへ即座に反映。

### タブ2：🧱 「買った材料・現場経費を入れる」（材料費・経費）
- **「何を買いましたか？／何を使いましたか？」** を登録済みの品目テンプレートカード（`quick_templates`：生コン、異形鉄筋、砕石、産廃処分費、駐車場代など）から1クリックで選択。
- 選択するだけで、裏側で自動的に12桁 `work_type_code` と `cost_element_code`（`'0100'` 材料費 または `'0400'` 現場経費）、標準単位・単価がセットされる（手動調整も可能）。
- 数量と単価から `round_half_up(数量 * 単価)` で金額を自動計算し、`API_ENDPOINTS.SUBMIT_DIRECT_COST` へPOST。

### タブ3：👷 「今日の現場日報（出面）をつける」（労務費・スマホ3タップ対応）
- ① **「誰が？」**（作業員カード選択）
- ② **「どの工事・どの作業に？」**（工事枝番 ＆ 作業内容選択）
- ③ **「何時間入った？」**（クイックボタン：`8.0時間 (1.0人工)` / `4.0時間 (0.5人工)` / `10.0時間 (残業2h)` または数値入力）
- これだけで作業員の標準日額から本日の概算労務原価を自動表示し、`API_ENDPOINTS.SUBMIT_DAILY_REPORT` へPOST。

### タブ4：🚜 「資機材・重機の現場出庫を入れる」（機械・仮設損料）
- 資機材マスタ（`枠組足場セット`、`防音型ディーゼル発電機` など）を選択し、数量・使用日数・運賃を入力すると、`数量 × 日単価 × 日数 + 運賃` を自動計算して `API_ENDPOINTS.SUBMIT_EQUIPMENT_MOVEMENT` へPOST。

## 管理者による確定補足
- 編集は frontend/src/EasyCostInput.tsx, frontend/src/App.tsx の2つ。他者の変更を戻さず、アンカー・依存・他ファイル・コマンド・commit・push禁止。
- EasyCostInput propsは {projects:ProjectCostCockpitDto[],companyCode:string,onRegistered:()=>Promise<void>}。GET lookupsにcompany_codeをURLSearchParamsで付ける。登録後はlookupsを再取得し、onRegisteredもawaitして両画面を最新化。
- JSON型はLookupsDto/既存Request/CostRegistrationResponse/ErrorResponseをimport。decimal.jsで全金額/率計算、quantity/unit_price/work_hoursはJSON文字列。円は整数number（safe integer/15桁検証）。
- 外注スライダーは累計進捗0〜100、今回額=round_half_up(契約額×進捗/100)−前回累計。金額直接入力も可。注文実値tax_rateと率分子分母・accum_assessed_tax_amountで累計差額税を計算する。表示に「概算（確定時に再計算）」を明記。率を10%/0.3%固定しない。固定控除・相殺入力と対象年月も用意。
- 全入力モードで工事枝番を選択でき、完成2/3は選択不可（名称と状態表示）、完成1は注意表示。外注は選択枝番の注文だけ表示。
- 材料経費は品目カードから工種と費目を自動セット。数量/単価/日付/任意仕入先を入力でき、専門コードを直接入力させない。
- 日報は作業員・工事枝番/作業・8/4/10時間ボタン。既定日付はローカル日付。資機材は数量・正の日数・運賃・整備費と日付を入力。マスタから日単価を使う。
- フォームsubmitと同時にbusy refを立て、並行登録を確実に防ぐ。通信失敗時は入力を保持し、日本語エラーをrole=alertに表示。成功時の伝票番号/警告も表示。再試行/再読込を用意。送信中に工事切替等で送信内容が変わらないようにする。
- 各フィールドlabelとエラーを実装。負数/不正日付/空欄/数量小数4桁/費目選択なし/累計進捗後退/発注超過は送信前に拒否する。
- UIは既存index.htmlの共有スタイルに合わせ375pxでも操作可能。Appの既存コックピット・会社・工事選択とエラー処理を維持。

## 今回の分割担当 Session4A（最優先）
編集はEasyCostInput.tsxとApp.tsxの2ファイル。EasyCostInputはexport const EasyCostInputとして共通マスタ取得、工事枝番選択、4タブと状態、外注・材料経費の2フォームを実装する。出面と資機材は次回実装のプレースホルダーでよく、この2つのフォーム・送信処理はまだ生成しない。Appに接続する。Appの登録後再取得はバックグラウンドで行い、isLoadingでEasyCostInputをアンマウントして成功メッセージや入力内容を消さない（初回読み込みだけ全体のloading表示）。各モードのsubmitにはbusy refによる再入防止を実装。今回だけではSession4完成とは報告しない。
