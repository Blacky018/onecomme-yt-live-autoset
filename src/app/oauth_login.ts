import { buildAuthUrl, CLIENT_ID, CLIENT_SECRET, parseCallback, type TokenResponse } from "../domain/oauth";
import { err, ok, type Result } from "../domain/result";
import type { OAuthClient, TokenError } from "../infra/google_oauth";
import type { CallbackHandler, LoopbackServer, Pkce } from "../infra/loopback";

export interface OAuthLoginDeps {
  startServer(handler: CallbackHandler): Promise<LoopbackServer>;
  exchange(client: OAuthClient, code: string, verifier: string, redirectUri: string): Promise<Result<TokenResponse, TokenError>>;
  pkce(): Pkce;
  state(): string;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  // ログイン成功（リフレッシュトークンを保存する）
  onToken(refreshToken: string): void;
  log(msg: string): void;
}

export type LoginState = "idle" | "waiting" | "done" | "error";

export interface LoginStatus {
  state: LoginState;
  message: string;
}

export const LOGIN_TIMEOUT_MS = 5 * 60_000;

const DONE = { handled: true, title: "ログインしました", message: "このタブを閉じて、わんコメの設定画面に戻ってください。" };
const FAILED = (message: string) => ({ handled: true, title: "ログインできませんでした", message });

const EXCHANGE_ERROR: Record<TokenError, string> = {
  "invalid-grant": "認可コードが使えませんでした。もう一度ログインしてください",
  "invalid-client": "OAuth クライアント ID かシークレットが正しくありません",
  network: "Google に接続できませんでした",
  "bad-response": "Google から想定外の応答がありました",
  other: "Google でエラーが起きました",
};

// 「Google でログイン」1 回分の流れ（ループバックで戻りを受けてトークンに交換）
export class OAuthLogin {
  private session: { server: LoopbackServer; timer: unknown } | null = null;
  private status: LoginStatus = { state: "idle", message: "" };

  constructor(private readonly deps: OAuthLoginDeps) {}

  getStatus(): LoginStatus {
    return { ...this.status };
  }

  // 認可 URL を返す。前のログインが途中なら打ち切ってやり直す
  async start(client: OAuthClient): Promise<Result<string, string>> {
    if (!CLIENT_ID.test(client.clientId) || !CLIENT_SECRET.test(client.clientSecret)) {
      return err("OAuth クライアント ID とシークレットを保存してから押してください");
    }
    this.cancel();
    const pkce = this.deps.pkce();
    const state = this.deps.state();
    let finished = false;
    let server: LoopbackServer | null = null;

    const handler: CallbackHandler = async (pathAndQuery) => {
      const cb = parseCallback(pathAndQuery, state);
      if (!cb.ok && cb.error === "not-callback") return { handled: false, title: "", message: "" };
      // 偽の state は無視して本物の戻りを待ち続ける
      if (!cb.ok && cb.error === "state") return { handled: false, title: "", message: "" };
      if (finished || !server) return FAILED("このログインは終了しています。設定画面からやり直してください。");
      finished = true;
      // 応答はループバック側が送り終えてから自分で閉じる
      this.endSession(false);
      if (!cb.ok) {
        this.status = { state: "error", message: cb.error === "denied" ? "ログインがキャンセルされました" : "Google から認可コードが届きませんでした" };
        return FAILED(this.status.message);
      }
      const token = await this.deps.exchange(client, cb.value, pkce.verifier, server.redirectUri);
      if (!token.ok) {
        this.status = { state: "error", message: EXCHANGE_ERROR[token.error] };
        this.deps.log(`login failed: ${token.error}`);
        return FAILED(this.status.message);
      }
      if (token.value.refreshToken === null) {
        this.status = { state: "error", message: "Google からリフレッシュトークンが届きませんでした。もう一度ログインしてください" };
        return FAILED(this.status.message);
      }
      this.deps.onToken(token.value.refreshToken);
      this.status = { state: "done", message: "ログインしました" };
      this.deps.log("login succeeded");
      return DONE;
    };

    try {
      server = await this.deps.startServer(handler);
    } catch {
      this.status = { state: "error", message: "ログイン用の受け口を開けませんでした" };
      return err(this.status.message);
    }
    const timer = this.deps.setTimeout(() => {
      if (finished) return;
      finished = true;
      this.endSession(true);
      this.status = { state: "error", message: "時間切れです。もう一度「Google でログイン」を押してください" };
    }, LOGIN_TIMEOUT_MS);
    this.session = { server, timer };
    this.status = { state: "waiting", message: "ブラウザで Google にログインして許可してください" };
    return ok(buildAuthUrl({ clientId: client.clientId, redirectUri: server.redirectUri, state, codeChallenge: pkce.challenge }));
  }

  cancel(): void {
    this.endSession(true);
    if (this.status.state === "waiting") this.status = { state: "idle", message: "" };
  }

  private endSession(closeServer: boolean): void {
    if (!this.session) return;
    this.deps.clearTimeout(this.session.timer);
    if (closeServer) this.session.server.close();
    this.session = null;
  }
}
