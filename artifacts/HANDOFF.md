# 作業引継ぎ

- 本体: C:/Users/murph/Documents/GitHub/ProGenba（変更禁止）。既存37ファイルのハッシュは input-manifest.json。
- 作業: C:/Users/murph/Documents/GitHub/ProGenba.wt-codex-sirius-reborn
- ブランチ: ai/codex/sirius-reborn。初期記録 b318ae6。本体mainは未コミットのまま保全。
- 禁止: 旧解析資産の編集、認証情報の記録、mainへのコミット・マージ、他者コンテナ停止。
- 到達点: Phase 0開始前。まだ試験合格なし。Aider実装、管理者レビュー・監査を順次実行。
- 既知の必須修正: DDL分母桁数、DTO不足、Decimal JSON契約、監査強化、Session 3の分割。
- 実行中: なし。
- 次: Phase 0のAider実行→差分レビュー→専用PostgreSQLでDDL検証。
# 進捗
- 本体37ファイルは保全、専用worktreeに初期コミット b318ae6。
- Phase 0 Aider契約修正は終了コード0。管理者が差分確認。PostgreSQL16でDDL/シード初期化成功（枝番2・品目5）。
- Rust1.80初回試験は新しいtransitive依存のedition2024で失敗。Cargo1.85のMSRV-aware resolverで1.80互換lockを生成し、1.80で試験する手順へ修正中。
- 実行中シェル: 16202（Docker image pull→依存解決→Rust契約試験）。専用DB: progenba-codex-phase0-db（ポート非公開、ai.agent=codex）。
- 未コミット: Phase0アンカー3点、規約補足、検証スクリプト、契約試験、Aider起動wrapper等。
- 次: 契約試験を合格させる→アンカーハッシュ固定・Phase0コミット→Session1。

## Session 1完了 / Session 2実行中
- Phase 0合格: PostgreSQL初期化・DB制約6項目、Rust1.80 JSON契約1件、TS型検査。コミット5c976ff。
- Session1合格: calc単体7件+JSON契約1件、Gate1 exit0。コミットd6d5e93。アンカー4点ハッシュ固定済み。
- Rust互換lockはCargo1.85 fallback生成後url2.5.2/idna0.5.0へ固定。アプリのビルド・試験はRust1.80を維持。
- Aider実行中: shell session31701、session2（api/mod.rs/projects.rs/actual_costs.rs/main.rsの4ファイルのみ）。前回の要約終了時警告を避けるため履歴上限100000を指定。
- 独立作業: API受入test_api.mjs、実行用test_backend_api.ps1、監査Gate2連携、.dockerignore/.env.exampleを用意。frontendにplaywrightをdev依存追加（Chrome既存実行ファイル利用、グローバル追加なし）。
- Phase0 DB: progenba-codex-phase0-db（ポート非公開）。他者openhands-appは変更禁止。
- 次: Session2終了・全4ファイル差分レビュー→Gate2（Rust試験、専用API起動、実DB受入、停止）→Session3a/3b。Gate2で初めてAPI受入を実行する。

## Session2の分割
- 最初のSession2は出力上限（約17530token）で打切り。4ファイルとも空で、変更適用なし。盲目的な再実行をせず2A/2B/2Cへ分割。
- 実行中shell95153: Session2A（api/mod.rsとprojects.rsだけ）。終了後2Bでactual_costs.rsの共通処理+査定、2Cで残り登録+main。
- 2A/2B/2Cのプロンプトはaider_prompts/session_2a_queries.md,session_2b_assessment.md,session_2c_entries.md。元Session2仕様全文+担当制限を渡す。
- Phase2全体のGateは3分割終了後。各起動は新規履歴、max-chat-history-tokens=100000。
- Chrome自動ブラウザー環境の小試験は合格（375px viewport）。実画面試験は未実行。

## Session2C実行中
- 2A/2BはAider exit0。mod.rs/projects.rs（取得API）とactual_costs.rs（共通処理+査定）生成済み。アンカーは未変更。
- レビューで見つかった構文誤記 ensure_decimal_ fits_yen、外注ロール確認不足、年月の過剰な範囲制限、lookups削除済み除外不足を2Cの修正指示へ追加。
- 実行中shell89466: 2C（actual_costs.rs/projects.rs/main.rsの3ファイル）。2Bのshell99492は完了。
- 次: 2C終了→全差分レビュー→scripts/verify_gate.ps1 -Session 2。Gate2はRust8試験→test_backend_api.ps1→test_api.mjsの実DB試験→専用API停止を実行。
- user質問への回答済み: Aider主モデルvertex_ai/gemini-4-argon、補助vertex_ai/gemini-3.8-flash（既存設定）。モデル変更なし。
- 既存progenba compose/pgdataはなし（確認済み）。npm playwright追加済み、既存Chromeの小試験は合格。

## Session2合格 / Session3開始
- 2C後にmain.rsのEnvFilter feature不一致を検出。Aider限定修復で既存tracing_subscriber::fmt初期化へ変更。依存・アンカー変更なし。
- Gate2 exit0: Rust7+JSON契約1、実DB API受入10項目すべて合格。二社同一コード分離、最新承認履歴、同時査定、完成4API、途中失敗rollback等。専用APIコンテナは停止・削除済み。コミット5f0eda5。
- Session3A shell20298実行中（index.html/vite.config.ts/main.tsxの3点）。終了後App.tsx/CockpitView.tsxを作成してSession3B。
- Gate3はnpm build後、preview.ps1で専用Rust API+distを8080公開→frontend/tests/cockpit.mjsでChrome実API表示・スクリーンショット。プレビューはSession4まで利用し、Session5前に停止。
- Aiderの自動URL取得がプロンプト中localhostへアクセスしたため、次回から--no-detect-urlsを設定。
- 元資産37/37無変更はartifacts/source-preservation.jsonで確認済み。
