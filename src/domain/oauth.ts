import { err, isRecord, ok, type Result } from "./result";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export const CLIENT_ID = /^[0-9A-Za-z_-]{1,120}\.apps\.googleusercontent\.com$/;
export const CLIENT_SECRET = /^[A-Za-z0-9_-]{8,120}$/;
const TOKEN = /^[\x21-\x7e]{10,2048}$/;

export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthUrl(p: AuthUrlParams): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_READONLY_SCOPE);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // リフレッシュトークンを毎回確実に受け取るため
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export type CallbackError = "state" | "denied" | "missing-code" | "not-callback";

// ループバックで受けたリクエストのパス+クエリを検証してコードを取り出す
export function parseCallback(pathAndQuery: string, expectedState: string): Result<string, CallbackError> {
  let url: URL;
  try {
    url = new URL(pathAndQuery, "http://127.0.0.1");
  } catch {
    return err("not-callback");
  }
  if (url.pathname !== "/") return err("not-callback");
  const q = url.searchParams;
  if (!q.has("state") && !q.has("code") && !q.has("error")) return err("not-callback");
  if (q.get("state") !== expectedState) return err("state");
  if (q.has("error")) return err("denied");
  const code = q.get("code");
  if (code === null || code === "" || code.length > 2048) return err("missing-code");
  return ok(code);
}

export interface TokenResponse {
  accessToken: string;
  expiresInSec: number;
  refreshToken: string | null;
}

export function parseTokenResponse(body: unknown): Result<TokenResponse> {
  if (!isRecord(body)) return err("bad-response");
  const access = body["access_token"];
  const expires = body["expires_in"];
  const refresh = body["refresh_token"];
  if (typeof access !== "string" || !TOKEN.test(access)) return err("bad-response");
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return err("bad-response");
  if (refresh !== undefined && (typeof refresh !== "string" || !TOKEN.test(refresh))) return err("bad-response");
  return ok({ accessToken: access, expiresInSec: expires, refreshToken: typeof refresh === "string" ? refresh : null });
}

export type TokenErrorKind = "invalid-grant" | "invalid-client" | "other";

export function classifyTokenError(body: unknown): TokenErrorKind {
  const e = isRecord(body) ? body["error"] : undefined;
  if (e === "invalid_grant") return "invalid-grant";
  if (e === "invalid_client" || e === "unauthorized_client") return "invalid-client";
  return "other";
}

export function isStoredToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN.test(v);
}
