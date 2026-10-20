# 別環境でサンプルから使い始める

## 引継ぎ方法

別PCへ引き継ぐのはリポジトリのソースです。元PCのコンテナ、`.env`、DBダンプ、ローカル画像・ログの退避先を必要資材にしません。移行先でアプリをビルドし、空のPostgreSQLボリュームにリポジトリ内のDDLとサンプルを投入します。

2026-10-21の確認時点では、元PCのDBは原価4方式の伝票がすべて0件でした。新規DBへ同じDDL・シードを投入し、全14テーブルの件数と全行の内容を照合した結果も一致しました。この時点のデータには移行すべき追加登録がないため、新規構築を選択しています。この判断後に業務データを登録したDBには、そのまま適用しないでください。

## 手順

DockerとCompose v2、Gitを用意します。WindowsはDocker DesktopのLinuxコンテナとPowerShell 7、Linux/macOSはPOSIX shとcurlを使用します。ホストへRust・Node・PostgreSQLを追加する必要はありません。

```sh
git clone https://github.com/benihisago41/ProGenba.git
cd ProGenba
```

Windows:

```powershell
pwsh -File scripts/start_local.ps1
```

Linux/macOS:

```sh
sh scripts/start_local.sh
```

初回はインターネット経由でイメージと依存を取得し、Rustと画面をビルドするため時間がかかります。「すぐ使う」は元PCでのデータ準備や個別インストールを省けるという意味で、ビルドが数秒で終わる保証ではありません。既存の.envやDBボリュームは削除しません。

## 移行先での完了確認

1. `docker compose ps`でアプリが稼働し、DBがhealthyになる。
2. `http://127.0.0.1:8080/api/v1/health`が正常応答する。
3. `http://127.0.0.1:8080`でサンプル工事、本工事・追加工事、予算が表示される。
4. 自分の検証用入力を登録し、原価と集計に反映される。
5. `docker compose restart`後も、その入力と集計が残る。

そのPCで1〜5を確認して初めて「移行先で起動・登録・永続化まで確認済み」と判断します。過去の合格JSONや、元PCが動いている事実で代用しません。2026-10-21に元PCとは別のWindows実機で1〜5を確認済みです（`fresh-start.json`の`physical_other_pc_verification`）。Linux/macOS実機とOS別の実運用は未検証です。

## 証拠と障害確認

- リポジトリの`artifacts/fresh-start.json`は、実施した環境と確認範囲を記録します。旧DBとの照合や独立した新規Docker資産での再現を、別PC実機での試験と区別します。
- 元PCの退避ログ・画像は開発履歴であり、新規構築の入力ではありません。GitHubで共有されるJSON・仕様・ソースだけで、手順と過去の確認内容を参照できます。
- 移行先の障害は、そのPCで`docker compose logs --tail 100 app db`を取得して調べます。`.env`、DBパスワード、実データをそのまま公開リポジトリや外部ログへ貼り付けないでください。
- ポート8080が使用中なら.envのAPP_PORTを変更して再実行します。Dockerが止まっている場合は起動して再実行します。古い環境や他者のボリュームを削除して解決しません。

今回の成果物は限定社内検証用です。認証・権限、利用者受入、実データのバックアップ復元など、その後の指示は`NEXT_ACTIONS.md`を参照してください。
