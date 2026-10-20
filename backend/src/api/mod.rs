pub mod actual_costs;
pub mod projects;

use axum::{
    extract::{rejection::JsonRejection, FromRequest, Request, State},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use sirius_reborn_backend::domain::types::ErrorResponse;
use sqlx::PgPool;
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
}

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
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
    let state = AppState { pool };

    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "./static".to_string());
    let index_file = PathBuf::from(&static_dir).join("index.html");
    let serve_dir = ServeDir::new(&static_dir).not_found_service(ServeFile::new(index_file));

    Router::new()
        .route("/api/v1/health", get(health_check))
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
        .route("/api", axum::routing::any(api_not_found))
        .route("/api/*path", axum::routing::any(api_not_found))
        .fallback_service(serve_dir)
        .with_state(state)
}
