pub mod actual_costs;
pub mod auth;
pub mod projects;
pub mod revisions;
pub mod schema;

use axum::{
    extract::{rejection::JsonRejection, FromRequest, Request, State},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use sirius_reborn_backend::domain::types::ErrorResponse;
use sqlx::PgPool;
use std::path::PathBuf;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeader,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// セッションCookieに Secure 属性を付けるか（SESSION_COOKIE_SECURE、既定 off）
    pub cookie_secure: bool,
}

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    Unprocessable(String),
    Internal,
}

impl From<sqlx::Error> for ApiError {
    fn from(_err: sqlx::Error) -> Self {
        tracing::error!("Database operation failed");
        Self::Internal
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, "BAD_REQUEST", msg),
            Self::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", msg),
            Self::Forbidden(msg) => (StatusCode::FORBIDDEN, "FORBIDDEN", msg),
            Self::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg),
            Self::Conflict(msg) => (StatusCode::CONFLICT, "CONFLICT", msg),
            Self::Unprocessable(msg) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "UNPROCESSABLE_ENTITY",
                msg,
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "サーバー内部エラーが発生しました".to_string(),
            ),
        };
        (
            status,
            Json(ErrorResponse {
                code: code.to_string(),
                message,
            }),
        )
            .into_response()
    }
}

pub struct AppJson<T>(pub T);

#[axum::async_trait]
impl<S, T> FromRequest<S> for AppJson<T>
where
    axum::Json<T>: FromRequest<S, Rejection = JsonRejection>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(Json(val)) => Ok(Self(val)),
            Err(rejection) => {
                let msg = format!("JSONリクエストの形式が不正です: {}", rejection.body_text());
                match rejection {
                    JsonRejection::JsonDataError(_) => Err(ApiError::Unprocessable(msg)),
                    _ => Err(ApiError::BadRequest(msg)),
                }
            }
        }
    }
}

async fn health_check(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn api_not_found(uri: Uri) -> Response {
    ApiError::NotFound(format!("指定されたAPIエンドポイントが存在しません: {}", uri.path()))
        .into_response()
}

pub fn router(pool: PgPool) -> Router {
    let state = AppState {
        pool,
        cookie_secure: auth::cookie_secure_from_env(),
    };

    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "./static".to_string());
    let index_file = PathBuf::from(&static_dir).join("index.html");
    let serve_dir = ServeDir::new(&static_dir).not_found_service(ServeFile::new(index_file));
    // 画面ファイルは毎回サーバーへ確認させる（no-cache）。キャッシュした古い index.html が
    // 更新後に存在しない旧バンドルを参照し、画面が真っ白になるのを防ぐ。
    // 変更がなければ Last-Modified による 304 応答で済むため、転送量はほぼ増えない。
    let serve_dir = SetResponseHeader::overriding(
        serve_dir,
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-cache"),
    );

    Router::new()
        // 認証不要: health と login/logout。それ以外の業務APIは AuthContext で 401/403 を判定する。
        .route("/api/v1/health", get(health_check))
        .route("/api/v1/auth/login", post(auth::login))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/auth/me", get(auth::me))
        .route("/api/v1/cockpit", get(projects::get_cockpit))
        .route("/api/v1/lookups", get(projects::get_lookups))
        .route(
            "/api/v1/costs/subcontract-progress",
            post(actual_costs::submit_subcontract_progress),
        )
        .route(
            "/api/v1/costs/direct-entry",
            post(actual_costs::submit_direct_cost),
        )
        .route(
            "/api/v1/costs/daily-report",
            post(actual_costs::submit_daily_report),
        )
        .route(
            "/api/v1/costs/equipment-movement",
            post(actual_costs::submit_equipment_movement),
        )
        // 予算・発注の登録と承認（Phase 4）。状態を変える POST/PUT/DELETE は Content-Type: application/json 必須。
        .route(
            "/api/v1/projects",
            get(revisions::list_projects).post(revisions::create_project),
        )
        .route(
            "/api/v1/projects/:project_code/branches",
            post(revisions::create_branch),
        )
        .route("/api/v1/revision-options", get(revisions::get_revision_options))
        .route(
            "/api/v1/projects/:project_code/branches/:branch_code/budget",
            get(revisions::get_branch_budget),
        )
        .route(
            "/api/v1/projects/:project_code/branches/:branch_code/budget/drafts",
            post(revisions::create_budget_draft),
        )
        .route(
            "/api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no",
            put(revisions::update_budget_draft).delete(revisions::delete_budget_draft),
        )
        .route(
            "/api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no/approve",
            post(revisions::approve_budget_draft),
        )
        .route(
            "/api/v1/projects/:project_code/branches/:branch_code/budget/drafts/:history_no/reject",
            post(revisions::reject_budget_draft),
        )
        .route(
            "/api/v1/projects/:project_code/branches/:branch_code/orders",
            get(revisions::get_branch_orders),
        )
        .route("/api/v1/orders", post(revisions::create_order))
        .route(
            "/api/v1/orders/:order_number/drafts",
            post(revisions::create_order_revision),
        )
        .route(
            "/api/v1/orders/:order_number/drafts/:history_no",
            put(revisions::update_order_draft).delete(revisions::delete_order_draft),
        )
        .route(
            "/api/v1/orders/:order_number/drafts/:history_no/approve",
            post(revisions::approve_order_draft),
        )
        .route(
            "/api/v1/orders/:order_number/drafts/:history_no/reject",
            post(revisions::reject_order_draft),
        )
        .route("/api", axum::routing::any(api_not_found))
        .route("/api/*path", axum::routing::any(api_not_found))
        .fallback_service(serve_dir)
        .with_state(state)
}
