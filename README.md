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
2. 画面とサンプルデータの確認:
   ブラウザで <http://127.0.0.1:8080> を開き、「青葉台レジデンス新築工事」のコックピットとサンプル予算が表示されれば合格です。

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

## 使い方

- コックピットで工事と本工事／追加工事／工事全体を選び、実行予算・発注確定・実際原価・着地予想・見込粗利を確認します。
- かんたん入力で外注出来高、品目カード、出面日報、資機材出庫を登録します。登録後はコックピットを再取得します。
- 出来高の進捗率は累計です。前回までの査定額を引いて今回額を計算します。プレビューは概算であり、登録時にサーバーで再計算します。
- 労務原価は標準日額を8時間で割った概算です。月次確定賃金の按分関数はありますが、その確定入力画面・APIは今回含みません。

サンプルは「青葉台レジデンス新築工事」の本工事と第1回追加工事です。材料・経費、作業員、資機材、外注発注を投入済みで、初期の実際原価は0円です。

## 型・計算・API

円金額は整数、数量・単価・率はDecimalです。APIではDecimalをJSON文字列として送受信します。会社コードを先頭にした複合主キーと、承認済予算・発注の改定履歴を保持します。

| メソッド | URL | 用途 |
|---|---|---|
| GET | `/api/v1/health` | DB接続を含む稼働確認 |
| GET | `/api/v1/cockpit` | 工事枝番別の原価集計 |
| GET | `/api/v1/lookups` | 入力用辞書・契約条件 |
| POST | `/api/v1/costs/subcontract-progress` | 外注出来高 |
| POST | `/api/v1/costs/direct-entry` | 材料・経費 |
| POST | `/api/v1/costs/daily-report` | 出面日報 |
| POST | `/api/v1/costs/equipment-movement` | 資機材出庫 |

取得APIの会社コードは `company_code`（既定 `0000`）。コックピットは `project_code` と `branch_code` でも絞り込めます。登録成功は201と伝票番号・警告一覧、業務入力不正は422、対象不存在は404、発注履歴の競合は409です。

## 検証と制約

`scripts/verify_gate.ps1 -Session 1..5` が契約改変・禁止パターン・各段階の試験を検査します。検証結果は `artifacts/` に記録します。API受入試験は検証専用DBへ試験用レコードを作成・削除するため、実データがある環境では実行しないでください。

認証・権限、監査ログ、マスタ・予算・発注の編集画面、実データ移行、バックアップ運用は今回の対象外です。会社コードによるデータ分離は認証の代わりにはなりません。完成区分1は警告付き登録、2と3は登録不可です。監理技術者の金額警告は提供資料の検証用設定であり、現行法への適合判定ではありません。

旧システムの解析資産は参照資料として保持し、新システムから実行しません。
