import { describe, expect, it } from "vitest";
import { LiveSource, TOKEN_MARGIN_MS, type TokenApi, type YouTubeApi } from "../src/app/live_source";
import type { TokenResponse } from "../src/domain/oauth";
import { err, ok, type Result } from "../src/domain/result";
import { DEFAULT_SETTINGS, type Settings } from "../src/domain/settings";
import type { TokenError } from "../src/infra/google_oauth";
import type { Upcoming } from "../src/domain/youtube_parse";
import type { PublicLookup, YouTubeError } from "../src/infra/youtube_client";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const SOON: Upcoming = { id: "soon0000001", scheduledMs: NOW + 3600_000 };
const LATER: Upcoming = { id: "later000001", scheduledMs: NOW + 3 * 86400_000 };
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
  publicResult: Result<PublicLookup, YouTubeError> = ok({ live: "publicLive1", upcoming: [] });
  myResults: Array<Result<string | null, YouTubeError>> = [];
  myUpcoming: Result<Upcoming[], YouTubeError> = ok([]);
  upcomingCalls = 0;
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
  async findMyUpcoming(token: string) {
    this.tokensUsed.push(`upcoming:${token}`);
    this.upcomingCalls += 1;
    return this.myUpcoming;
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
  let now = NOW;
  let invalid = 0;
  const source = new LiveSource(yt, tokens, () => now, () => (invalid += 1));
  return { yt, tokens, source, advance: (ms: number) => (now += ms), invalidCount: () => invalid };
}

describe("LiveSource（API キー方式）", () => {
  it("チャンネル情報は入力が変わるまで使い回す", async () => {
    const { yt, source } = setup();
    expect(await source.findLive(API)).toEqual({ ok: true, value: { videoId: "publicLive1", kind: "live" } });
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
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: { videoId: "myLive00001", kind: "live" } });
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
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: { videoId: "myLive00001", kind: "live" } });
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

describe("LiveSource（予約枠の先取り）", () => {
  it("API キー方式: 配信中がなければ近い予約枠", async () => {
    const { yt, source } = setup();
    yt.publicResult = ok({ live: null, upcoming: [LATER, SOON] });
    expect(await source.findLive(API)).toEqual({ ok: true, value: { videoId: "soon0000001", kind: "upcoming" } });
  });
  it("API キー方式: 配信中があればそちらを優先", async () => {
    const { yt, source } = setup();
    yt.publicResult = ok({ live: "publicLive1", upcoming: [SOON] });
    expect(await source.findLive(API)).toEqual({ ok: true, value: { videoId: "publicLive1", kind: "live" } });
  });
  it("オフなら予約枠はセットしない", async () => {
    const { yt, source } = setup();
    yt.publicResult = ok({ live: null, upcoming: [SOON] });
    expect(await source.findLive({ ...API, presetUpcoming: false })).toEqual({ ok: true, value: null });
  });
  it("範囲外（何日も先）の予約枠だけなら null", async () => {
    const { yt, source } = setup();
    yt.publicResult = ok({ live: null, upcoming: [LATER] });
    expect(await source.findLive(API)).toEqual({ ok: true, value: null });
  });
  it("Google ログイン方式: 配信中がないときだけ予約枠を取りに行く", async () => {
    const { yt, source } = setup();
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: { videoId: "myLive00001", kind: "live" } });
    expect(yt.upcomingCalls).toBe(0);
    yt.myResults = [ok(null)];
    yt.myUpcoming = ok([SOON]);
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: { videoId: "soon0000001", kind: "upcoming" } });
    expect(yt.upcomingCalls).toBe(1);
  });
  it("Google ログイン方式: オフなら予約枠を取りに行かない（quota 節約）", async () => {
    const { yt, source } = setup();
    yt.myResults = [ok(null)];
    expect(await source.findLive({ ...OAUTH, presetUpcoming: false })).toEqual({ ok: true, value: null });
    expect(yt.upcomingCalls).toBe(0);
  });
  it("Google ログイン方式: 予約枠の取得が 401 でも取り直して再試行", async () => {
    const { yt, tokens, source } = setup();
    yt.myResults = [ok(null)];
    let first = true;
    yt.findMyUpcoming = async () => {
      if (first) {
        first = false;
        return err("unauthorized");
      }
      return ok([SOON]);
    };
    expect(await source.findLive(OAUTH)).toEqual({ ok: true, value: { videoId: "soon0000001", kind: "upcoming" } });
    expect(tokens.calls).toBe(2);
  });
});
