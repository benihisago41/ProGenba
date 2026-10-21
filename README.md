# Project Sirius Reborn

現場で発生した外注出来高、材料・経費、出面、資機材損料を記録し、本工事・追加工事ごとの予算と見込粗利を確認する社内検証用システムです。

## クイックスタート（別PCでの新規起動）

リポジトリのクローンだけで、サンプル工事データ入りの検証環境を新規作成できます。ホスト側へのRust、Node.js、PostgreSQLの追加インストールは不要です。

### 前提条件
- **Windows**: Docker Desktop（Linuxコンテナ）、Git、PowerShell 7 (`pwsh`)
- **Linux / macOS**: Docker、Docker Compose v2 (`docker compose`)、Git、`curl`

### 起動手順

```sh
git clone https://github.com/benihisago41/ProGenba.git
cd ProGenba
```

- **Windows (PowerShell 7)**:
  ```powershell
  pwsh -File scripts/start_local.ps1
  ```
- **Linux / macOS (POSIX sh)**:
  ```sh
  sh scripts/start_local.sh
  ```

### 初回起動の挙動と引き継ぎ不要な資材
- 初回起動時は `.env`（ランダムなDBパスワード、接続先設定）を自動生成し、コンテナの依存取得とビルドを行うため時間がかかります。既存の `.env` やDockerボリュームがある場合は変更・削除せずそのまま保持します。
- サンプル工事（「青葉台レジデンス新築工事」の本工事・追加工事）と実際原価0円の状態から起動します。
- 元PCのコンテナ、`.env`、DBダンプ、`artifacts/` や `closed-worktrees-*` 内の画像・ログは新規起動の必須資材ではありません。また、リポジトリ内の共有JSON等は過去の試験記録であり、別PCでの動作成功を保証するものではありません。

### 動作確認（別PCでの合格条件）
1. ヘルスチェック応答の確認:
   `http://127.0.0.1:8080/api/v1/health` にアクセス（または `curl --fail http://127.0.0.1:8080/api/v1/health` を実行）し、正常応答が返ること。
