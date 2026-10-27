import { parseChannelInput, type ChannelRef } from "../domain/channel";
import type { TokenResponse } from "../domain/oauth";
import { err, ok, type Result } from "../domain/result";
import type { Settings } from "../domain/settings";
import { chooseUpcoming, type ChannelInfo, type Upcoming } from "../domain/youtube_parse";
import type { OAuthClient, TokenError } from "../infra/google_oauth";
import type { PublicLookup, YouTubeError } from "../infra/youtube_client";

export interface YouTubeApi {
  resolveChannel(apiKey: string, ref: ChannelRef): Promise<Result<ChannelInfo, YouTubeError>>;
  findPublicLive(apiKey: string, uploadsPlaylistId: string): Promise<Result<PublicLookup, YouTubeError>>;
  findMyLive(accessToken: string): Promise<Result<string | null, YouTubeError>>;
  findMyUpcoming(accessToken: string): Promise<Result<Upcoming[], YouTubeError>>;
}

// セットする枠。live = 配信中、upcoming = 開始前の予約枠
export interface Target {
  videoId: string;
  kind: "live" | "upcoming";
}

export interface TokenApi {
  refresh(client: OAuthClient, refreshToken: string): Promise<Result<TokenResponse, TokenError>>;
}

export type SourceError = YouTubeError | "bad-channel" | "auth-required" | "bad-client" | "token-network" | "token-other";

// アクセストークンは期限の少し前に取り直す
export const TOKEN_MARGIN_MS = 60_000;

// 設定の方式に合わせて「セットする枠」を探す。配信中の枠が最優先、なければ（設定がオンなら）予約枠
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

  findLive(s: Settings): Promise<Result<Target | null, SourceError>> {
    return s.authMode === "oauth" ? this.findWithOAuth(s) : this.findWithApiKey(s);
  }

  private pickTarget(live: string | null, upcoming: readonly Upcoming[], s: Settings): Target | null {
    if (live !== null) return { videoId: live, kind: "live" };
    if (!s.presetUpcoming) return null;
    const id = chooseUpcoming(upcoming, this.now());
    return id === null ? null : { videoId: id, kind: "upcoming" };
  }

  private async findWithApiKey(s: Settings): Promise<Result<Target | null, SourceError>> {
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
    const r = await this.youtube.findPublicLive(s.apiKey, info.uploadsPlaylistId);
    if (!r.ok) return r;
    return ok(this.pickTarget(r.value.live, r.value.upcoming, s));
  }

  private async findWithOAuth(s: Settings): Promise<Result<Target | null, SourceError>> {
    const live = await this.withToken(s, (t) => this.youtube.findMyLive(t));
    if (!live.ok) return live;
    if (live.value !== null || !s.presetUpcoming) return ok(this.pickTarget(live.value, [], s));
    // 配信中がないときだけ予約枠を見る（+1 unit）
    const upcoming = await this.withToken(s, (t) => this.youtube.findMyUpcoming(t));
    if (!upcoming.ok) return upcoming;
    return ok(this.pickTarget(null, upcoming.value, s));
  }

  // アクセストークンを付けて呼ぶ。401 なら（先に失効していた）1 回だけ取り直して再試行
  private async withToken<T>(s: Settings, call: (token: string) => Promise<Result<T, YouTubeError>>): Promise<Result<T, SourceError>> {
    const token = await this.accessToken(s);
    if (!token.ok) return token;
    const r = await call(token.value);
    if (r.ok || r.error !== "unauthorized") return r;
    this.tokenCache = null;
    const again = await this.accessToken(s);
    if (!again.ok) return again;
    return call(again.value);
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
