import type { ChannelRef } from "../domain/channel";
import { err, ok, type Result } from "../domain/result";
import {
  classifyApiError,
  parseChannelsResponse,
  parsePlaylistItems,
  pickLiveBroadcast,
  pickLiveVideo,
  type ApiErrorKind,
  type ChannelInfo,
} from "../domain/youtube_parse";
import { requestJson, type FetchLike } from "./http";

export type YouTubeError = ApiErrorKind | "network" | "bad-response" | "channel-not-found";

type Auth = { apiKey: string } | { accessToken: string };

const BASE = "https://www.googleapis.com/youtube/v3/";
// 再生リストは作った順。前もって作った予約枠が埋もれないよう 50 件見る（quota は 1 のまま）
const RECENT_COUNT = "50";

// YouTube Data API v3（公式）。API キー・トークンを含む URL やヘッダーはログに出さないこと
export class YouTubeClient {
  constructor(private readonly fetchFn: FetchLike) {}

  // API キー方式: ハンドル → アップロード再生リスト（1 unit）
  async resolveChannel(apiKey: string, ref: ChannelRef): Promise<Result<ChannelInfo, YouTubeError>> {
    const params: Record<string, string> = { part: "id,contentDetails" };
    if (ref.kind === "handle") params["forHandle"] = ref.handle;
    else params["id"] = ref.id;
    const r = await this.get("channels", params, { apiKey });
    if (!r.ok) return r;
    const parsed = parseChannelsResponse(r.value);
    if (parsed.ok) return parsed;
    return err(parsed.error === "channel-not-found" ? "channel-not-found" : "bad-response");
  }

  // API キー方式: 公開の配信中の動画（2 units）
  async findPublicLive(apiKey: string, uploadsPlaylistId: string): Promise<Result<string | null, YouTubeError>> {
    const auth = { apiKey };
    const list = await this.get("playlistItems", { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: RECENT_COUNT }, auth);
    if (!list.ok) return list;
    const ids = parsePlaylistItems(list.value);
    if (!ids.ok) return err("bad-response");
    if (ids.value.length === 0) return ok(null);
    const videos = await this.get("videos", { part: "liveStreamingDetails", id: ids.value.join(",") }, auth);
    if (!videos.ok) return videos;
    const live = pickLiveVideo(videos.value);
    return live.ok ? live : err("bad-response");
  }

  // Google ログイン方式: 自分の配信中の枠（限定公開・非公開・メン限を含む。1 unit）
  async findMyLive(accessToken: string): Promise<Result<string | null, YouTubeError>> {
    // broadcastStatus と mine は併用不可。broadcastType の既定は event のみなので all にする
    const r = await this.get(
      "liveBroadcasts",
      { part: "id,snippet,status", broadcastStatus: "active", broadcastType: "all", maxResults: "50" },
      { accessToken },
    );
    if (!r.ok) return r;
    const live = pickLiveBroadcast(r.value);
    return live.ok ? live : err("bad-response");
  }

  private async get(endpoint: string, params: Record<string, string>, auth: Auth): Promise<Result<unknown, YouTubeError>> {
    const url = new URL(endpoint, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if ("apiKey" in auth) url.searchParams.set("key", auth.apiKey);
    else headers["Authorization"] = `Bearer ${auth.accessToken}`;
    let res;
    try {
      res = await requestJson(this.fetchFn, url.toString(), { headers });
    } catch {
      return err("network");
    }
    if (res.status !== 200) return err(classifyApiError(res.status, res.body));
    return ok(res.body);
  }
}