2. 最初の利用者の作成（[認証・権限](#認証権限会社境界) 参照）:
   `pwsh -File scripts/add_user.ps1 -CompanyCode 0000 -UserId <利用者ID> -Role approver` を実行し、パスワードを対話入力します。
3. 画面とサンプルデータの確認:
   ブラウザで <http://127.0.0.1:8080> を開き、作成した利用者でログインして「青葉台レジデンス新築工事」のコックピットとサンプル予算が表示されれば合格です。

※別PC（Windows実機）でのクローンからの起動・画面登録・再起動保持は2026-10-21に確認済みです（`artifacts/fresh-start.json` の `physical_other_pc_verification`）。Linux/macOS実機、物理スマホ・LAN別端末は未実施です。

元DBを移行しない判断の根拠と移行先での確認項目は [別環境向け手順](artifacts/FRESH_START.md)、実施済みの検証範囲は [新規構築の検証記録](artifacts/fresh-start.json) を参照してください。

## 起動・運用の詳細

初回はローカル接続用のランダムなDBパスワードを `.env` に作成し、アプリとPostgreSQL 16の2サービスをビルド・起動します。既定の接続先は <http://127.0.0.1:8080> です。既に `.env` がある場合は保持します。2回目以降でビルドを省略する場合は `-NoBuild`（PowerShell）または `--no-build`（sh）を指定できます。

`.env` を用意した後は `docker compose up -d --build` でも起動できます。社内LANで試す場合は `.env` の `APP_BIND_ADDRESS` をホストのLANアドレスに変更します。ポート変更は `APP_PORT` です。DBのホストポートは公開しません。

```powershell
docker compose ps
docker compose stop
docker compose start
```

データは `progenba_pgdata` ボリュームへ保存されます。初期DDLとサンプルデータは空のDBへの初回起動時だけ投入します。停止・再起動で再投入しません。ボリューム削除はデータ削除になるため、通常の停止操作には使用しません。

バックアップは `pwsh -File scripts/backup_db.ps1`（既定の保存先はリポジトリ外の `%OneDrive%\ProGenba-backups`、7世代）、別の空DBへの復元検証は `pwsh -File scripts/restore_db.ps1 -Cleanup` です。方針・稼働DBの置き換え手順・失敗時の確認は [バックアップと復元](artifacts/BACKUP_RESTORE.md) を参照してください。

## 使い方

- コックピットで工事と本工事／追加工事／工事全体を選び、実行予算・発注確定・実際原価・着地予想・見込粗利を確認します。
- かんたん入力で外注出来高、品目カード、出面日報、資機材出庫を登録します。登録後はコックピットを再取得します。
- 出来高の進捗率は累計です。前回までの査定額を引いて今回額を計算します。プレビューは概算であり、登録時にサーバーで再計算します。
- 労務原価は標準日額を8時間で割った概算です。月次確定賃金の按分関数はありますが、その確定入力画面・APIは今回含みません。

サンプルは「青葉台レジデンス新築工事」の本工事と第1回追加工事です。材料・経費、作業員、資機材、外注発注を投入済みで、初期の実際原価は0円です。

## 認証・権限・会社境界

ログインは **会社コード（4桁）＋利用者ID＋パスワード** です。1利用者は1会社・1役割に所属します。画面での利用者管理はありません。

※ `CONVENTIONS.md`（ロック済みアンカー）の「権限承認は今回未対応」「認証・権限は未対応」は、Phase 3 以前の歴史的な記述です。現在の仕様は本章が正です。

| 役割 | 値 | できること |
|---|---|---|
| 閲覧 | `viewer` | コックピット・入力用辞書の閲覧のみ（原価登録APIは403） |
| 登録 | `registrar` | 閲覧＋原価4方式の登録（未成工事＝完成区分0）。完成区分1の工事への登録は403 |
| 承認 | `approver` | 登録＋完成区分1（完成）工事への登録（警告付き201） |

完成区分2/3は全役割で登録不可（従来どおり422）です。

### 利用者の作成・変更（管理者）
アプリ起動後に次を実行し、パスワード（12文字以上）を2回入力します。パスワードは画面に表示されず、引数・ファイル・ログに残りません（アプリコンテナの `add-user` サブコマンドへ標準入力で渡し、DBにはArgon2idハッシュのみ保存）。

```powershell
pwsh -File scripts/add_user.ps1 -CompanyCode 0000 -UserId genba01 -Role registrar -DisplayName "現場 太郎"
# パスワード・役割の変更（その利用者の既存セッションは全て失効、ロックも解除）
pwsh -File scripts/add_user.ps1 -CompanyCode 0000 -UserId genba01 -Role approver -Update
```

Linux/macOS（POSIX sh）では次のように実行します。

```sh
printf 'パスワード: '; stty -echo; IFS= read -r PW; stty echo; echo
printf '%s\n' "$PW" | docker compose exec -T app /app/sirius-reborn-backend add-user --company 0000 --user-id genba01 --role registrar
unset PW
```

利用者の無効化は現時点ではDB操作（`UPDATE app_users SET is_active = FALSE WHERE company_code = '0000' AND user_id = '…'`）です。

### セッションと総当たり対策
- サーバー側セッション（`app_sessions`）。Cookieは256ビット乱数のトークンのみで、DBにはそのSHA-256だけを保存します。属性は `HttpOnly; SameSite=Strict; Path=/`。
- 無操作8時間で失効します（API利用ごとに期限を延長）。ログアウトでサーバー側のセッションを削除します。ブラウザ側はセッションCookie（期限はサーバーで管理）です。
- `Secure` 属性は既定で付けません。本システムは社内LAN/ローカルのHTTPで運用しており、付けるとブラウザがHTTPでCookieを送らずログインできなくなるためです。HTTPS終端の背後で運用する場合は `.env` に `SESSION_COOKIE_SECURE=true` を設定してください。
- ログイン失敗は理由（会社・利用者の不在、パスワード誤り、ロック中、無効）を区別せず同じ401を返します。利用者が存在しない場合もダミーのArgon2id照合を行い、応答時間の差を小さくしています。
- 同一利用者で **5回連続** 失敗すると **15分間** ロックし、その間は正しいパスワードでも401です。成功時・`-Update` 実行時に失敗回数とロックを解除します。存在しない利用者IDへの試行はロック対象になりません。IPアドレス単位の制限はありません。

### 会社境界
- クライアントが送る `company_code` は信頼しません。全てのDB問い合わせはセッションの会社コードで行います。
- 既存のURL・JSON契約は維持します。取得APIの `company_code` を省略するとセッションの会社、指定値がセッションの会社と異なれば403です（従来の既定値 `0000` は廃止）。登録APIの本文の `company_code` もセッションの会社と一致しなければ403です。

### CSRF対策
- Cookieは `SameSite=Strict` で、別サイトからの要求には付きません。
- 状態変更系POST（原価4方式・ログイン・ログアウト）は `Content-Type: application/json` を必須とし、それ以外は400です。HTMLフォームはこの形式を送れず、別オリジンのスクリプトはCORSの事前確認が必要になり、本サーバーはCORSを許可していません。

### スキーマの適用（既存DBへの移行）
- 認証テーブル `app_users`・`app_sessions` は `migrations/002_auth.sql`（冪等）です。業務テーブルは変更しません。
- 新規構築では `docker-compose.yml` の initdb で001の後に投入します。
- 既存DB（`progenba_pgdata` など初期化済みのボリューム）には、**アプリ起動時に同じSQLを自動適用** します。手順は通常の更新と同じです: `git pull` 後に `docker compose up -d --build`。適用に失敗した場合アプリは起動せず終了します（`docker compose logs app` で確認）。
- 更新直後は利用者が0人のため誰もログインできません。上記の `scripts/add_user.ps1` で最初の利用者を作成してください。

## 型・計算・API

円金額は整数、数量・単価・率はDecimalです。APIではDecimalをJSON文字列として送受信します。会社コードを先頭にした複合主キーと、承認済予算・発注の改定履歴を保持します。

| メソッド | URL | 用途 |
|---|---|---|
| GET | `/api/v1/health` | DB接続を含む稼働確認 |
| POST | `/api/v1/auth/login` | ログイン（`{company_code,user_id,password}` → 200＋Set-Cookie） |
| POST | `/api/v1/auth/logout` | ログアウト（204、サーバー側セッション削除） |
| GET | `/api/v1/auth/me` | ログイン中の利用者（`{company_code,user_id,display_name,role}`） |
| GET | `/api/v1/cockpit` | 工事枝番別の原価集計 |
| GET | `/api/v1/lookups` | 入力用辞書・契約条件 |
| POST | `/api/v1/costs/subcontract-progress` | 外注出来高 |
| POST | `/api/v1/costs/direct-entry` | 材料・経費 |
| POST | `/api/v1/costs/daily-report` | 出面日報 |
| POST | `/api/v1/costs/equipment-movement` | 資機材出庫 |

health・login・logout 以外は要ログイン（未認証401 `UNAUTHORIZED`、権限不足・会社越境403 `FORBIDDEN`）。取得APIの会社コード `company_code` は省略時ログイン中の会社です。コックピットは `project_code` と `branch_code` でも絞り込めます。登録成功は201と伝票番号・警告一覧、業務入力不正は422、対象不存在は404、発注履歴の競合は409です。

## CI

GitHub Actions（`.github/workflows/ci.yml`）が、pull request と main への push で次を実行します。

| ジョブ | 内容 |
|---|---|
| Anchor Audit | アンカー4ファイルが `artifacts/anchor-hashes.json` のSHA256と一致すること |
| Backend Test | `cargo test --locked`（Rust 1.80） |
| Frontend Build | `npm ci` → `npm run typecheck` → `npm run build` |
| Auth Integration | `scripts/test_auth.ps1`（専用Composeプロジェクトで2社×3役割・既存DBへの起動時移行。結果JSONはジョブの成果物） |

## 検証と制約

`scripts/verify_gate.ps1 -Session 1..5` が契約改変・禁止パターン・各段階の試験を検査します。検証結果は `artifacts/` に記録します。API受入試験は検証専用DBへ試験用レコードを作成・削除するため、実データがある環境では実行しないでください。認証の結合試験は `pwsh -File scripts/test_auth.ps1` です。専用のComposeプロジェクト `progenba-authtest`（ポート18081、別ボリューム、DBパスワードと試験用利用者のパスワードは実行ごとに乱数）を作成し、`scripts/test_api.mjs`（ログイン対応版）と `scripts/test_auth.mjs` を実行して結果を `artifacts/acceptance-api-auth.json`・`artifacts/auth-acceptance.json` に書き、最後に `docker compose -p progenba-authtest down -v --rmi local` でその専用環境だけを削除します。稼働中の `progenba` プロジェクトには触れません。

監査ログ、画面での利用者管理、マスタ・予算・発注の編集画面、実データ移行は今回の対象外です。バックアップは手動取得と別DBへの復元検証まで（定期実行の登録は未設定）です。認証はHTTP上のCookieセッションであり、通信の暗号化（HTTPS）は含みません。完成区分1は承認権限のみ警告付き登録、2と3は登録不可です。監理技術者の金額警告は提供資料の検証用設定であり、現行法への適合判定ではありません。

旧システムの解析資産は参照資料として保持し、新システムから実行しません。
