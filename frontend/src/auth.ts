// 認証（Phase 3）用の型と通信ヘルパー。
// bindings.ts（ロック済アンカー）は変更せず、認証関連の型はこのファイルに置く。

/** 役割: viewer=閲覧, registrar=登録（未成工事）, approver=承認（完成区分1への登録も可） */
export type Role = "viewer" | "registrar" | "approver";

/** GET /api/v1/auth/me・POST /api/v1/auth/login の応答 */
export interface MeResponse {
  company_code: string;
  user_id: string;
  display_name: string | null;
  role: Role;
}

export interface LoginRequest {
  company_code: string;
  user_id: string;
  password: string;
}

export const AUTH_ENDPOINTS = {
  LOGIN: "/api/v1/auth/login",
  LOGOUT: "/api/v1/auth/logout",
  ME: "/api/v1/auth/me",
} as const;

export function roleLabel(role: Role): string {
  switch (role) {
    case "viewer":
      return "閲覧";
    case "registrar":
      return "登録";
    case "approver":
      return "承認";
  }
}

export function canRegisterCost(role: Role): boolean {
  return role === "registrar" || role === "approver";
}

export function canRegisterCompleted(role: Role): boolean {
  return role === "approver";
}

// API が 401 を返したときに呼ぶ処理（App がログイン画面へ戻す処理を登録する）
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/**
 * 業務APIの共通 fetch。
 * - credentials: "same-origin" を明示し、同一オリジンの HttpOnly セッションCookie を送る
 *   （別オリジンへは送らない）。
 * - 401 を受けたら登録済みハンドラでログイン画面へ戻す。応答はそのまま呼出側へ返す。
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "same-origin" });
  if (res.status === 401 && unauthorizedHandler) {
    unauthorizedHandler();
  }
  return res;
}

/** 現在のセッション利用者。未ログイン（401）は null。 */
export async function fetchMe(): Promise<MeResponse | null> {
  const res = await fetch(AUTH_ENDPOINTS.ME, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`ログイン状態の確認に失敗しました（HTTP ${res.status}）`);
  }
  return (await res.json()) as MeResponse;
}

export async function login(req: LoginRequest): Promise<MeResponse> {
  const res = await fetch(AUTH_ENDPOINTS.LOGIN, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let message = `ログインに失敗しました（HTTP ${res.status}）`;
    try {
      const err = (await res.json()) as { message?: unknown };
      if (typeof err.message === "string" && err.message.trim() !== "") {
        message = err.message;
      }
    } catch {
      // JSON でない応答は既定文言を使う
    }
    throw new Error(message);
  }
  return (await res.json()) as MeResponse;
}

export async function logout(): Promise<void> {
  // 状態変更系 POST は Content-Type: application/json が必須（CSRF 対策）
  await fetch(AUTH_ENDPOINTS.LOGOUT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}
