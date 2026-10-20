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

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let pool = match PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
    {
        Ok(p) => p,
        Err(_) => {
            tracing::error!("データベースへの接続に失敗しました");
            std::process::exit(1);
        }
    };

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
