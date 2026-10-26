import { parseChannelInput, type ChannelRef } from "../domain/channel";
import type { TokenResponse } from "../domain/oauth";
import { err, ok, type Result } from "../domain/result";
import type { Settings } from "../domain/settings";
import type { ChannelInfo } from "../domain/youtube_parse";
import type { OAuthClient, TokenError } from "../infra/google_oauth";
import type { YouTubeError } from "../infra/youtube_client";

export interface YouTubeApi {
  resolveChannel(apiKey: string, ref: ChannelRef): Promise<Result<ChannelInfo, YouTubeError>>;
  findPublicLive(apiKey: string, uploadsPlaylistId: string): Promise<Result<string | null, YouTubeError>>;
  findMyLive(accessToken: string): Promise<Result<string | null, YouTubeError>>;
}

export interface TokenApi {
  refresh(client: OAuthClient, refreshToken: string): Promise<Result<TokenResponse, TokenError>>;
}

export type SourceError = YouTubeError | "bad-channel" | "auth-required" | "bad-client" | "token-network" | "token-other";

// アクセストークンは期限の少し前に取り直す
export const TOKEN_MARGIN_MS = 60_000;

// 設定の方式に合わせて「配信中の動画 ID」を探す
export class LiveSource {
  private channelCache: { key: string; info: ChannelInfo } | null = null;
  private tokenCache: { refreshToken: string; accessToken: string; expiresAt: number } | null = null;

  constructor(
    private readonly youtube: YouTubeApi,
    private readonly tokens: TokenApi,
    private readonly now: () => number,
    // リフレッシュトークンが無効になった（取り消された・期限切れ）
    private readonly onAuthInvalid: () => void,
  ) {}

  clearToken(): void {
    this.tokenCache = null;
  }

  findLive(s: Settings): Promise<Result<string | null, SourceError>> {
    return s.authMode === "oauth" ? this.findWithOAuth(s) : this.findWithApiKey(s);
  }

  private async findWithApiKey(s: Settings): Promise<Result<string | null, SourceError>> {
    const key = `${s.apiKey}\n${s.channel}`;
    let info = this.channelCache?.key === key ? this.channelCache.info : null;
    if (info === null) {
      const ref = parseChannelInput(s.channel);
      if (!ref.ok) return err("bad-channel");
      const r = await this.youtube.resolveChannel(s.apiKey, ref.value);
      if (!r.ok) return r;
      info = r.value;
      this.channelCache = { key, info };
    }
    return this.youtube.findPublicLive(s.apiKey, info.uploadsPlaylistId);
  }

  private async findWithOAuth(s: Settings): Promise<Result<string | null, SourceError>> {
    const token = await this.accessToken(s);
    if (!token.ok) return token;
    const r = await this.youtube.findMyLive(token.value);
    if (r.ok || r.error !== "unauthorized") return r;
    // アクセストークンが先に失効していた → 1 回だけ取り直す
    this.tokenCache = null;
    const again = await this.accessToken(s);
    if (!again.ok) return again;
    return this.youtube.findMyLive(again.value);
  }

  private async accessToken(s: Settings): Promise<Result<string, SourceError>> {
    const c = this.tokenCache;
    if (c && c.refreshToken === s.refreshToken && c.expiresAt - TOKEN_MARGIN_MS > this.now()) return ok(c.accessToken);
    const r = await this.tokens.refresh({ clientId: s.oauthClientId, clientSecret: s.oauthClientSecret }, s.refreshToken);
    if (!r.ok) {
      this.tokenCache = null;
      if (r.error === "invalid-grant") {
        this.onAuthInvalid();
        return err("auth-required");
      }
      if (r.error === "invalid-client") return err("bad-client");
      return err(r.error === "network" ? "token-network" : "token-other");
    }
    this.tokenCache = {
      refreshToken: s.refreshToken,
      accessToken: r.value.accessToken,
      expiresAt: this.now() + r.value.expiresInSec * 1000,
    };
    return ok(r.value.accessToken);
  }
}
