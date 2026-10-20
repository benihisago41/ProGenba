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
