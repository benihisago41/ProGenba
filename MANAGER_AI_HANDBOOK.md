# 管理者AI（Orchestrator AI）専用ハンドブック＆マスタープロンプト

本書は、コーディングワーカーである **Aider** を指揮・監督して次世代建設原価管理システム **「Project Sirius Reborn」** を完成させる **管理者AI（Manager AI）** のための運用手順書です。

---

## 0. 管理者AIへ最初に与えるシステムプロンプト（コピペ用）

別の管理者AI（Claude Code / Cursor Agent / OpenCode / 自律型オーケストレーター等）を起動する際、以下のブロックをそのままシステムプロンプト（または最初の指示）として貼り付けてください。

```markdown
あなたは建設原価管理システム「Project Sirius Reborn」の開発を統括する【管理者AI（Orchestrator）】です。
あなた自身は業務ロジックをゼロから推測して書いてはなりません。あなたの使命は、作業フォルダに用意された「不変アンカーファイル」と「5つのセッション別プロンプト（`aider_prompts/session_1..5.md`）」を使ってCLIエージェント **Aider** を順番に起動し、各セッション終了後に必ず監査スクリプト `scripts/verify_gate.ps1` を実行して、Aiderの脱線（伝言ゲームによる仕様劣化）を検閲・矯正することです。

### 絶対遵守する3つの統括ルール
1. **アンカーファイルの絶対保護**:
   以下の4ファイルは「ロック済の不変契約（Single Source of Truth）」です。Aiderを実行する際は必ず `--read`（読み取り専用）として渡し、絶対に書き換えさせないでください。
   - `CONVENTIONS.md`（ドメイン・端数処理・スコープ規約）
   - `migrations/001_core_cost_schema.sql`（PostgreSQL 16 複合主キー・不変履歴DDL）
   - `backend/src/domain/types.rs`（Rust 厳密数値型・DTO定義）
   - `frontend/src/bindings.ts`（TypeScript 完全同期型・APIエンドポイント定数）
2. **セッション間の記憶遮断（伝言ゲームの防止）**:
   Aiderを起動する際は、必ず `--no-restore-chat-history` と `--yes-always` を付与し、1セッションあたり最大4ファイルだけを編集対象（`--file`）として渡してください。あなたの要約テキストをAiderに渡すのではなく、`aider_prompts/session_X_*.md` を `--message-file` でそのまま渡してください。
3. **ゲート監査の義務化**:
   各セッションのAiderコマンドが完了したら、必ず `powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session <番号>` を実行してください。
   - Exit Code `0`（GATE PASSED）の場合のみ、次のセッションへ進んでください。
   - Exit Code `1`（GATE FAILED）の場合は、出力されたエラーメッセージ（`[DRIFT_DETECTED]`, `[CARGO_TEST_FAILED]`, `[TS_TYPECHECK_FAILED]` 等）をそのままAiderに `--message` で渡して修正させるか、アンカーが壊れた場合は `git checkout -- CONVENTIONS.md migrations/001_core_cost_schema.sql backend/src/domain/types.rs frontend/src/bindings.ts` で復元してください。
```

---

## 1. なぜこの構成で「トークン溢れ」と「伝言ゲーム」が防げるのか？

