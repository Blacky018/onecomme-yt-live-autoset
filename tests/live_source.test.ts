import { describe, expect, it } from "vitest";
import { LiveSource, TOKEN_MARGIN_MS, type TokenApi, type YouTubeApi } from "../src/app/live_source";
import type { TokenResponse } from "../src/domain/oauth";
import { err, ok, type Result } from "../src/domain/result";
import { DEFAULT_SETTINGS, type Settings } from "../src/domain/settings";
import type { TokenError } from "../src/infra/google_oauth";
import type { YouTubeError } from "../src/infra/youtube_client";

const API: Settings = { ...DEFAULT_SETTINGS, apiKey: "AIzaKEY", channel: "@me", serviceId: "svc" };
const OAUTH: Settings = {
  ...DEFAULT_SETTINGS,
  authMode: "oauth",
  oauthClientId: "1-a.apps.googleusercontent.com",
  oauthClientSecret: "GOCSPX-secret",
  refreshToken: "1//refresh-token",
  serviceId: "svc",
};

class FakeYouTube implements YouTubeApi {
  resolveCalls = 0;
  publicResult: Result<string | null, YouTubeError> = ok("publicLive1");
  myResults: Array<Result<string | null, YouTubeError>> = [];
  tokensUsed: string[] = [];
  async resolveChannel(apiKey: string) {
    expect(apiKey).toBe("AIzaKEY");
    this.resolveCalls += 1;
    return ok({ channelId: "UCx", uploadsPlaylistId: "UUx" });
  }
  async findPublicLive(_k: string, playlist: string) {
    expect(playlist).toBe("UUx");
    return this.publicResult;
  }
  async findMyLive(token: string) {
    this.tokensUsed.push(token);
    return this.myResults.shift() ?? ok("myLive00001");
  }
}

class FakeTokens implements TokenApi {
  calls = 0;
  next: Result<TokenResponse, TokenError> | null = null;
  async refresh(client: { clientId: string; clientSecret: string }, refreshToken: string) {
    expect(client).toEqual({ clientId: OAUTH.oauthClientId, clientSecret: OAUTH.oauthClientSecret });
    expect(refreshToken).toBe(OAUTH.refreshToken);
    this.calls += 1;
    return this.next ?? ok({ accessToken: `access-${this.calls}`, expiresInSec: 3600, refreshToken: null });
  }
}

function setup() {
  const yt = new FakeYouTube();
  const tokens = new FakeTokens();
  let now = 0;
  let invalid = 0;
  const source = new LiveSource(yt, tokens, () => now, () => (invalid += 1));
  return { yt, tokens, source, advance: (ms: number) => (now += ms), invalidCount: () => invalid };
}

describe("LiveSource（API キー方式）", () => {
  it("チャンネル情報は入力が変わるまで使い回す", async () => {
    const { yt, source } = setup();
    expect(await source.findLive(API)).toEqual({ ok: true, value: "publicLive1" });
    await source.findLive(API);
    expect(yt.resolveCalls).toBe(1);
    await source.findLive({ ...API, channel: "@other" });
    expect(yt.resolveCalls).toBe(2);
  });
  it("チャンネル指定が不正ならエラー", async () => {
    const { source } = setup();
    expect(await source.findLive({ ...API, channel: "https://example.com" })).toEqual({ ok: false, error: "bad-channel" });
  });
});

describe("LiveSource（Google ログイン方式）", () => {
  it("アクセストークンを取って自分の配信を探す", async () => {
    const { yt, source } = setup();
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: "myLive00001" });
    expect(yt.tokensUsed).toEqual(["access-1"]);
  });

  it("期限内はトークンを使い回し、期限の少し前に取り直す", async () => {
    const { yt, tokens, source, advance } = setup();
    await source.findLive(OAUTH);
    advance(3600_000 - TOKEN_MARGIN_MS - 1);
    await source.findLive(OAUTH);
    expect(tokens.calls).toBe(1);
    advance(2);
    await source.findLive(OAUTH);
    expect(tokens.calls).toBe(2);
    expect(yt.tokensUsed).toEqual(["access-1", "access-1", "access-2"]);
  });

  it("401 なら 1 回だけ取り直して再試行", async () => {
    const { yt, tokens, source } = setup();
    yt.myResults = [err("unauthorized"), ok("myLive00001")];
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: "myLive00001" });
    expect(tokens.calls).toBe(2);
  });

  it("リフレッシュトークンが無効なら再ログインを求めて通知", async () => {
    const { tokens, source, invalidCount } = setup();
    tokens.next = err("invalid-grant");
    expect(await source.findLive(OAUTH)).toEqual({ ok: false, error: "auth-required" });
    expect(invalidCount()).toBe(1);
  });

  it.each([
    ["invalid-client", "bad-client"],
    ["network", "token-network"],
    ["bad-response", "token-other"],
  ] as const)("トークン更新の失敗 %s → %s", async (tokenError, sourceError) => {
    const { tokens, source, invalidCount } = setup();
    tokens.next = err(tokenError);
    expect(await source.findLive(OAUTH)).toEqual({ ok: false, error: sourceError });
    expect(invalidCount()).toBe(0);
  });
});
