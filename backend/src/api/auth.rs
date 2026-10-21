//! 認証・権限・会社境界（Phase 3）
//!
//! - ログイン: 会社コード＋利用者ID＋パスワード（Argon2id ハッシュで照合）
//! - セッション: サーバー側（app_sessions）。Cookie にはランダムトークンのみを載せ、
//!   DB にはトークンの SHA-256 だけを保存する。無操作8時間で失効（アクセスごとに延長）。
//! - 役割: viewer（閲覧）< registrar（登録）< approver（承認：完成区分'1'への登録可）
//! - 会社境界: クライアントが送る company_code は信頼せず、セッションの会社と一致しなければ 403。
//!
//! 秘密（パスワード・トークン・DATABASE_URL）はログへ出力しない。

use argon2::{
    password_hash::{rand_core::OsRng, rand_core::RngCore, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::sync::OnceLock;

use crate::api::{ApiError, AppJson, AppState};

/// セッションCookie名
pub const SESSION_COOKIE: &str = "progenba_session";
/// 無操作失効までの時間（時間）
pub const IDLE_TIMEOUT_HOURS: i32 = 8;
/// 連続失敗でロックするまでの回数
pub const MAX_FAILED_LOGINS: i32 = 5;
/// 一時ロックの長さ（分）
pub const LOCK_MINUTES: i32 = 15;
/// パスワード長の上限（巨大入力によるハッシュ計算負荷を防ぐ）
const MAX_PASSWORD_CHARS: usize = 256;
/// 管理スクリプトで設定するパスワードの最小長
pub const MIN_PASSWORD_CHARS: usize = 12;

/// 002 マイグレーション（冪等）。既存DBにはアプリ起動時に適用する。
pub const AUTH_MIGRATION_SQL: &str = include_str!("../../../migrations/002_auth.sql");

const LOGIN_FAILED_MESSAGE: &str = "会社コード・利用者ID・パスワードのいずれかが正しくありません";

// ---------------------------------------------------------------------------
// 役割
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Registrar,
    Approver,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Registrar => "registrar",
            Self::Approver => "approver",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "viewer" => Some(Self::Viewer),
            "registrar" => Some(Self::Registrar),
            "approver" => Some(Self::Approver),
            _ => None,
        }
    }

    /// 原価4方式の登録（未成工事）が可能か
    pub fn can_register_cost(self) -> bool {
        matches!(self, Self::Registrar | Self::Approver)
    }

    /// 完成区分'1'（完成）工事への登録が可能か
    pub fn can_register_completed(self) -> bool {
        matches!(self, Self::Approver)
    }
}

// ---------------------------------------------------------------------------
// 認証済みコンテキスト（extractor）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub company_code: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub role: Role,
}

impl AuthContext {
    /// クライアント指定の company_code をセッションの会社と照合し、問い合わせに使う会社コードを返す。
    /// 省略（None・空文字）はセッションの会社。異なる値は 403。
    pub fn resolve_company(&self, requested: Option<&str>) -> Result<String, ApiError> {
        match requested.map(str::trim).filter(|s| !s.is_empty()) {
            None => Ok(self.company_code.clone()),
            Some(c) if c == self.company_code => Ok(self.company_code.clone()),
            Some(_) => Err(ApiError::Forbidden(
                "ログイン中の会社以外のデータにはアクセスできません".to_string(),
            )),
        }
    }

    /// 原価登録権限（registrar 以上）を要求する
    pub fn require_cost_registration(&self) -> Result<(), ApiError> {
        if self.role.can_register_cost() {
            Ok(())
        } else {
            Err(ApiError::Forbidden(
                "閲覧権限の利用者は原価を登録できません（登録・承認権限が必要です）".to_string(),
            ))
        }
    }

