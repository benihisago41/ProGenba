# 管理者AIハンドブック — 実装・検証版

本書はProject Sirius Rebornの管理者がAiderを指揮し、成果物をレビューするための手順です。初期資料はGitの入力基準コミットb318ae6に保存しています。今回の作業結果と次の操作は `artifacts/HANDOFF.md`、利用手順と制約は `README.md` を参照してください。

## 管理者とAiderの担当

- 管理者：業務条件の確定、編集範囲の指定、差分レビュー、監査・受入試験、コミットと引き渡し。
- Aider：指定された最大4ファイルの実装。アンカーや担当外のファイルを変更せず、コマンド・コミット・pushを実行しない。
- 各回は新規履歴。要約の伝言で仕様を置き換えず、`aider_prompts/` の指示ファイルと参照専用の契約を渡す。
- 自動コミット・履歴復元・無条件承認・自動URL取得・自動テストを無効にする。終了コードや自己申告だけで合格にしない。

## 作業場所と入力の保全

初回はmainが初回コミット前だったため、独立したorphan worktreeに入力資産を複製して基準を記録しました。入力一覧とハッシュは `artifacts/input-manifest.json`、実装時の保全確認は `artifacts/source-preservation.json` です。

その後、ユーザーの明示承認により公開リポジトリ作成・PR #1のマージまで完了しました。本体をmainへ同期する前に元資料37ファイルをハッシュ照合し、`artifacts/closed-worktrees-2026-10-21/sirius-reborn/original-inputs/` へ保全済みです。今後もmainへ直接コミットせず、作業ブランチ/worktreeを使います。マージはユーザーの承認範囲を確認して行います。

## Phase 0：契約整備と固定

初期DDLの率分母桁数、取得DTO不足、DecimalのJSON表現を修正してから固定しました。

- `CONVENTIONS.md`
- `migrations/001_core_cost_schema.sql`
- `backend/src/domain/types.rs`
- `frontend/src/bindings.ts`

基準は `artifacts/anchor-hashes.json`。以降は全て参照専用とし、監査でハッシュを照合します。`.gitattributes` で4アンカーの改行をLFに固定しています。記録整備時に改行だけを正規化し、本文の一致を確認してLFの基準ハッシュに統一しました。異常時に一括復元や基準の上書きをせず、管理者が差分と原因を確認してください。

Rust試験はDocker内の1.80で行います。依存は `backend/Cargo.lock`、フロントエンドは `frontend/package-lock.json` を使います。初期の無固定依存ではRust1.80非互換が発生したため、互換性を考慮して解決しurl2.5.2/idna0.5.0を固定済みです。ホストのランタイム・グローバル設定は変更しません。

## Aiderの起動

`scripts/invoke_aider.ps1` がUTF-8、編集4ファイル上限、履歴分離、実行ログを管理します。現在の主モデルは既存設定の `vertex_ai/gemini-4-argon`、補助は `vertex_ai/gemini-3.8-flash` です。モデルを独断で切り替えません。

```powershell
./scripts/invoke_aider.ps1 -Task session1 `
  -MessageFile aider_prompts/session_1_calc_engine.md `
  -EditableFiles @('backend/src/domain/mod.rs','backend/src/domain/calc.rs','backend/src/lib.rs') `
  -ReferenceFiles @('CONVENTIONS.md','backend/src/domain/types.rs')
```

`--file` は編集を強制制限するサンドボックスではありません。終了後は担当外の変更と未追跡ファイルも確認します。ログはGit管理外の `artifacts/runs/<Task>/` に残します。LLM出力上限に達したら変更の適用有無を確認し、担当を分割します。同じ原因の失敗を盲目的に繰り返しません。

## 実行順序

| セッション | 分割と編集対象 | 完了時の監査 |
|---|---|---|
| 1 計算 | domain/mod.rs、calc.rs、lib.rs | `./scripts/verify_gate.ps1 -Session 1` |
| 2 API | 2A：api/mod.rs・projects.rs、2B：actual_costs.rsの共通処理と査定、2C：残る登録・main.rs・レビュー修正 | `./scripts/verify_gate.ps1 -Session 2` |
| 3 コックピット | 3A：index.html・vite.config.ts・main.tsx、3B：App.tsx・CockpitView.tsx | `./scripts/verify_gate.ps1 -Session 3` |
| 4 入力 | 4A：EasyCostInput.tsx・App.tsx、4B：残る入力・CockpitViewの安全整数ガード | `./scripts/verify_gate.ps1 -Session 4` |
| 5 配布 | Dockerfile・docker-compose.yml | 配布構成の受入後 `./scripts/verify_gate.ps1 -Session 5` |

2〜4の分割指示は対応する `session_2a/2b/2c_*`、`session_3a/3b_*`、`session_4a/4b_*` ファイルを使います。各回に必要な既存ファイル・型・DDL・共有スタイルを参照専用で渡します。分割途中を完成と扱わず、セッション全体の監査exit0が次工程への条件です。

## 検証環境と受入

- Gate1：アンカー・禁止パターン・計算とJSON契約試験。
- Gate2：Rust試験と実DBのAPI受入。開発専用DB `progenba-codex-phase0-db` を前提とし、API用コンテナを試験後停止・削除します。
- Gate3：型検査・本番ビルド、プレビュー起動、実APIのChrome表示試験。
- Gate4：型検査・本番ビルド、4方式登録・精度・連打・通信失敗・モバイル・合算上限の画面受入。
- Gate5：Compose設定と配布イメージで実行したAPI・画面・再起動永続化の合格証拠。

ブラウザー試験はプロジェクト内のPlaywrightと既存Chromeを使います。Chromeの場所が異なる場合はプロセス環境変数 `CHROME_PATH` を指定します。検証の専用DB以外では受入スクリプトを実行しません。

配布はアプリとPostgreSQL16の2サービスです。`.env` は起動スクリプトが作成しGit管理しません。DBのホストポートは公開しません。配布構成の検証では次を順番に実行します。

```powershell
./scripts/start_local.ps1
$env:SIRIUS_TEST_DB_CONTAINER='progenba-db-1'
$env:SIRIUS_TEST_DB_USER='sirius'
node scripts/test_api.mjs
$env:SIRIUS_KEEP_BROWSER_DATA='1'
node frontend/tests/acceptance.mjs
node scripts/test_persistence.mjs
./scripts/verify_gate.ps1 -Session 5
```

各コマンドの失敗時は後続を止めて修正します。再起動試験後、今回作った試験伝票だけを記録と照合して削除します。プレビューの停止は `./scripts/preview.ps1 -Stop`。他者のコンテナ・ボリュームを止めません。

## 引き渡し

必須試験に合格したら追加改善で作業を広げません。結果、未対応範囲、未コミット状態、ブランチ・worktree・一時成果物・稼働中コンテナとポートを記録します。未統合のworktreeは保持し、ユーザー承認の下で統合した後に取り込みと所有を確認して整理します。秘密は記録しません。現在の状態は `artifacts/HANDOFF.md`、残作業の指示は `artifacts/NEXT_ACTIONS.md` を参照してください。
