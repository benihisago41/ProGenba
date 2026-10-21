mod api;

use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let database_url = match std::env::var("DATABASE_URL") {
        Ok(val) if !val.trim().is_empty() => val,
        _ => {
            tracing::error!("環境変数 DATABASE_URL が設定されていません");
            std::process::exit(1);
        }
    };

    // 002_auth.sql・003_revision_workflow.sql（いずれも冪等）を番号順に適用する。
    // 既存DB（initdb 済みボリューム）でも認証テーブル・操作履歴テーブルを用意するため。
    // 失敗時は詳細（接続文字列等）を出さずに終了する。
    let pool = connect_pool(&database_url).await;
    if let Err(name) = api::schema::apply_startup_migrations(&pool).await {
        tracing::error!("起動時スキーマ（{}）の適用に失敗しました", name);
        std::process::exit(1);
    }

    // 管理用サブコマンド: add-user（パスワードは標準入力から受け取り、引数・ログに出さない）
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(cmd) = args.first() {
        if cmd == "add-user" {
            match api::auth::run_add_user(&pool, &args[1..]).await {
                Ok(msg) => {
                    println!("{}", msg);
                    std::process::exit(0);
                }
                Err(msg) => {
                    eprintln!("エラー: {}", msg);
                    std::process::exit(2);
                }
            }
        }
        eprintln!("不明なサブコマンドです（利用可能: add-user）");
        std::process::exit(2);
    }

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let app = api::router(pool);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Listening on http://{}", addr);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("ポートのバインドに失敗しました: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("サーバー実行中にエラーが発生しました: {}", e);
        std::process::exit(1);
    }
}

async fn connect_pool(database_url: &str) -> sqlx::PgPool {
    match PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await
    {
        Ok(p) => p,
        Err(_) => {
            tracing::error!("データベースへの接続に失敗しました");
            std::process::exit(1);
        }
    }
}