    /// 完成区分'1'の工事への登録権限（approver）を要求する
    pub fn require_completed_registration(&self) -> Result<(), ApiError> {
        if self.role.can_register_completed() {
            Ok(())
        } else {
            Err(ApiError::Forbidden(
                "完成区分が「完成(1)」の工事への原価登録は承認権限の利用者のみ可能です".to_string(),
            ))
        }
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthContext {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = session_token_from_headers(&parts.headers).ok_or_else(unauthorized)?;
        let token_hash = hash_token(&token);

        // 有効期限内のセッションだけを延長し、同じ文で利用者・会社・役割を取得する
        let row = sqlx::query(
            r#"
            UPDATE app_sessions s
               SET last_seen_at = now(),
                   expires_at = now() + make_interval(hours => $2)
              FROM app_users u
             WHERE s.token_hash = $1
               AND s.expires_at > now()
               AND u.company_code = s.company_code
               AND u.user_id = s.user_id
               AND u.is_active = TRUE
            RETURNING s.company_code, s.user_id, u.display_name, u.role
            "#,
        )
        .bind(&token_hash)
        .bind(IDLE_TIMEOUT_HOURS)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(unauthorized)?;

        let role_str: String = row.try_get("role")?;
        let role = Role::parse(&role_str).ok_or(ApiError::Internal)?;
        Ok(AuthContext {
            company_code: row.try_get::<String, _>("company_code")?.trim().to_string(),
            user_id: row.try_get("user_id")?,
            display_name: row.try_get("display_name")?,
            role,
        })
    }
}

fn unauthorized() -> ApiError {
    ApiError::Unauthorized("ログインが必要です（セッションが無効か期限切れです）".to_string())
}

// ---------------------------------------------------------------------------
// トークン・Cookie
// ---------------------------------------------------------------------------

/// 256ビットの乱数トークン（16進64文字）
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    to_hex(&bytes)
}

