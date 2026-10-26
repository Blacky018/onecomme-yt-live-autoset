import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyApiError, parseChannelsResponse, parsePlaylistItems, pickLiveBroadcast, pickLiveVideo } from "../src/domain/youtube_parse";

// フィクスチャは 2026-10-26 の実レスポンスの形をもとに、ID・タイトルをダミーにしたもの
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("parseChannelsResponse", () => {
  it("チャンネル ID とアップロード再生リストを取り出す", () => {
    expect(parseChannelsResponse(fixture("channels.json"))).toEqual({
      ok: true,
      value: { channelId: "UCdummychannel000000000a", uploadsPlaylistId: "UUdummychannel000000000a" },
    });
  });
  it("items が空ならチャンネルなし", () => {
    expect(parseChannelsResponse({ kind: "youtube#channelListResponse", pageInfo: {} })).toEqual({ ok: false, error: "channel-not-found" });
  });
  it.each([null, "x", { items: [{}] }, { items: [{ id: 1 }] }])("壊れた入力 %j", (input) => {
    expect(parseChannelsResponse(input).ok).toBe(false);
  });
});

describe("parsePlaylistItems", () => {
  it("動画 ID を順に取り出す", () => {
    const r = parsePlaylistItems(fixture("playlist_items.json"));
    expect(r).toEqual({ ok: true, value: ["liveNow0001", "upcoming001", "ended000001", "ended000002"] });
  });
  it("不正な動画 ID は飛ばす", () => {
    const r = parsePlaylistItems({
      items: [{ contentDetails: { videoId: "ok_video-01" } }, { contentDetails: { videoId: "bad" } }, { contentDetails: {} }, null],
    });
    expect(r).toEqual({ ok: true, value: ["ok_video-01"] });
  });
  it("items がなければ空", () => {
    expect(parsePlaylistItems({})).toEqual({ ok: true, value: [] });
  });
  it("オブジェクトでなければエラー", () => {
    expect(parsePlaylistItems([]).ok).toBe(false);
  });
});

describe("pickLiveVideo", () => {
  it("開始済み・未終了の動画を選ぶ（liveBroadcastContent が upcoming のままでも）", () => {
    // 実測: 配信開始直後は liveBroadcastContent が "upcoming" のまま actualStartTime だけ入る
    expect(pickLiveVideo(fixture("videos_just_started.json"))).toEqual({ ok: true, value: "liveNow0001" });
  });
  it("配信中のものがなければ null", () => {
    expect(pickLiveVideo(fixture("videos_none_live.json"))).toEqual({ ok: true, value: null });
  });
  it("複数あれば開始が新しいほう", () => {
    const v = (id: string, start: string) => ({ id, liveStreamingDetails: { actualStartTime: start } });
    const r = pickLiveVideo({ items: [v("older000001", "2026-10-26T10:00:00Z"), v("newer000001", "2026-10-26T12:00:00Z")] });
    expect(r).toEqual({ ok: true, value: "newer000001" });
  });
  it("開始時刻が日付として読めないものは無視", () => {
    const r = pickLiveVideo({ items: [{ id: "broken00001", liveStreamingDetails: { actualStartTime: "yesterday" } }] });
    expect(r).toEqual({ ok: true, value: null });
  });
  it.each([null, 1, []])("壊れた入力 %j はエラー", (input) => {
    expect(pickLiveVideo(input).ok).toBe(false);
  });
});

describe("pickLiveBroadcast", () => {
  it("開始済みの枠を選ぶ（限定公開でも・テスト中の枠は除く）", () => {
    expect(pickLiveBroadcast(fixture("broadcasts_active.json"))).toEqual({ ok: true, value: "unlisted001" });
  });
  it("終了済みは除く", () => {
    const r = pickLiveBroadcast({ items: [{ id: "ended000001", snippet: { actualStartTime: "2026-10-27T01:00:00Z", actualEndTime: "2026-10-27T02:00:00Z" } }] });
    expect(r).toEqual({ ok: true, value: null });
  });
  it("items がなければ null", () => {
    expect(pickLiveBroadcast({ kind: "youtube#liveBroadcastListResponse" })).toEqual({ ok: true, value: null });
  });
  it.each([null, [], { items: "x" }])("壊れた入力 %j", (input) => {
    expect(pickLiveBroadcast(input).ok).toBe(false);
  });
});

describe("classifyApiError", () => {
  const body = (reason: string) => ({ error: { code: 403, errors: [{ reason }] } });
  it.each([
    [403, body("quotaExceeded"), "quota"],
    [403, body("dailyLimitExceeded"), "quota"],
    [400, body("keyInvalid"), "bad-key"],
    [400, { error: { errors: [{ reason: "badRequest" }], message: "API key not valid. Please pass a valid API key." } }, "bad-key"],
    [403, body("accessNotConfigured"), "api-disabled"],
    [403, body("forbidden"), "forbidden"],
    [401, { error: { code: 401, errors: [{ reason: "authError" }] } }, "unauthorized"],
    [403, body("liveStreamingNotEnabled"), "forbidden"],
    [500, null, "server"],
    [404, "nope", "other"],
  ] as const)("%d %j → %s", (status, b, kind) => {
    expect(classifyApiError(status, b)).toBe(kind);
  });
});
