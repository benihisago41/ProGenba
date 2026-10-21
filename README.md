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
- 「予算・発注」タブで、工事・枝番の登録、実行予算と外注発注の案の作成・改定と承認を行います（[予算・発注の登録と承認](#予算発注の登録と承認)）。承認した版だけがコックピットと出来高登録に反映されます。

サンプルは「青葉台レジデンス新築工事」の本工事と第1回追加工事です。材料・経費、作業員、資機材、外注発注を投入済みで、初期の実際原価は0円です。

## 認証・権限・会社境界

ログインは **会社コード（4桁）＋利用者ID＋パスワード** です。1利用者は1会社・1役割に所属します。画面での利用者管理はありません。

※ `CONVENTIONS.md`（ロック済みアンカー）の「権限承認は今回未対応」「認証・権限は未対応」は、Phase 3 以前の歴史的な記述です。現在の仕様は本章が正です。

| 役割 | 値 | できること |
|---|---|---|
| 閲覧 | `viewer` | コックピット・入力用辞書・予算・発注の閲覧のみ（原価登録API・案の作成は403） |
| 登録 | `registrar` | 閲覧＋原価4方式の登録（未成工事＝完成区分0）＋予算・発注の案の作成・編集・削除。完成区分1の工事への原価登録は403 |
| 承認 | `approver` | 登録＋完成区分1（完成）工事への登録（警告付き201）＋予算・発注の案の承認・否認＋工事・枝番の登録 |

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
- 状態変更系の POST・PUT・DELETE（原価4方式・ログイン・ログアウト・予算・発注・工事の登録と承認）は `Content-Type: application/json` を必須とし、それ以外は400です。DELETE は本文なし（空）でよく、本文を付ける場合は JSON オブジェクト（`company_code` のみ解釈）です。HTMLフォームはこの形式を送れず、別オリジンのスクリプトはCORSの事前確認が必要になり、本サーバーはCORSを許可していません。

### スキーマの適用（既存DBへの移行）
- 認証テーブル `app_users`・`app_sessions` は `migrations/002_auth.sql`、予算・発注の操作履歴 `revision_events` は `migrations/003_revision_workflow.sql` です（いずれも冪等）。業務テーブル（001）は変更しません。
- 新規構築では `docker-compose.yml` の initdb で001の後に002・003の順で投入します。
- 既存DB（`progenba_pgdata` など初期化済みのボリューム）には、**アプリ起動時に同じSQLを番号順に自動適用** します（`backend/src/api/schema.rs`）。手順は通常の更新と同じです: `git pull` 後に `docker compose up -d --build`。適用に失敗した場合アプリは起動せず終了します（`docker compose logs app` で確認）。
- 更新直後は利用者が0人のため誰もログインできません。上記の `scripts/add_user.ps1` で最初の利用者を作成してください。

## 予算・発注の登録と承認

実行予算・外注発注（下請注文書）は **登録（案）→ 承認** の2段階です。承認済みの版は上書きせず、改定は履歴番号（`budget_history_no`・`order_history_no`）+1 の新しい版として作ります（CONVENTIONS の不変改定履歴）。コックピットの実行予算・発注確定額と外注出来高の登録は、従来どおり **承認済みの最新版だけ** を使うため、案は承認するまで集計に反映されません。

### 状態と遷移

業務テーブルの既存の状態列をそのまま使います（列の追加なし）。

| 状態 | 予算 `approval_status` / 発注 `order_status` | できること |
|---|---|---|
| 未承認の案 | `0` | 編集・削除（登録以上）、承認・否認（承認のみ） |
| 承認済 | `1` | なし（API は 409、DB はトリガー `forbid_approved_revision_update` が UPDATE を拒否）。改定は新しい案を作る |
| 否認 | `9` | なし（409）。新しい案を作れる。否認理由は操作履歴に残る |

- 遷移は `0 → 1`（承認）と `0 → 9`（否認）だけです。仕様書 §6.2 の `3` 申請中・`2` 確認済（多段承認）は **将来拡張** とし、今回は使いません（その状態の行は 409 で操作不可）。
- 1つのキー（予算: 会社＋工事＋枝番、発注: 会社＋注文番号）につき、**未承認の案は同時に1つまで** です（2つ目は 409）。キー単位の advisory lock の下で判定します。
- 改定案は **最新の承認済み版（予算は明細を含む）を複写** して作ります。版が1つも無い枝番の予算は履歴番号0の空の案から作ります。承認済みが無く否認済みの版だけがある場合は、その最新版を複写します。履歴番号は「全ての版の最大+1」です（否認・削除された番号と重複しない。削除した案の番号は再利用されます）。

### 権限

| 操作 | 閲覧 | 登録 | 承認 |
|---|---|---|---|
| 予算・発注・操作履歴の閲覧 | ○ | ○ | ○ |
| 案の作成・編集・削除 | 403 | ○ | ○ |
| 案の承認・否認 | 403 | 403 | ○ |
| 工事・枝番の登録 | 403 | 403 | ○（契約額・工期は原価管理の基準値のため） |

- 画面では権限のない操作のボタンを無効にし、理由を表示します。判定の正はサーバーです。
- **自己承認の方針**: 自分が作った案を自分で承認することは、テスト段階のため **許可** しています（既定）。案の作成者は操作履歴に残しているため、`.env` に `REVISION_ALLOW_SELF_APPROVAL=false` を設定してアプリを再起動すると、作成者本人の承認を 403 にできます（否認は本人でも可）。
- 完成区分2/3の枝番は、予算・発注の案の作成・編集・承認ができません（422）。完成区分1は可能です。

### 承認時の検証（単一トランザクション・関係キーの advisory lock）

- 承認時に、その案より新しい承認済みの版が無いことを確認します（あれば 409）。同時に2件の承認要求が来ても、1件は 200、もう1件は 409 になり、二重承認・履歴番号の重複は起きません。
- **予算**: ヘッダの `total_budget_amount` を、明細の `planned_amount`（`calc::calc_line_amount` = 数量×単価の小数第1位四捨五入）の合計とサーバーが一致させます。クライアントの金額・合計は受け取りません。明細0件の案は承認できません（422）。工種・費目は自社マスタに存在すること（422）。予算の改定・承認は実際原価を変えません。
- **発注**: 改定後の発注額（税抜）が、その注文の出来高査定の累計（全履歴の `progress_assessments` の合計）を下回る場合は承認できません（422。案の保存時にも同じ確認をします）。外注出来高の登録と同じロックキー（会社＋注文番号）で直列化します。消費税額 `order_tax_amount` は `floor(税抜 × tax_rate)` でサーバーが計算します。出来高査定がある注文は税率を変更できません（累計差額方式の整合のため、422）。承認済みの注文の改定では外注先・工種・工事枝番を変更できません（422。別の注文として登録）。発注区分 `order_type` は `1`（全額契約）のみです。
- 承認後は、外注出来高の登録が新しい版の履歴番号・発注額・残高で動きます（旧履歴番号での登録は従来どおり 409）。

### 注文番号の採番

新規発注の注文番号は、**入力があればその番号（英数字と `- _ /` の1〜12文字、重複は 409）**、空欄なら **`ORD-YYYY-NNN` を自動採番**（YYYY は発注日の年、NNN は同じ年の既存最大+1、会社単位の排他ロック下）します。シードの `ORD-2026-001` と同じ形式で `VARCHAR(12)` に収まります。1年999件を超える場合は 422 で手入力を求めます。

### 工事・枝番の登録

- 工事（`project_masters`）と本工事枝番 `000` を同時に登録します。追加工事枝番 `001`〜`999` は別に登録します（`000` の追加は 422、重複は 409）。
- サーバーで検証する項目: 工事コード（英数字と `- _` の1〜10文字）・名称・略称、区分値、契約工期と社内工期のそれぞれ開始≦終了、発注者は `is_customer`、現場代理人・監理技術者・主任技術者は `is_employee`（いずれも削除済みでないこと）、金額は0以上・15桁以内。受注形態は単独（`1`）のみ（JV は対象外）。登録時の完成区分は `0`。

### 操作履歴（`revision_events`、003）

作成・編集・削除・承認・否認、工事・枝番の登録を、**誰が（利用者ID・役割）・いつ・何を（対象・履歴番号）・理由（否認は必須1〜200文字、承認は任意コメント）・金額の前後** として記録します。

| 列 | 内容 |
|---|---|
| `company_code` CHAR(4), `event_no` BIGINT | 主キー。`event_no` は会社ごとに「既存最大+1」を排他ロックの下で採番（SERIAL・UUID は使わない） |
| `occurred_at`, `actor_user_id`, `actor_role` | 日時・利用者・操作時点の役割（利用者を削除しても残すため `app_users` への外部キーは張らない） |
| `target_type`, `action` | `project`/`branch`/`budget`/`order` と `create`/`update`/`delete`/`approve`/`reject` |
| `project_code`, `branch_code`, `order_number`, `history_no` | 対象のキー |
| `reason` VARCHAR(200), `amount_before`/`amount_after` NUMERIC(15,0) | 理由、金額の前後 |

- 追記専用です。トリガー `trg_revision_events_append_only` が UPDATE・DELETE を拒否し、CHECK 制約が否認の理由を必須にします。
- 業務テーブル（001）の列は追加していません。

### 残課題（今回の範囲外）

- 既存枝番の契約額・工期の変更、完成区分の変更（画面・API なし）。
- 取引先・工種・費目・資機材マスタの編集。
- 多段承認（`3` 申請中・`2` 確認済）、承認の取消し（承認済みの版を無効にする操作）。
- 「未承認の案は1つまで」は API の排他で保証しています。DB の一意制約（部分インデックス）は、既存DBへの適用時に既存データ次第で起動できなくなる危険があるため追加していません。予算明細（`execution_budget_details`）の承認後の変更は、001 のトリガーが対象外のため API でのみ防いでいます。
- 操作履歴の画面は枝番ごとの直近200件の表示のみ（検索・出力なし）。原価4方式の登録は操作履歴の対象外です。

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
| GET | `/api/v1/projects` | 工事・枝番の一覧（予算・発注の状態付き） |
| POST | `/api/v1/projects` | 工事と本工事枝番000の登録（承認権限、201） |
| POST | `/api/v1/projects/{工事}/branches` | 追加工事枝番001〜999の登録（承認権限、201） |
| GET | `/api/v1/revision-options` | 入力用の自社マスタ（工種・費目・外注先・発注者・社員） |
| GET | `/api/v1/projects/{工事}/branches/{枝番}/budget` | 実行予算: 承認済み最新版・未承認の案・差分・版一覧・操作履歴 |
| POST | `/api/v1/projects/{工事}/branches/{枝番}/budget/drafts` | 予算の案を作成（改定は承認済み版を複写、201） |
| PUT | `/api/v1/projects/{工事}/branches/{枝番}/budget/drafts/{履歴}` | 予算の案の編集（ヘッダ＋明細の置き換え） |
| DELETE | `/api/v1/projects/{工事}/branches/{枝番}/budget/drafts/{履歴}` | 予算の案の削除（204） |
| POST | `/api/v1/projects/{工事}/branches/{枝番}/budget/drafts/{履歴}/approve` | 予算の案の承認（承認権限、`{comment?}`） |
| POST | `/api/v1/projects/{工事}/branches/{枝番}/budget/drafts/{履歴}/reject` | 予算の案の否認（承認権限、`{reason}` 必須） |
| GET | `/api/v1/projects/{工事}/branches/{枝番}/orders` | 外注発注: 注文ごとの承認済み最新版・案・差分・査定累計・残高 |
| POST | `/api/v1/orders` | 新規発注の案（履歴0、注文番号は入力または自動採番、201） |
| POST | `/api/v1/orders/{注文番号}/drafts` | 発注の改定案を作成（承認済み版を複写、201） |
| PUT | `/api/v1/orders/{注文番号}/drafts/{履歴}` | 発注の案の編集 |
| DELETE | `/api/v1/orders/{注文番号}/drafts/{履歴}` | 発注の案の削除（204） |
| POST | `/api/v1/orders/{注文番号}/drafts/{履歴}/approve` | 発注の案の承認（承認権限、`{comment?}`） |
| POST | `/api/v1/orders/{注文番号}/drafts/{履歴}/reject` | 発注の案の否認（承認権限、`{reason}` 必須） |

health・login・logout 以外は要ログイン（未認証401 `UNAUTHORIZED`、権限不足・会社越境403 `FORBIDDEN`）。取得APIの会社コード `company_code` は省略時ログイン中の会社です。コックピットは `project_code` と `branch_code` でも絞り込めます。登録成功は201と伝票番号・警告一覧、業務入力不正は422、対象不存在は404、発注履歴の競合は409です。予算・発注・工事の登録と承認は、作成201・更新200・削除204、他社の工事・注文（自社に存在しないキー）は404、本文・クエリで他社の `company_code` を指定すると403、承認済み・否認済みの版の変更と案の重複は409、業務入力不正は422です。型は `backend/src/api/revisions.rs` と `frontend/src/revisions.ts`（アンカーの types.rs・bindings.ts は変更しない）。

## CI

GitHub Actions（`.github/workflows/ci.yml`）が、pull request と main への push で次を実行します。

| ジョブ | 内容 |
|---|---|
| Anchor Audit | アンカー4ファイルが `artifacts/anchor-hashes.json` のSHA256と一致すること |
| Backend Test | `cargo test --locked`（Rust 1.80） |
| Frontend Build | `npm ci` → `npm run typecheck` → `npm run build` |
| Auth Integration | `scripts/test_auth.ps1`（専用Composeプロジェクトで2社×3役割・既存DBへの起動時移行（002・003）・予算・発注の登録と承認（`scripts/test_revisions.mjs`、375px 画面確認を含む）。結果JSONと画面画像はジョブの成果物） |

## 検証と制約

`scripts/verify_gate.ps1 -Session 1..5` が契約改変・禁止パターン・各段階の試験を検査します。検証結果は `artifacts/` に記録します。API受入試験は検証専用DBへ試験用レコードを作成・削除するため、実データがある環境では実行しないでください。認証の結合試験は `pwsh -File scripts/test_auth.ps1` です。専用のComposeプロジェクト `progenba-authtest`（ポート18081、別ボリューム、DBパスワードと試験用利用者のパスワードは実行ごとに乱数）を作成し、`scripts/test_api.mjs`（ログイン対応版）と `scripts/test_auth.mjs` を実行して結果を `artifacts/acceptance-api-auth.json`・`artifacts/auth-acceptance.json` に書き、続けて試験用利用者 `revtest-*` を作って `scripts/test_revisions.mjs`（予算・発注の登録と承認、試験コンテナ内だけに Alpine の chromium と playwright-core を入れた 375px 画面確認を含む）を実行して `artifacts/revisions-acceptance.json` に書き、最後に `docker compose -p progenba-authtest down -v --rmi local` でその専用環境だけを削除します。稼働中の `progenba` プロジェクトには触れません。

監査ログ（予算・発注・工事登録の操作履歴 `revision_events` を除く）、画面での利用者管理、マスタ（取引先・工種・費目・資機材）の編集画面、既存枝番の契約額・工期・完成区分の変更、実データ移行は今回の対象外です。バックアップは手動取得と別DBへの復元検証まで（定期実行の登録は未設定）です。認証はHTTP上のCookieセッションであり、通信の暗号化（HTTPS）は含みません。完成区分1は承認権限のみ警告付き登録、2と3は登録不可です。監理技術者の金額警告は提供資料の検証用設定であり、現行法への適合判定ではありません。

旧システムの解析資産は参照資料として保持し、新システムから実行しません。