pub fn hash_token(token: &str) -> String {
    to_hex(&Sha256::digest(token.as_bytes()))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn is_valid_token_format(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Cookie ヘッダーからセッショントークンを取り出す（形式不正は無視）
pub fn session_token_from_headers(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(s) = value.to_str() else { continue };
        for pair in s.split(';') {
            let mut it = pair.trim().splitn(2, '=');
            let (Some(name), Some(val)) = (it.next(), it.next()) else { continue };
            if name.trim() == SESSION_COOKIE {
                let v = val.trim();
                if is_valid_token_format(v) {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// Set-Cookie 値。有効期限はサーバー側で管理するためブラウザ側はセッションCookieとする。
pub fn build_session_cookie(token: &str, secure: bool) -> String {
    format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/{}",
        SESSION_COOKIE,
        token,
        if secure { "; Secure" } else { "" }
    )
}

pub fn build_clear_cookie(secure: bool) -> String {
    format!(
        "{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{}",
        SESSION_COOKIE,
        if secure { "; Secure" } else { "" }
    )
}

/// Cookie の Secure 属性。
/// 既定は off: 本システムは社内LAN/ローカルの HTTP で運用しており、Secure を付けると
/// ブラウザが HTTP では Cookie を送らずログインできなくなるため。HTTPS 終端の背後で
/// 運用する場合は SESSION_COOKIE_SECURE=true を設定する。
pub fn cookie_secure_from_env() -> bool {
    std::env::var("SESSION_COOKIE_SECURE")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// パスワード（Argon2id）
// ---------------------------------------------------------------------------

pub fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| ApiError::Internal)
}

pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    match PasswordHash::new(stored_hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// 利用者不在時にも同じ重さの照合を行うためのダミーハッシュ（起動ごとに乱数から生成）
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password(&generate_token()).unwrap_or_default())
}

async fn verify_password_blocking(password: String, stored_hash: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || match stored_hash {
        Some(h) => verify_password(&password, &h),
        None => {
            // タイミング差を小さくするためのダミー照合（結果は常に失敗扱い）
            let _ = verify_password(&password, dummy_hash());
            false
        }
    })
    .await
    .unwrap_or(false)
}

fn is_valid_company_code(code: &str) -> bool {
    code.len() == 4 && code.chars().all(|c| c.is_ascii_alphanumeric())
}

pub fn is_valid_user_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// ---------------------------------------------------------------------------
// マイグレーション
// ---------------------------------------------------------------------------

// 002_auth.sql の適用は api::schema::apply_startup_migrations（003 以降と同じ経路）で行う。

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub company_code: String,
    pub user_id: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub company_code: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub role: Role,
}

impl From<&AuthContext> for MeResponse {
    fn from(a: &AuthContext) -> Self {
        Self {
            company_code: a.company_code.clone(),
            user_id: a.user_id.clone(),
            display_name: a.display_name.clone(),
            role: a.role,
        }
    }
}

fn login_failed() -> ApiError {
    ApiError::Unauthorized(LOGIN_FAILED_MESSAGE.to_string())
}

/// POST /api/v1/auth/login
pub async fn login(
    State(state): State<AppState>,
    AppJson(req): AppJson<LoginRequest>,
) -> Result<Response, ApiError> {
    let company_code = req.company_code.trim().to_string();
    let user_id = req.user_id.trim().to_string();
    let password = req.password;

    let well_formed = is_valid_company_code(&company_code)
        && is_valid_user_id(&user_id)
        && !password.is_empty()
        && password.chars().count() <= MAX_PASSWORD_CHARS;
    if !well_formed {
        // 形式不正でも照合1回分の時間をかけてから同じ 401 を返す
        let _ = verify_password_blocking(password.chars().take(MAX_PASSWORD_CHARS).collect(), None).await;
        return Err(login_failed());
    }

    let row = sqlx::query(
        r#"
        SELECT password_hash, role, display_name, is_active,
               (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
        FROM app_users
        WHERE company_code = $1 AND user_id = $2
        "#,
    )
    .bind(&company_code)
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        let _ = verify_password_blocking(password, None).await;
        return Err(login_failed());
    };

    let stored_hash: String = row.try_get("password_hash")?;
    let role_str: String = row.try_get("role")?;
    let display_name: Option<String> = row.try_get("display_name")?;
    let is_active: bool = row.try_get("is_active")?;
    let is_locked: bool = row.try_get("is_locked")?;

    let password_ok = verify_password_blocking(password, Some(stored_hash)).await;

    if !is_active || is_locked {
        // 無効・ロック中は正誤にかかわらず同じ 401（失敗回数は加算しない）
        return Err(login_failed());
    }

    if !password_ok {
        let locked = sqlx::query(
            r#"
            UPDATE app_users
               SET failed_login_count = CASE WHEN failed_login_count + 1 >= $3 THEN 0
                                             ELSE failed_login_count + 1 END,
                   locked_until = CASE WHEN failed_login_count + 1 >= $3
                                       THEN now() + make_interval(mins => $4)
                                       ELSE locked_until END,
                   updated_at = now()
             WHERE company_code = $1 AND user_id = $2
            RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS now_locked
            "#,
        )
        .bind(&company_code)
        .bind(&user_id)
        .bind(MAX_FAILED_LOGINS)
        .bind(LOCK_MINUTES)
        .fetch_optional(&state.pool)
        .await?
        .map(|r| r.try_get::<bool, _>("now_locked").unwrap_or(false))
        .unwrap_or(false);
        if locked {
            tracing::warn!("連続ログイン失敗により利用者を一時ロックしました");
        }
        return Err(login_failed());
    }

    let role = Role::parse(&role_str).ok_or(ApiError::Internal)?;
    let token = generate_token();
    let token_hash = hash_token(&token);

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE app_users
           SET failed_login_count = 0, locked_until = NULL, updated_at = now()
         WHERE company_code = $1 AND user_id = $2
        "#,
    )
    .bind(&company_code)
    .bind(&user_id)
    .execute(&mut *tx)
    .await?;
    // 期限切れセッションの掃除
    sqlx::query("DELETE FROM app_sessions WHERE expires_at <= now()")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO app_sessions (company_code, token_hash, user_id, created_at, last_seen_at, expires_at)
        VALUES ($1, $2, $3, now(), now(), now() + make_interval(hours => $4))
        "#,
    )
    .bind(&company_code)
    .bind(&token_hash)
    .bind(&user_id)
    .bind(IDLE_TIMEOUT_HOURS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let me = MeResponse {
        company_code,
        user_id,
        display_name,
        role,
    };
    let cookie = HeaderValue::from_str(&build_session_cookie(&token, state.cookie_secure))
        .map_err(|_| ApiError::Internal)?;
    let mut res = (StatusCode::OK, Json(me)).into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie);
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

