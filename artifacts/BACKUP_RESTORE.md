# バックアップと復元

## 方針（テスト段階）

| 項目 | 決定 |
|---|---|
| 運用責任者・実行者・失敗時連絡先 | 開発者本人（テスト段階のため1名） |
| 方式 | `pg_dump -Fc`（論理バックアップ）。稼働中DBへは読み取りのみ |
| 保存先 | `%OneDrive%\ProGenba-backups`（リポジトリ外。OneDrive同期でPC外にも写しが残る） |
| 取得頻度・RPO | 手動または1日1回。最大24時間分の入力を失う可能性を許容 |
| 保持 | 7世代（`-Keep`で変更可） |
| RTO | 目標は置かず、復元検証のたびに実測して記録 |

本番運用へ進む場合は、保存先・RPO/RTO・担当を改めて決め直す。ダンプには業務データが含まれるため、公開リポジトリや外部ログに置かない。

## バックアップ

```powershell
pwsh -File scripts/backup_db.ps1
```

- `progenba_<UTC時刻>.dump` と同名の `.sha256` を作る。保存先がリポジトリ内なら拒否する。
- 保持数を超えた古い世代は、このスクリプトの命名規則に一致するファイルだけを削除する。
- 保存先を変えるときは `-BackupDir <フォルダ>` を付ける。

## 復元の検証（別の空DBへ）

```powershell
pwsh -File scripts/restore_db.ps1 -Cleanup
```

1. 最新のダンプ（または `-DumpFile`）のSHA256を確認し、不一致なら中止する。
2. `progenba-restore-*` の名前とラベル `progenba.restore-test=true` を持つ専用のネットワーク・ボリューム・DBコンテナを新規作成し、`pg_restore` で復元する。空DB作成から復元完了までを復旧時間として計測する。
3. `scripts/compare_restore.sql` で、稼働DBと復元DBの全テーブルの件数・全行のダイジェスト、制約・トリガー・関数・インデックスを照合する。
4. 同じアプリイメージを復元DBへ向けて `127.0.0.1:18080` で起動し、全会社のコックピットAPIの応答を稼働系と完全一致で比較する。
5. `-Cleanup` を付けると、ラベル付きの検証資産だけを削除する。前回の資産が残っている場合は作成前に停止するので、内容を確認してから `-CleanupOnly` で削除する。

稼働DBへ入力が続いている間に実行すると、バックアップ後の入力が差分として出る。照合は入力のない時間帯に行う。

## 本当に復元するとき（稼働DBの置き換え）

検証用の復元とは別の、稼働データを置き換える作業であり、実行前に必ず直近のダンプを取得する。

1. `pwsh -File scripts/backup_db.ps1` で現状を退避する。
2. `pwsh -File scripts/restore_db.ps1 -DumpFile <戻したいダンプ>` で、戻したいダンプが壊れていないことを別DBで確認する（確認後 `-CleanupOnly`）。
3. `docker compose stop app` でアプリを止める。
4. `docker compose cp <ダンプ> db:/tmp/restore.dump` の後、`docker compose exec -T db pg_restore -U sirius -d sirius_reborn --clean --if-exists --no-owner --exit-on-error /tmp/restore.dump` を実行する。
5. `docker compose start app` で再開し、コックピットの値を確認する。
6. 失敗したら手順1のダンプで同じ手順を繰り返して元に戻す。`progenba_pgdata` ボリュームは削除しない。

## 失敗時の確認

- バックアップ失敗：`docker compose ps`、`docker compose logs --tail 100 db`、保存先の空き容量とOneDriveの同期状態。
- 復元検証失敗：出力された差分行を確認する。資産は `-Cleanup` を付けない限り残るので、`docker exec progenba-restore-db psql -U sirius -d sirius_reborn` で調べられる。
- 秘密（`.env`、DBパスワード）とダンプの中身をGitや外部ログへ貼らない。

## 記録

実施結果は `artifacts/backup-restore.json` に残す。