| リスク要因 | 本スターターキットの防御機構 |
| :--- | :--- |
| **① トークン上限超過** | [`.aiderignore`](file:///c:/Users/murph/Desktop/%E3%82%AC%E3%83%AA%E3%83%90%E3%83%BC%E3%83%BB%E3%83%97%E3%83%AD%E3%82%B9%E3%83%86%E3%83%BC%E3%82%B8_v6.2.0_%E9%9D%99%E7%9A%84%E8%A7%A3%E6%9E%90%E4%B8%80%E5%BC%8F/.aiderignore) により、700KB超の旧逆コンパイル資産（`01_DotNet_.../` 等）と44KBのフル仕様書をAiderのRepo Mapから完全遮断。1セッションあたり読み込むトークン量を常に **3,000〜5,000トークン以下** に抑えます。 |
| **② セッション分断による命名・型のズレ（伝言ゲーム）** | バックエンドの型（[`backend/src/domain/types.rs`](file:///c:/Users/murph/Desktop/%E3%82%AC%E3%83%AA%E3%83%90%E3%83%BC%E3%83%BB%E3%83%97%E3%83%AD%E3%82%B9%E3%83%86%E3%83%BC%E3%82%B8_v6.2.0_%E9%9D%99%E7%9A%84%E8%A7%A3%E6%9E%90%E4%B8%80%E5%BC%8F/backend/src/domain/types.rs)）、DBスキーマ（[`migrations/001_core_cost_schema.sql`](file:///c:/Users/murph/Desktop/%E3%82%AC%E3%83%AA%E3%83%90%E3%83%BC%E3%83%BB%E3%83%97%E3%83%AD%E3%82%B9%E3%83%86%E3%83%BC%E3%82%B8_v6.2.0_%E9%9D%99%E7%9A%84%E8%A7%A3%E6%9E%90%E4%B8%80%E5%BC%8F/migrations/001_core_cost_schema.sql)）、フロントエンドの型とAPI URL定数（[`frontend/src/bindings.ts`](file:///c:/Users/murph/Desktop/%E3%82%AC%E3%83%AA%E3%83%90%E3%83%BC%E3%83%BB%E3%83%97%E3%83%AD%E3%82%B9%E3%83%86%E3%83%BC%E3%82%B8_v6.2.0_%E9%9D%99%E7%9A%84%E8%A7%A3%E6%9E%90%E4%B8%80%E5%BC%8F/frontend/src/bindings.ts)）が **事前作成・ロック済** のため、Session 2（Rust API）と Session 3〜4（React UI）がお互いのコードを見なくても100%型とURLが一致します。 |
| **③ 経理機能や浮動小数点への脱線** | [`scripts/verify_gate.ps1`](file:///c:/Users/murph/Desktop/%E3%82%AC%E3%83%AA%E3%83%90%E3%83%BC%E3%83%BB%E3%83%97%E3%83%AD%E3%82%B9%E3%83%86%E3%83%BC%E3%82%B8_v6.2.0_%E9%9D%99%E7%9A%84%E8%A7%A3%E6%9E%90%E4%B8%80%E5%BC%8F/scripts/verify_gate.ps1) が `f32`/`f64` や `journal_entry`、`借方`/`貸方` の混入を正規表現で機械的にスキャンし、混入時は即座にGate Failを返します。 |

---

## 2. 管理者AIが実行する全5セッションのコマンド手順

管理者AIは以下の順番通りにコマンドを実行し、各ステップのゲート通過を確認してから次へ進みます。

### 【事前確認】Gitリポジトリの初期化（未初期化の場合のみ）
Aiderの自動コミットとロールバックを有効にするため、最初に1回だけ実行します。
```powershell
if (-not (Test-Path ".git")) {
    git init
    git add .aiderignore .aider.conf.yml AGENTS.md CONVENTIONS.md migrations/ backend/ frontend/
    git commit -m "chore: lock immutable domain anchors and schema"
}
```

---

### 🔹 Session 1: 決定論的・工事原価計算エンジンの実装 (`calc.rs`)
* **目的**: 出来高査定・保留金/協力会費控除・消費税累計差額計算・労務費出面按分の純粋関数と単体テストを実装する。
* **実行コマンド**:
```powershell
aider --no-restore-chat-history --yes-always `
  --read CONVENTIONS.md `
  --read backend/src/domain/types.rs `
  --file backend/src/domain/mod.rs `
  --file backend/src/domain/calc.rs `
  --file backend/src/lib.rs `
  --message-file aider_prompts/session_1_calc_engine.md
```
* **監査ゲート**:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session 1
```

---

### 🔹 Session 2: バックエンドAPI・PostgreSQL集計実装 (`api/*.rs`, `main.rs`)
* **目的**: 工事原価コックピット集計APIと4大原価（外注出来高・材料経費・出面日報・機械損料）登録APIを実装する。
* **実行コマンド**:
```powershell
aider --no-restore-chat-history --yes-always `
  --read CONVENTIONS.md `
  --read migrations/001_core_cost_schema.sql `
  --read backend/src/domain/types.rs `
  --read backend/src/domain/calc.rs `
  --read frontend/src/bindings.ts `
  --file backend/src/api/mod.rs `
  --file backend/src/api/projects.rs `
  --file backend/src/api/actual_costs.rs `
  --file backend/src/main.rs `
  --message-file aider_prompts/session_2_backend_api.md
```
* **監査ゲート**:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session 2
```

---

### 🔹 Session 3: 工事原価コックピットUIの実装 (`CockpitView.tsx`, `App.tsx`)
* **目的**: 本工事・追加工事ごとの「請負額 vs 実行予算 vs 発注済 vs 実際発生原価 vs 見込粗利」を信号機カラーで可視化するUIを実装する。
* **実行コマンド**:
```powershell
aider --no-restore-chat-history --yes-always `
  --read CONVENTIONS.md `
  --read frontend/src/bindings.ts `
  --file frontend/index.html `
  --file frontend/vite.config.ts `
  --file frontend/src/main.tsx `
  --file frontend/src/App.tsx `
  --file frontend/src/CockpitView.tsx `
  --message-file aider_prompts/session_3_cockpit_ui.md
```
* **監査ゲート**:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session 3
```

---

### 🔹 Session 4: freee型・前提知識ゼロの「かんたん原価入力UI」実装 (`EasyCostInput.tsx`)
* **目的**: 勘定科目やコードを一切意識せず、①外注出来高スライダー、②品目カード選択（材料・経費）、③スマホ3タップ出面日報、④資機材出庫を入力できる画面を実装する。
* **実行コマンド**:
```powershell
aider --no-restore-chat-history --yes-always `
  --read CONVENTIONS.md `
  --read frontend/src/bindings.ts `
  --file frontend/src/App.tsx `
  --file frontend/src/EasyCostInput.tsx `
  --message-file aider_prompts/session_4_easy_input_ui.md
```
* **監査ゲート**:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session 4
```

---

### 🔹 Session 5: Windows Server不要・ローカル単一コンテナ化 (`Dockerfile`, `docker-compose.yml`)
* **目的**: マルチステージビルドとPostgreSQL 16自動初期化を備えた `docker-compose.yml` を生成し、`docker compose up -d` で社内稼働させる。
* **実行コマンド**:
```powershell
aider --no-restore-chat-history --yes-always `
  --read CONVENTIONS.md `
  --read migrations/001_core_cost_schema.sql `
  --read backend/Cargo.toml `
  --read frontend/package.json `
  --file Dockerfile `
  --file docker-compose.yml `
  --message-file aider_prompts/session_5_docker_packaging.md
```
* **監査ゲート ＆ 起動検証**:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_gate.ps1 -Session 5
docker compose up -d --build
```

---

## 3. トラブルシューティング（Aiderがゲート監査に落ちた場合の対処）

1. **`[DRIFT_DETECTED]` または `[CARGO_TEST_FAILED]` / `[TS_TYPECHECK_FAILED]` が出た場合**:
   管理者AIは、同じセッションの `--read` と `--file` を指定したまま、以下の修復コマンドを1回実行します：
   ```powershell
   aider --no-restore-chat-history --yes-always `
     --read CONVENTIONS.md --read backend/src/domain/types.rs `
     --file <エラーが発生したファイルパス> `
     --message "verify_gate.ps1 で以下のエラーが検出されました。CONVENTIONS.md と types.rs に従い修正してください: <エラー出力全文>"
   ```
2. **`[ANCHOR_CORRUPTED]` が出た場合**:
   即座に以下のコマンドでロック済アンカーを無傷の状態に戻します：
   ```powershell
   git checkout -- CONVENTIONS.md migrations/001_core_cost_schema.sql backend/src/domain/types.rs frontend/src/bindings.ts
   ```
