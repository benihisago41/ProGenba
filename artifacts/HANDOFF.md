# 完了時の引継ぎ

## 作業場所と保全
- 本体: C:/Users/murph/Documents/GitHub/ProGenba。mainは初回コミット前、元資産37ファイルは変更せず保全。
- 実装: C:/Users/murph/Documents/GitHub/ProGenba.wt-codex-sirius-reborn
- ブランチ: ai/codex/sirius-reborn。入力基準b318ae6、最終資材は完了コミットに収録。
- 禁止範囲: 元フォルダ/main、旧解析資産、他チャットの変更・プロセス・Docker資産、認証情報の記録。
- 入力保全: input-manifest.json / source-preservation.json（37/37無変更）。

## 実装と検証
- Phase0: 分母NUMERIC(7,2)、取得DTO、Decimal文字列契約を修正し4アンカー固定。
- Session1〜5すべて監査合格。verification-summary.json / gate-1..5.json参照。
- Rust1.80: 計算7試験+JSON契約1試験。
- 配布イメージ: 実DB API受入10項目、実画面Chrome受入11項目、アプリ/DB再起動後の全原価保持。
- 試験スクリプトの開始条件失敗時に既存原価・予算改定を保持することも実DBで確認。
- 試験用8伝票は記録と照合し削除済み。現在のサンプル実際原価は0円。
- Aider主モデルvertex_ai/gemini-4-argon、補助vertex_ai/gemini-3.8-flash。モデル変更なし。
- Rust1.80互換lock固定。url2.5.2/idna0.5.0。ホストへの新規ランタイム導入なし。

## 稼働中・一時資材
- progenba-app-1: http://127.0.0.1:8080（配布イメージ、非root実行）。
- progenba-db-1: PostgreSQL16、ホストポート非公開、progenba_pgdataで永続化。
- 停止: 作業worktreeで docker compose stop。再開は docker compose start。
- .envはGit管理外。秘密の値をログ・コミットへ記録しない。
- 検証専用API/preview/phase0 DBの3コンテナと開発ネットワークを削除済み。他者のopenhands-appは未変更。
- 検証キャッシュprogenba-codex-cargo-registry / progenba-codex-cargo-gitは再検証用に保持（プロセスなし）。
- ログ・一回実行の片付けスクリプトはartifacts/runs/、画像はartifacts/browser/（いずれもGit管理外でworktree内に保持）。

## 次の操作と制約
- 必須残件なし。利用手順はREADME.md、検証結果はartifacts/VERIFICATION.md。
- 認証・権限・実データ移行・バックアップ運用は対象外。限定社内検証用。物理スマホ/LAN別端末・負荷試験は未実行。
- Gate2/3の開発用再検証には削除済みの専用DB環境を再作成する。既存の実データDBで受入スクリプトを実行しない。
- GitHub: https://github.com/benihisago41/ProGenba （公開。ユーザーの明示承認により新規作成）。originを設定しai/codex/sirius-rebornをpush済み。
- PR: https://github.com/benihisago41/ProGenba/pull/1 （base: main、head: ai/codex/sirius-reborn）。マージはユーザーが行う。
- GitHubの初期READMEを含むmainを作業ブランチへ取り込み、検証済みの実装内容は保持。本体mainと元資産は未変更。
- 未統合なのでworktree/ローカル作業ブランチ/公開作業ブランチ各1を保持（削除0）。マージ後に取り込み・使用状況を確認して整理する。
- 公開前に全7実装コミットの秘密鍵/APIトークン形式と100MB以上の管理ファイルを検査し、該当なし。.env・実行ログ・ブラウザ画像は除外。
- 公開作業は履歴接続と引継ぎ記録のみ。実装差分がないため、既存の合格試験の証拠を維持し全体試験は再実行していない。
- 本体mainが未コミットのため、統合時も未追跡の元資産を上書きせず保全して進める。