/// 状態変更系 POST の CSRF 対策（SameSite=Strict に加えて）:
/// Content-Type: application/json を必須にする。HTML フォームは application/json を送れず、
/// 別オリジンの fetch で JSON を送るとプリフライトが必要になる（本サーバーは CORS を許可しない）。
pub fn require_json_content_type(headers: &HeaderMap) -> Result<(), ApiError> {
    let ok = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .map(|m| m.trim().eq_ignore_ascii_case("application/json"))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "Content-Type: application/json を指定してください".to_string(),
        ))
    }
}

/// POST /api/v1/auth/logout（サーバー側のセッションを削除し Cookie を消す）
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    require_json_content_type(&headers)?;
    if let Some(token) = session_token_from_headers(&headers) {
        sqlx::query("DELETE FROM app_sessions WHERE token_hash = $1")
            .bind(hash_token(&token))
            .execute(&state.pool)
            .await?;
    }
    let cookie = HeaderValue::from_str(&build_clear_cookie(state.cookie_secure))
        .map_err(|_| ApiError::Internal)?;
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(res)
}

/// GET /api/v1/auth/me
pub async fn me(auth: AuthContext) -> Json<MeResponse> {
    Json(MeResponse::from(&auth))
}

// ---------------------------------------------------------------------------
// 管理用サブコマンド: add-user（パスワードは標準入力から1行で受け取る）
// ---------------------------------------------------------------------------

pub struct AddUserArgs {
    pub company_code: String,
    pub user_id: String,
    pub role: Role,
    pub display_name: Option<String>,
    pub update: bool,
}

pub fn parse_add_user_args(args: &[String]) -> Result<AddUserArgs, String> {
    let mut company = None;
    let mut user = None;
    let mut role = None;
    let mut display = None;
    let mut update = false;
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        let mut value = || {
            i += 1;
            args.get(i).cloned().ok_or_else(|| format!("{} の値がありません", key))
        };
        match key {
            "--company" => company = Some(value()?),
            "--user-id" => user = Some(value()?),
            "--role" => role = Some(value()?),
            "--display-name" => display = Some(value()?),
            "--update" => update = true,
            other => return Err(format!("不明な引数です: {}", other)),
        }
        i += 1;
    }
    let company_code = company.ok_or("--company は必須です")?.trim().to_string();
    if !is_valid_company_code(&company_code) {
        return Err("会社コードは4文字の英数字で指定してください".to_string());
    }
    let user_id = user.ok_or("--user-id は必須です")?.trim().to_string();
    if !is_valid_user_id(&user_id) {
        return Err("利用者IDは英数字と . _ - の1〜32文字で指定してください".to_string());
    }
    let role = Role::parse(&role.ok_or("--role は必須です（viewer/registrar/approver）")?)
        .ok_or("--role は viewer / registrar / approver のいずれかです")?;
    let display_name = display.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if display_name.as_deref().is_some_and(|d| d.chars().count() > 60) {
        return Err("表示名は60文字以内で指定してください".to_string());
    }
    Ok(AddUserArgs {
        company_code,
        user_id,
        role,
        display_name,
        update,
    })
}

pub fn validate_new_password(password: &str) -> Result<(), String> {
    let n = password.chars().count();
    if n < MIN_PASSWORD_CHARS {
        return Err(format!("パスワードは{}文字以上にしてください", MIN_PASSWORD_CHARS));
    }
    if n > MAX_PASSWORD_CHARS {
        return Err(format!("パスワードは{}文字以内にしてください", MAX_PASSWORD_CHARS));
    }
    if password.chars().any(|c| c.is_control()) {
        return Err("パスワードに制御文字は使用できません".to_string());
    }
    Ok(())
}

