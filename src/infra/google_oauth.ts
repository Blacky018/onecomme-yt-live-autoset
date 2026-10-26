import { classifyTokenError, parseTokenResponse, REVOKE_ENDPOINT, TOKEN_ENDPOINT, type TokenErrorKind, type TokenResponse } from "../domain/oauth";
import { err, type Result } from "../domain/result";
import { requestJson, type FetchLike } from "./http";

export type TokenError = TokenErrorKind | "network" | "bad-response";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

// Google のトークンエンドポイント。コード・トークン・シークレットはログに出さないこと
export class GoogleOAuth {
  constructor(private readonly fetchFn: FetchLike) {}

  exchangeCode(client: OAuthClient, code: string, codeVerifier: string, redirectUri: string): Promise<Result<TokenResponse, TokenError>> {
    return this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
  }

  refresh(client: OAuthClient, refreshToken: string): Promise<Result<TokenResponse, TokenError>> {
    return this.token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
  }

  // ログアウト時。失敗しても手元のトークンは消すので結果は気にしない
  async revoke(token: string): Promise<void> {
    try {
      await requestJson(this.fetchFn, REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch {
      // 無視
    }
  }

  private async token(form: Record<string, string>): Promise<Result<TokenResponse, TokenError>> {
    let res;
    try {
      res = await requestJson(this.fetchFn, TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      return err("network");
    }
    if (res.status !== 200) return err(classifyTokenError(res.body));
    const parsed = parseTokenResponse(res.body);
    return parsed.ok ? parsed : err("bad-response");
  }
}
