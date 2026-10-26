import type { Result } from "../domain/result";
import { missingConfig, type Settings } from "../domain/settings";
import { extractVideoId, watchUrl } from "../domain/video_url";
import type { OneCommeError, OneCommeService } from "../infra/onecomme_client";
import type { SourceError } from "./live_source";

export interface LiveFinder {
  findLive(s: Settings): Promise<Result<string | null, SourceError>>;
}

export interface ServiceStore {
  getService(id: string): Promise<Result<OneCommeService, OneCommeError>>;
  updateService(id: string, patch: { url?: string; enabled?: boolean }): Promise<Result<void, OneCommeError>>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type WatchState = "stopped" | "needs-config" | "waiting" | "set" | "already-set" | "error";

export interface WatchStatus {
  state: WatchState;
  message: string;
  videoId: string | null;
  checkedAt: number | null;
}

export const MAX_BACKOFF_SEC = 600;
export const QUOTA_WAIT_SEC = 3600;
// 接続中の枠の URL を変えたあと、つなぎ直すまでの待ち時間
export const RECONNECT_GAP_MS = 1500;

const SOURCE_ERROR_MESSAGE: Record<SourceError, string> = {
  quota: "YouTube API の 1 日の利用上限に達しました。1 時間後にもう一度試します",
  "bad-key": "API キーが正しくありません",
  "api-disabled": "この API キーのプロジェクトで YouTube Data API v3 が有効になっていません",
  forbidden: "YouTube API に拒否されました（API キーの制限設定を確認してください）",
  server: "YouTube 側でエラーが起きました。しばらくしてから再試行します",
  network: "YouTube に接続できませんでした",
  "bad-response": "YouTube から想定外の応答がありました",
  "channel-not-found": "チャンネルが見つかりません",
  "bad-channel": "チャンネルの指定が正しくありません",
  unauthorized: "YouTube API の認証に失敗しました",
  "auth-required": "Google のログインが切れました。設定画面でもう一度ログインしてください",
  "bad-client": "OAuth クライアント ID かシークレットが正しくありません",
  "token-network": "Google に接続できませんでした",
  "token-other": "Google のログイン情報を更新できませんでした",
  other: "YouTube API でエラーが起きました",
};

const ONECOMME_ERROR_MESSAGE: Record<OneCommeError, string> = {
  network: "わんコメの API に接続できませんでした",
  "not-found": "書き換える枠が見つかりません。設定画面で枠を選び直してください",
  "bad-response": "わんコメから想定外の応答がありました",
  http: "わんコメの API がエラーを返しました",
};

function isYouTubeUrlOrEmpty(raw: string): boolean {
  if (raw.trim() === "") return true;
  try {
    const host = new URL(raw).hostname;
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

class StepError extends Error {
  constructor(
    message: string,
    readonly waitSec: number | null = null,
  ) {
    super(message);
  }
}

// 一定間隔で「配信中の枠」を探し、わんコメの枠の URL を書き換える
export class LiveWatcher {
  private timer: unknown = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private status: WatchStatus = { state: "stopped", message: "停止中", videoId: null, checkedAt: null };

  constructor(
    private readonly settings: () => Settings,
    private readonly source: LiveFinder,
    private readonly onecomme: ServiceStore,
    private readonly timers: Timers,
    private readonly log: (msg: string) => void,
  ) {}

  getStatus(): WatchStatus {
    return { ...this.status };
  }

  start(): void {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.status = { ...this.status, state: "stopped", message: "停止中" };
  }

  // 設定画面の「今すぐ確認」。実行中ならその完了を待つ
  async checkNow(): Promise<WatchStatus> {
    if (this.inFlight) await this.inFlight;
    else await this.runOnce();
    return this.getStatus();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let nextSec = this.settings().intervalSec;
      try {
        await this.step();
        this.failures = 0;
      } catch (e) {
        this.failures += 1;
        const message = e instanceof StepError ? e.message : "想定外のエラーが起きました";
        this.status = { ...this.status, state: "error", message, checkedAt: this.timers.now() };
        this.log(`error: ${message}`);
        const backoff = Math.min(MAX_BACKOFF_SEC, nextSec * 2 ** this.failures);
        nextSec = e instanceof StepError && e.waitSec !== null ? e.waitSec : backoff;
      } finally {
        this.inFlight = null;
      }
      this.schedule(nextSec * 1000);
    })();
    return this.inFlight;
  }

  private setStatus(state: WatchState, message: string, videoId: string | null): void {
    this.status = { state, message, videoId, checkedAt: this.timers.now() };
  }

  private async step(): Promise<void> {
    const s = this.settings();
    if (!s.enabled) return this.setStatus("needs-config", "自動セットはオフです", null);
    const missing = missingConfig(s);
    if (missing !== null) return this.setStatus("needs-config", missing, null);

    const live = await this.source.findLive(s);
    if (!live.ok) throw this.sourceError(live.error);
    if (live.value === null) return this.setStatus("waiting", "配信中の枠はありません（配信開始を待っています）", null);
    const videoId = live.value;

    const service = await this.onecomme.getService(s.serviceId);
    if (!service.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[service.error]);
    if (extractVideoId(service.value.url) === videoId) {
      return this.setStatus("already-set", "配信中の枠がセットされています", videoId);
    }
    // 間違えて他サイトの枠を選んでいた場合に上書きしない
    if (!isYouTubeUrlOrEmpty(service.value.url)) {
      throw new StepError("選んだ枠が YouTube の枠ではないため書き換えません");
    }

    const updated = await this.onecomme.updateService(s.serviceId, { url: watchUrl(videoId) });
    if (!updated.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[updated.error]);
    this.log(`set video ${videoId} to service ${s.serviceId}`);

    if (service.value.enabled) {
      // 接続中なら、新しい URL でつなぎ直す
      const off = await this.onecomme.updateService(s.serviceId, { enabled: false });
      if (!off.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[off.error]);
      await this.timers.sleep(RECONNECT_GAP_MS);
      const on = await this.onecomme.updateService(s.serviceId, { enabled: true });
      if (!on.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[on.error]);
    }
    this.setStatus("set", "配信中の枠をセットしました", videoId);
  }

  private sourceError(kind: SourceError): StepError {
    return new StepError(SOURCE_ERROR_MESSAGE[kind], kind === "quota" ? QUOTA_WAIT_SEC : null);
  }
}
