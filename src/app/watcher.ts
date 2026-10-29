import type { Result } from "../domain/result";
import { effectiveIntervalSec, missingConfig, type Settings } from "../domain/settings";
import { extractVideoId, watchUrl } from "../domain/video_url";
import type { OneCommeError, OneCommeService } from "../infra/onecomme_client";
import type { SourceError, Target } from "./live_source";

export interface LiveFinder {
  findLive(s: Settings): Promise<Result<Target | null, SourceError>>;
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
  // セットした枠が配信中か予約枠か
  kind: Target["kind"] | null;
  checkedAt: number | null;
}

export const MAX_BACKOFF_SEC = 600;
export const QUOTA_WAIT_SEC = 3600;
// 接続中の枠の URL を変えたあと、つなぎ直すまでの待ち時間
export const RECONNECT_GAP_MS = 1500;
// 自動接続を済ませた（または接続中を確認した）配信を覚えておく数
const CONNECTED_MEMORY = 20;

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
  // 同じ配信では自動接続を 1 回だけにする（配信者が手動でオフにしたら戻さない）
  private readonly connectedVideos: string[] = [];
  private status: WatchStatus = { state: "stopped", message: "停止中", videoId: null, kind: null, checkedAt: null };

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
      let nextSec = effectiveIntervalSec(this.settings());
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

  private setStatus(state: WatchState, message: string, target: Target | null): void {
    this.status = { state, message, videoId: target?.videoId ?? null, kind: target?.kind ?? null, checkedAt: this.timers.now() };
  }

  private async step(): Promise<void> {
    const s = this.settings();
    if (!s.enabled) return this.setStatus("needs-config", "自動セットはオフです", null);
    const missing = missingConfig(s);
    if (missing !== null) return this.setStatus("needs-config", missing, null);

    const found = await this.source.findLive(s);
    if (!found.ok) throw this.sourceError(found.error);
    if (found.value === null) return this.setStatus("waiting", "配信中・まもなく始まる予約枠はありません（配信開始を待っています）", null);
    const target = found.value;
    const videoId = target.videoId;
    const label = target.kind === "live" ? "配信中の枠" : "予約枠（配信開始前）";

    const service = await this.onecomme.getService(s.serviceId);
    if (!service.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[service.error]);
    if (extractVideoId(service.value.url) === videoId) {
      if (service.value.enabled) this.rememberConnected(target);
      if (this.shouldAutoConnect(s, target, service.value.enabled)) {
        await this.connect(s.serviceId, target);
        return this.setStatus("set", "配信中の枠に接続しました", target);
      }
      return this.setStatus("already-set", `${label}がセットされています`, target);
    }
    // 間違えて他サイトの枠を選んでいた場合に上書きしない
    if (!isYouTubeUrlOrEmpty(service.value.url)) {
      throw new StepError("選んだ枠が YouTube の枠ではないため書き換えません");
    }

    // わんコメの画面では接続中は URL を編集できないので、同じ順番（切断 → 書き換え → 接続）にする
    const wasEnabled = service.value.enabled;
    if (wasEnabled) {
      const off = await this.onecomme.updateService(s.serviceId, { enabled: false });
      if (!off.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[off.error]);
    }
    const updated = await this.onecomme.updateService(s.serviceId, { url: watchUrl(videoId) });
    if (!updated.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[updated.error]);
    this.log(`set ${target.kind} video ${videoId} to service ${s.serviceId}`);
    if (wasEnabled) {
      await this.timers.sleep(RECONNECT_GAP_MS);
      await this.connect(s.serviceId, target);
    } else if (this.shouldAutoConnect(s, target, false)) {
      await this.connect(s.serviceId, target);
      return this.setStatus("set", `${label}をセットして接続しました`, target);
    }
    this.setStatus("set", `${label}をセットしました`, target);
  }

  private shouldAutoConnect(s: Settings, target: Target, enabled: boolean): boolean {
    return s.autoConnectLive && target.kind === "live" && !enabled && !this.connectedVideos.includes(target.videoId);
  }

  private rememberConnected(target: Target): void {
    if (target.kind !== "live" || this.connectedVideos.includes(target.videoId)) return;
    this.connectedVideos.push(target.videoId);
    if (this.connectedVideos.length > CONNECTED_MEMORY) this.connectedVideos.shift();
  }

  // 接続をオンにする。成功したら覚える（失敗なら次の確認でやり直す）
  private async connect(serviceId: string, target: Target): Promise<void> {
    const on = await this.onecomme.updateService(serviceId, { enabled: true });
    if (!on.ok) throw new StepError(ONECOMME_ERROR_MESSAGE[on.error]);
    this.rememberConnected(target);
  }

  private sourceError(kind: SourceError): StepError {
    return new StepError(SOURCE_ERROR_MESSAGE[kind], kind === "quota" ? QUOTA_WAIT_SEC : null);
  }
}
