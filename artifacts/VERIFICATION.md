# 検証結果

実装時の必須の全5ゲートが合格しました。サマリーは `verification-summary.json`、各ゲートの当時の結果は `gate-1.json`〜`gate-5.json` です。資料整備時の確認は `record-maintenance.json` に分け、過去の受入試験を再実行したように扱いません。

| 対象 | 結果・証拠 |
|---|---|
| 元資産の保全 | 元資料37/37ファイルのハッシュ一致を確認。実装時はsource-preservation.json、統合後の退避先は下記参照 |
| DB初期化・制約 | PostgreSQL16の初期化、会社複合主キー、承認済更新拒否、ゼロ分母拒否、会社違い参照拒否。phase0-database.json |
| 計算・型 | Rust1.80で計算7件・数値JSON契約1件。gate-1.json / gate-2.json |
| API | 配布イメージ・実DBで10シナリオ合格。acceptance-api.json |
| 画面 | 既存Chromeで11シナリオ合格、JavaScript例外0。acceptance-browser.json |
| 永続化 | 画面登録後にアプリとDBを再起動し、コックピット全数値が一致。acceptance-persistence.json |
| 検証処理の分離 | 試験開始条件に合わないDBで既存原価・予算改定を保持。test-harness-isolation.json |
| 試験データの片付け | 自分の8伝票だけ削除、原価レコード0件。cleanup-test-data.json |
| 配布 | Rust1.80 release/Node22でビルド、アプリ非root、DB非公開。deployment.json |

APIの10項目は、数値型、査定税・控除、5要素独立集計、不正入力、完成区分、同時査定、古い発注履歴、最新承認済予算、同一業務コードを持つ二社の分離、登録失敗時のロールバックです。

画面の11項目は、外注プレビューと登録、材料丸めと入力検証、経費カード、通信失敗後の入力保持と再試行、連打1回登録、出面標準日額、資機材運賃整備費、枝番と合算、375px幅、初回取得失敗からの復帰、安全整数上限の検知と枝番表示への復帰です。

画面画像は本体の `artifacts/closed-worktrees-2026-10-21/sirius-reborn/browser/` にある `cockpit-desktop.png`、`cockpit-mobile.png`、`input-mobile.png` へ退避済みです。実行ログ・指示は同退避先の `runs/`、元資料37ファイルは `original-inputs/`、統合・整理の記録は `CLEANUP.md` にあります。

これらの退避資材はローカルのみでGitHubには含まれません。GitHubで共有する検証証拠は本資料と各JSONです。画像は受入試験中の原価が入った状態で、試験後のサンプルDBは自分の試験伝票を削除して0円に戻しています。

認証・権限、実データ移行、バックアップ復元の運用、物理スマホ・別端末LANアクセス、大容量・長時間負荷は今回未実施です。限られた社内検証用として利用してください。提供資料の監理技術者警告は現行法への適合保証ではありません。

実装は公開リポジトリ https://github.com/benihisago41/ProGenba のPR #1でmainへ統合済みです（ad38e184e90c3e066492e6e8fd6ed7fadf2cd29d）。実装用の作業ブランチはローカル・GitHub各1件、worktreeは1件を削除しました。

アプリは本体フォルダのComposeを起動元とし、127.0.0.1:8080で稼働、DBはホストポート非公開です。起動元移行後にHTTP 200とコックピット全値一致を確認済みです。
