import type { ChannelRef } from "../domain/channel";
import { err, ok, type Result } from "../domain/result";
import {
  classifyApiError,
  parseChannelsResponse,
  parsePlaylistItems,
  pickLiveVideo,
  type ApiErrorKind,
  type ChannelInfo,
} from "../domain/youtube_parse";
import { requestJson, type FetchLike } from "./http";

export type YouTubeError = ApiErrorKind | "network" | "bad-response" | "channel-not-found";

const BASE = "https://www.googleapis.com/youtube/v3/";
// 再生リストは作った順。前もって作った予約枠が埋もれないよう 50 件見る（quota は 1 のまま）
const RECENT_COUNT = "50";

// YouTube Data API v3（公式）。API キーを含む URL はログに出さないこと
export class YouTubeClient {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly apiKey: () => string,
  ) {}

  async resolveChannel(ref: ChannelRef): Promise<Result<ChannelInfo, YouTubeError>> {
    const params: Record<string, string> = { part: "id,contentDetails" };
    if (ref.kind === "handle") params["forHandle"] = ref.handle;
    else params["id"] = ref.id;
    const r = await this.get("channels", params);
    if (!r.ok) return r;
    const parsed = parseChannelsResponse(r.value);
    if (parsed.ok) return parsed;
    return err(parsed.error === "channel-not-found" ? "channel-not-found" : "bad-response");
  }

  // 1 回の確認で 2 units 使う
  async findLiveVideo(uploadsPlaylistId: string): Promise<Result<string | null, YouTubeError>> {
    const list = await this.get("playlistItems", { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: RECENT_COUNT });
    if (!list.ok) return list;
    const ids = parsePlaylistItems(list.value);
    if (!ids.ok) return err("bad-response");
    if (ids.value.length === 0) return ok(null);
    const videos = await this.get("videos", { part: "liveStreamingDetails", id: ids.value.join(",") });
    if (!videos.ok) return videos;
    const live = pickLiveVideo(videos.value);
    return live.ok ? live : err("bad-response");
  }

  private async get(endpoint: string, params: Record<string, string>): Promise<Result<unknown, YouTubeError>> {
    const url = new URL(endpoint, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", this.apiKey());
    let res;
    try {
      res = await requestJson(this.fetchFn, url.toString());
    } catch {
      return err("network");
    }
    if (res.status !== 200) return err(classifyApiError(res.status, res.body));
    return ok(res.body);
  }
}
