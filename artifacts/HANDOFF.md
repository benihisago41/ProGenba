# 完了時の引継ぎ

## 別PCで使う場合
- 別PCでは元PCのコンテナ・.env・退避ログを持ち込まず、リポジトリからサンプル環境を新規構築する。手順はFRESH_START.mdとREADME.md。
- 2026-10-21時点の元DBは、空DBへ投入したリポジトリのシードと全14テーブルで一致し、原価伝票は0件。今回の引継ぎにDB移行は不要と判断した。
- 元PCの稼働やローカル退避先が、別PCでも存在するという意味ではない。以下の絶対パスは元PCの開発履歴であり、新規構築の前提条件ではない。
- 新規環境の確認範囲はfresh-start.jsonに記録する。移行先での起動・登録・再起動保持は、そのPCで改めて確認する。
- 2026-10-21、別のWindows実機でmain（a027ed3）をクローンし、初回ビルド込み224秒で起動、ヘルス・表示・画面登録（直接費37,000円）・再起動保持の1〜5に合格。その実機DBには検証用伝票1件が残る。物理スマホ・LAN別端末、Linux/macOS実機は未実施。

## 現在の基準と作業場所
- 公開リポジトリ: https://github.com/benihisago41/ProGenba
- 実装PR #1はmainへマージ済み: https://github.com/benihisago41/ProGenba/pull/1
- マージコミット: ad38e184e90c3e066492e6e8fd6ed7fadf2cd29d。
- 本体・稼働元: C:/Users/murph/Documents/GitHub/ProGenba。mainはorigin/mainと同期済み。
- 実装用のai/codex/sirius-rebornとProGenba.wt-codex-sirius-rebornは統合確認後に削除済み。削除数はローカルブランチ1、GitHubブランチ1、worktree1。
- 記録整備PR: https://github.com/benihisago41/ProGenba/pull/2 。本資料の更新を含む。実際の統合状態はこのPRを正とし、統合後の利用・再検証は本体mainで行う。
- 記録整備時の一時作業場所はai/codex/completion-records / C:/Users/murph/Documents/GitHub/ProGenba.wt-codex-completion-records。統合確認後の削除対象であり、起動元ではない。整理結果・ログの退避先は本体のartifacts/closed-worktrees-2026-10-21/completion-records/。
- 禁止範囲: mainへの直接コミット、旧解析資産の改変、他チャットの変更・プロセス・Docker資産の操作、認証情報の記録。

## 実装と検証
- Phase0〜Session5の実装・受入完了。計算7試験＋数値JSON契約1試験、実DB API10シナリオ、Chrome画面11シナリオ、登録後のアプリ/DB再起動永続化に合格。
- 詳細はVERIFICATION.md、verification-summary.json、gate-1..5.json、acceptance-*.json。受入結果は実装時の記録であり、資料修正のたびに試験を再実行したという意味ではない。
- 試験開始条件に合わないDBで既存原価・予算改定を保持することも実DBで確認。試験用8伝票は記録と照合して削除済み。
- 実装マージ後の本体移行ではComposeの起動元、DBマウント、HTTP 200、コックピット全値一致を確認済み。
- 記録整備の対象はアンカーの改行、Aider設定、資料。業務コードは変更しない。追加の検証はrecord-maintenance.jsonを参照。
- Aider主モデルvertex_ai/gemini-4-argon、補助vertex_ai/gemini-3.8-flash。既存モデルを維持。ホストへの新規ランタイム導入なし。

## 保全・ローカル資材
- 入力基準はb318ae6。元資料37ファイルはinput-manifest.jsonのSHA256と一致することを確認し、本体のartifacts/closed-worktrees-2026-10-21/sirius-reborn/original-inputs/に保全。
- 同退避先のruns/に実行ログ・指示ファイル、browser/に画面画像、CLEANUP.mdに統合後の整理記録を保持。これらはローカルのみで、GitHubには含めない。
- 検証JSONと本資料はGitHubで参照可能。詳細な証拠の所在はVERIFICATION.mdを参照。
- .env、frontend/node_modules、frontend/dist、backend/targetは本体へ移動済みでGit管理外。秘密の値を記録しない。
- 検証専用API/preview/phase0 DBの3コンテナと開発ネットワークは削除済み。他者のopenhands-appは未変更。
- 再検証用の停止中キャッシュprogenba-codex-cargo-registry / progenba-codex-cargo-gitは保持。

## 稼働と次の操作
- progenba-app-1: http://127.0.0.1:8080。progenba-db-1: PostgreSQL16、ホストポート非公開、progenba_pgdataで永続化。
- 停止・再開は本体でdocker compose stop / docker compose start。初期構築はREADME.mdのscripts/start_local.ps1。
- Gate2/3の開発用再検証には専用DB環境の再作成が必要。実データDBで受入スクリプトを実行しない。
- 記録整備の統合と、その後の別フェーズの具体的な指示はNEXT_ACTIONS.md。業務機能の追加を今回の完了条件に混ぜない。
- 認証・権限、マスタ・予算・発注編集、月次確定賃金入力、実データ移行、監視・監査ログは対象外。バックアップはscripts/backup_db.ps1とrestore_db.ps1で取得・別DB復元・全行照合まで確認済み（BACKUP_RESTORE.md、backup-restore.json）。定期実行は未登録。物理スマホ/LAN別端末・負荷試験は未実行。限定された社内検証用。
