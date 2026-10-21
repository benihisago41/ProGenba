// 通信・API エラーの利用者向け案内。何が起きたか・入力は保持されているか・次に何をすればよいかを1か所で決める。
// 判定は HTTP ステータス（サーバーが正）。本文の message はサーバーの説明として添える。

/** HTTP ステータス付きのエラー（data.ts・useCostDraft.ts が投げる。revisions.ts の ApiRequestError も status を持つ） */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface Guidance {
  intent: "error" | "warning";
  /** 何が起きたか（MessageBar の見出し） */
  title: string;
  /** サーバーの説明と、入力の保持状況・次の操作 */
  body: string;
}

export function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * @param action 失敗した操作（例「登録」「承認」「読み込み」）
 * @param kept 入力の保持状況（例「入力内容は保持しています。」）。読み込みなど入力のない操作は空文字
 */
export function describeFailure(error: unknown, action: string, kept: string): Guidance {
  const status = statusOf(error);
  const server = error instanceof Error && error.message ? error.message : "";
  const detail = (text: string) => [server && `サーバーの説明：${server}`, kept, text].filter(Boolean).join(" ");
  // fetch の通信失敗は TypeError（サーバーに届いていない・応答を受け取れていない）
  if (error instanceof TypeError) {
    return { intent: "error", title: `サーバーに接続できず、${action}できませんでした`, body: [kept, "通信状況を確認して、もう一度お試しください。"].filter(Boolean).join(" ") };
  }
  if (status === null) {
    return { intent: "error", title: `${action}できませんでした`, body: detail("「更新」で最新の状態を確認してから、もう一度お試しください。") };
  }
  switch (status) {
    case 401:
      return { intent: "warning", title: "ログインの有効期限が切れました", body: "入力内容は保持しています。同じ会社・利用者で再ログインしてから操作してください。" };
    case 403:
      return { intent: "error", title: `権限がないため、${action}できませんでした`, body: detail("権限のある利用者に依頼するか、管理者に権限をご確認ください。") };
    case 404:
      return { intent: "error", title: `対象が見つからず、${action}できませんでした`, body: detail("他の利用者が削除した可能性があります。「更新」で最新の状態を確認してください。") };
    case 409:
      return { intent: "warning", title: `他の操作と重なったため、${action}できませんでした`, body: detail("最新の状態を確認し、必要ならもう一度操作してください。") };
    case 422:
      return { intent: "error", title: `入力内容を確認してください（${action}できませんでした）`, body: detail("該当する項目を直してから、もう一度操作してください。") };
    default:
      return { intent: "error", title: `サーバーでエラーが発生し、${action}できませんでした（HTTP ${status}）`, body: detail("時間をおいてもう一度お試しください。続く場合は管理者にご連絡ください。") };
  }
}

/** 1行の文に組み立てる（文字列の状態として持つ画面用） */
export function guidanceText(g: Guidance): string {
  return `${g.title}。${g.body}`;
}
