//! 起動時に適用する追加スキーマ（冪等）
//!
//! 001（業務テーブル）は initdb でのみ投入する。002 以降は「新規構築では initdb、
//! 既存DBではアプリ起動時に同じSQLを適用」の2経路で同じ結果になるよう、各ファイルを冪等に書く。
//! 適用は番号順。どれかが失敗したらアプリは起動しない（呼出側で終了する）。

use sqlx::{Executor, PgPool};

use crate::api::{auth, revisions};

/// 起動時に番号順で適用するマイグレーション（ファイル名, SQL）
pub const STARTUP_MIGRATIONS: &[(&str, &str)] = &[
    ("002_auth.sql", auth::AUTH_MIGRATION_SQL),
    ("003_revision_workflow.sql", revisions::REVISION_MIGRATION_SQL),
];

/// 全ての起動時マイグレーションを順に適用する。失敗したファイル名を返す（詳細・接続文字列は出さない）。
pub async fn apply_startup_migrations(pool: &PgPool) -> Result<(), &'static str> {
    for (name, sql) in STARTUP_MIGRATIONS {
        // 引数なしの単純問い合わせで複数文（BEGIN … COMMIT）を実行する
        if pool.execute(*sql).await.is_err() {
            return Err(name);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_migrations_are_ordered_idempotent_and_follow_conventions() {
        let names: Vec<&str> = STARTUP_MIGRATIONS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "番号順に適用すること");
        for (name, sql) in STARTUP_MIGRATIONS {
            let code: String = sql
                .lines()
                .map(|l| l.split("--").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n")
                .to_ascii_uppercase();
            for banned in ["FLOAT", "REAL", "DOUBLE", "SERIAL", "UUID", "DROP ", "ALTER TABLE", "TRUNCATE"] {
                assert!(!code.contains(banned), "{}: 禁止語 {} を使用しない", name, banned);
            }
            // 冪等: テーブル・索引は IF NOT EXISTS、関数・トリガーは OR REPLACE
            assert_eq!(code.matches("CREATE TABLE ").count(), code.matches("CREATE TABLE IF NOT EXISTS").count(), "{}", name);
            assert_eq!(
                code.matches("CREATE INDEX ").count() + code.matches("CREATE UNIQUE INDEX ").count(),
                code.matches("INDEX IF NOT EXISTS").count(),
                "{}",
                name
            );
            assert!(!code.contains("CREATE FUNCTION") && !code.contains("CREATE TRIGGER"), "{}: OR REPLACE を使う", name);
            // 業務テーブル（001）を変更しない
            for business in ["EXECUTION_BUDGETS", "SUBCONTRACT_ORDERS", "PROJECT_BRANCHES", "PROJECT_MASTERS"] {
                assert!(!code.contains(&format!("ON {}", business)), "{}: 業務テーブル {} に手を加えない", name, business);
            }
            assert!(code.contains("PG_ADVISORY_XACT_LOCK"), "{}: 同時起動に備えて直列化する", name);
        }
        let rev = revisions::REVISION_MIGRATION_SQL.to_ascii_uppercase();
        assert!(rev.contains("CREATE TABLE IF NOT EXISTS REVISION_EVENTS"));
        assert!(rev.contains("PRIMARY KEY (COMPANY_CODE, EVENT_NO)"));
    }
}
