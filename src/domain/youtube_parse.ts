import { err, isRecord, ok, type Result } from "./result";
import { VIDEO_ID } from "./video_url";

export interface ChannelInfo {
  channelId: string;
  uploadsPlaylistId: string;
}

const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

// channels.list?part=id,contentDetails
export function parseChannelsResponse(body: unknown): Result<ChannelInfo> {
  if (!isRecord(body)) return err("bad-response");
  const items = body["items"];
  if (items === undefined) return err("channel-not-found");
  if (!Array.isArray(items)) return err("bad-response");
  if (items.length === 0) return err("channel-not-found");
  const first: unknown = items[0];
  if (!isRecord(first)) return err("bad-response");
  const channelId = first["id"];
  const details = first["contentDetails"];
  const related = isRecord(details) ? details["relatedPlaylists"] : undefined;
  const uploads = isRecord(related) ? related["uploads"] : undefined;
  if (typeof channelId !== "string" || typeof uploads !== "string" || !PLAYLIST_ID.test(uploads)) {
    return err("bad-response");
  }
  return ok({ channelId, uploadsPlaylistId: uploads });
}

// playlistItems.list?part=contentDetails → 動画 ID（新しい順）
export function parsePlaylistItems(body: unknown): Result<string[]> {
  if (!isRecord(body)) return err("bad-response");
  const items = body["items"];
  if (items === undefined) return ok([]);
  if (!Array.isArray(items)) return err("bad-response");
  const ids: string[] = [];
  for (const item of items as unknown[]) {
    if (!isRecord(item)) continue;
    const details = item["contentDetails"];
    const id = isRecord(details) ? details["videoId"] : undefined;
    if (typeof id === "string" && VIDEO_ID.test(id)) ids.push(id);
  }
  return ok(ids);
}

// videos.list?part=liveStreamingDetails → 配信中の動画 ID（なければ null）
// 判定は「開始時刻あり・終了時刻なし」。snippet.liveBroadcastContent は反映が遅れるので使わない
export function pickLiveVideo(body: unknown): Result<string | null> {
  if (!isRecord(body)) return err("bad-response");
  const items = body["items"];
  if (items === undefined) return ok(null);
  if (!Array.isArray(items)) return err("bad-response");
  let best: { id: string; start: number } | null = null;
  for (const item of items as unknown[]) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    const live = item["liveStreamingDetails"];
    if (typeof id !== "string" || !VIDEO_ID.test(id) || !isRecord(live)) continue;
    const startRaw = live["actualStartTime"];
    if (typeof startRaw !== "string" || live["actualEndTime"] !== undefined) continue;
    const start = Date.parse(startRaw);
    if (Number.isNaN(start)) continue;
    if (best === null || start > best.start) best = { id, start };
  }
  return ok(best?.id ?? null);
}

// liveBroadcasts.list?part=id,snippet,status → 配信中の枠の ID（= 動画 ID）
// 判定は「開始時刻あり・終了時刻なし」（videos.list と同じ考え方）
export function pickLiveBroadcast(body: unknown): Result<string | null> {
  if (!isRecord(body)) return err("bad-response");
  const items = body["items"];
  if (items === undefined) return ok(null);
  if (!Array.isArray(items)) return err("bad-response");
  let best: { id: string; start: number } | null = null;
  for (const item of items as unknown[]) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    const snippet = item["snippet"];
    if (typeof id !== "string" || !VIDEO_ID.test(id) || !isRecord(snippet)) continue;
    const startRaw = snippet["actualStartTime"];
    if (typeof startRaw !== "string" || snippet["actualEndTime"] !== undefined) continue;
    const start = Date.parse(startRaw);
    if (Number.isNaN(start)) continue;
    if (best === null || start > best.start) best = { id, start };
  }
  return ok(best?.id ?? null);
}

// ---- 予約枠（まだ始まっていない枠） ----

export interface Upcoming {
  id: string;
  scheduledMs: number;
}

// 予約枠として扱う範囲: 開始予定が今から 12 時間前〜24 時間後
export const PRESET_PAST_MS = 12 * 3600_000;
export const PRESET_FUTURE_MS = 24 * 3600_000;

// items[] から「開始予定あり・未開始」のものを集める。detailsKey は開始時刻が入っている場所
function collectUpcoming(body: unknown, detailsKey: "liveStreamingDetails" | "snippet"): Result<Upcoming[]> {
  if (!isRecord(body)) return err("bad-response");
  const items = body["items"];
  if (items === undefined) return ok([]);
  if (!Array.isArray(items)) return err("bad-response");
  const list: Upcoming[] = [];
  for (const item of items as unknown[]) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    const details = item[detailsKey];
    if (typeof id !== "string" || !VIDEO_ID.test(id) || !isRecord(details)) continue;
    if (details["actualStartTime"] !== undefined) continue;
    const scheduledRaw = details["scheduledStartTime"];
    if (typeof scheduledRaw !== "string") continue;
    const scheduledMs = Date.parse(scheduledRaw);
    if (Number.isNaN(scheduledMs)) continue;
    list.push({ id, scheduledMs });
  }
  return ok(list);
}

// videos.list?part=liveStreamingDetails（API キー方式）
export function parseUpcomingVideos(body: unknown): Result<Upcoming[]> {
  return collectUpcoming(body, "liveStreamingDetails");
}

// liveBroadcasts.list?part=id,snippet（Google ログイン方式）
export function parseUpcomingBroadcasts(body: unknown): Result<Upcoming[]> {
  return collectUpcoming(body, "snippet");
}

// 開始予定が今に一番近い予約枠（範囲外は選ばない）
export function chooseUpcoming(list: readonly Upcoming[], nowMs: number): string | null {
  let best: { id: string; diff: number; scheduledMs: number } | null = null;
  for (const u of list) {
    if (u.scheduledMs < nowMs - PRESET_PAST_MS || u.scheduledMs > nowMs + PRESET_FUTURE_MS) continue;
    const diff = Math.abs(u.scheduledMs - nowMs);
    if (best === null || diff < best.diff || (diff === best.diff && u.scheduledMs < best.scheduledMs)) {
      best = { id: u.id, diff, scheduledMs: u.scheduledMs };
    }
  }
  return best?.id ?? null;
}

export type ApiErrorKind = "quota" | "bad-key" | "api-disabled" | "forbidden" | "unauthorized" | "server" | "other";

export function classifyApiError(status: number, body: unknown): ApiErrorKind {
  if (status >= 500) return "server";
  if (status === 401) return "unauthorized";
  const error = isRecord(body) ? body["error"] : undefined;
  const errors = isRecord(error) ? error["errors"] : undefined;
  const firstError: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const reason = isRecord(firstError) ? firstError["reason"] : undefined;
  const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "";
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") return "quota";
  if (reason === "keyInvalid" || reason === "keyExpired" || /API key not valid/i.test(message)) return "bad-key";
  if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED") return "api-disabled";
  if (status === 403) return "forbidden";
  return "other";
}