/// 標準入力1行目をパスワードとして読み、利用者を作成（--update 時は更新）する。
pub async fn run_add_user(pool: &PgPool, args: &[String]) -> Result<String, String> {
    let a = parse_add_user_args(args)?;
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|_| "標準入力からパスワードを読み取れませんでした".to_string())?;
    let password = line.trim_end_matches(['\r', '\n']).to_string();
    line.clear();
    validate_new_password(&password)?;
    let password_hash = hash_password(&password).map_err(|_| "ハッシュ化に失敗しました".to_string())?;
    drop(password);

    let mut tx = pool.begin().await.map_err(|_| "DB接続に失敗しました".to_string())?;
    let affected = if a.update {
        let r = sqlx::query(
            r#"
            UPDATE app_users
               SET password_hash = $3, role = $4,
                   display_name = COALESCE($5, display_name),
                   is_active = TRUE, failed_login_count = 0, locked_until = NULL, updated_at = now()
             WHERE company_code = $1 AND user_id = $2
            "#,
        )
        .bind(&a.company_code)
        .bind(&a.user_id)
        .bind(&password_hash)
        .bind(a.role.as_str())
        .bind(&a.display_name)
        .execute(&mut *tx)
        .await
        .map_err(|_| "利用者の更新に失敗しました".to_string())?
        .rows_affected();
        if r == 1 {
            // パスワード・役割変更時は既存セッションを全て失効させる
            sqlx::query("DELETE FROM app_sessions WHERE company_code = $1 AND user_id = $2")
                .bind(&a.company_code)
                .bind(&a.user_id)
                .execute(&mut *tx)
                .await
                .map_err(|_| "既存セッションの削除に失敗しました".to_string())?;
        }
        r
    } else {
        sqlx::query(
            r#"
            INSERT INTO app_users (company_code, user_id, display_name, password_hash, role)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (company_code, user_id) DO NOTHING
            "#,
        )
        .bind(&a.company_code)
        .bind(&a.user_id)
        .bind(&a.display_name)
        .bind(&password_hash)
        .bind(a.role.as_str())
        .execute(&mut *tx)
        .await
        .map_err(|_| "利用者の作成に失敗しました".to_string())?
        .rows_affected()
    };
    if affected != 1 {
        return Err(if a.update {
            "指定の利用者が存在しません（新規作成は --update なしで実行してください）".to_string()
        } else {
            "同じ会社コード・利用者IDの利用者が既に存在します（変更は --update を指定）".to_string()
        });
    }
    tx.commit().await.map_err(|_| "DBへの確定に失敗しました".to_string())?;
    Ok(format!(
        "利用者を{}しました: 会社 {} / 利用者ID {} / 役割 {}",
        if a.update { "更新" } else { "作成" },
        a.company_code,
        a.user_id,
        a.role.as_str()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(role: Role) -> AuthContext {
        AuthContext {
            company_code: "0000".to_string(),
            user_id: "u1".to_string(),
            display_name: None,
            role,
        }
    }

    #[test]
    fn password_hash_and_verify() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$"), "Argon2id で保存すること");
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("correct horse batterY", &h));
        assert!(!verify_password("correct horse battery", "not-a-phc-string"));
        // 同じパスワードでもソルトが異なる
        assert_ne!(h, hash_password("correct horse battery").unwrap());
    }

    #[test]
    fn role_permissions() {
        assert!(!Role::Viewer.can_register_cost());
        assert!(Role::Registrar.can_register_cost());
        assert!(Role::Approver.can_register_cost());
        assert!(!Role::Viewer.can_register_completed());
        assert!(!Role::Registrar.can_register_completed());
        assert!(Role::Approver.can_register_completed());
        assert!(matches!(ctx(Role::Viewer).require_cost_registration(), Err(ApiError::Forbidden(_))));
        assert!(ctx(Role::Registrar).require_cost_registration().is_ok());
        assert!(matches!(
            ctx(Role::Registrar).require_completed_registration(),
            Err(ApiError::Forbidden(_))
        ));
        assert!(ctx(Role::Approver).require_completed_registration().is_ok());
        assert_eq!(Role::parse("approver"), Some(Role::Approver));
        assert_eq!(Role::parse("admin"), None);
        assert_eq!(serde_json::to_string(&Role::Registrar).unwrap(), "\"registrar\"");
    }

    #[test]
    fn company_code_boundary() {
        let a = ctx(Role::Approver);
        assert_eq!(a.resolve_company(None).unwrap(), "0000");
        assert_eq!(a.resolve_company(Some("")).unwrap(), "0000");
        assert_eq!(a.resolve_company(Some(" 0000 ")).unwrap(), "0000");
        assert!(matches!(a.resolve_company(Some("9001")), Err(ApiError::Forbidden(_))));
        assert!(matches!(a.resolve_company(Some("000")), Err(ApiError::Forbidden(_))));
    }

    #[test]
    fn token_and_cookie_handling() {
        let t = generate_token();
        assert!(is_valid_token_format(&t));
        assert_ne!(t, generate_token());
        let h = hash_token(&t);
        assert_eq!(h.len(), 64);
        assert_ne!(h, t);
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("a=1; {}={}; b=2", SESSION_COOKIE, t)).unwrap(),
        );
        assert_eq!(session_token_from_headers(&headers), Some(t.clone()));
        let mut bad = HeaderMap::new();
        bad.insert(header::COOKIE, HeaderValue::from_static("progenba_session=XYZ"));
        assert_eq!(session_token_from_headers(&bad), None);

        let c = build_session_cookie(&t, false);
        assert!(c.contains("HttpOnly") && c.contains("SameSite=Strict") && c.contains("Path=/"));
        assert!(!c.contains("Secure"));
        assert!(build_session_cookie(&t, true).ends_with("; Secure"));
        assert!(build_clear_cookie(false).contains("Max-Age=0"));
    }

    #[test]
    fn json_content_type_required() {
        let mut h = HeaderMap::new();
        assert!(require_json_content_type(&h).is_err());
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert!(require_json_content_type(&h).is_err());
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
        assert!(require_json_content_type(&h).is_ok());
    }

    #[test]
    fn add_user_argument_validation() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let a = parse_add_user_args(&s(&["--company", "0000", "--user-id", "genba.01", "--role", "registrar"])).unwrap();
        assert_eq!(a.company_code, "0000");
        assert_eq!(a.role, Role::Registrar);
        assert!(!a.update);
        assert!(parse_add_user_args(&s(&["--company", "00", "--user-id", "x", "--role", "viewer"])).is_err());
        assert!(parse_add_user_args(&s(&["--company", "0000", "--user-id", "a b", "--role", "viewer"])).is_err());
        assert!(parse_add_user_args(&s(&["--company", "0000", "--user-id", "x", "--role", "admin"])).is_err());
        assert!(parse_add_user_args(&s(&["--company", "0000", "--user-id", "x", "--role", "viewer", "--password", "p"])).is_err());
        assert!(validate_new_password("short").is_err());
        assert!(validate_new_password("long-enough-pass").is_ok());
        assert!(validate_new_password("long-enough\u{7}pass").is_err());
    }

    #[test]
    fn migration_follows_conventions() {
        let sql: String = AUTH_MIGRATION_SQL
            .lines()
            .map(|l| l.split("--").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
            .to_ascii_uppercase();
        for banned in ["FLOAT", "REAL", "DOUBLE", "SERIAL", "UUID"] {
            assert!(!sql.contains(banned), "禁止型 {} を使用しない", banned);
        }
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS APP_USERS"));
        assert!(sql.contains("PRIMARY KEY (COMPANY_CODE, USER_ID)"));
        assert!(sql.contains("PRIMARY KEY (COMPANY_CODE, TOKEN_HASH)"));
    }
}
