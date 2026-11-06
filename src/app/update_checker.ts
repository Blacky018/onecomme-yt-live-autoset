// 新しいバージョンが出ているかを確かめる（設定画面を開いたときだけ呼ばれる）
import { isNewerVersion, parseLatestVersion } from "../domain/version";

export const UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000;
export const UPDATE_RETRY_MS = 30 * 60_000;

export interface UpdateStatus {
  current: string;
  // current より新しいときだけ入る
  latest: string | null;
}

export class UpdateChecker {
  private latest: string | null = null;
  private lastAttempt: number | null = null;
  private lastOk = false;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    // version.json の中身（JSON）を返す。失敗したら例外
    private readonly fetchLatest: () => Promise<unknown>,
    private readonly current: string,
    private readonly now: () => number,
    private readonly log: (msg: string) => void,
  ) {}

  getStatus(): UpdateStatus {
    const latest = this.latest !== null && isNewerVersion(this.latest, this.current) ? this.latest : null;
    return { current: this.current, latest };
  }

  // 前回から間が空いていれば確認する。例外は出さない
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.lastAttempt !== null) {
      const wait = this.lastOk ? UPDATE_CHECK_INTERVAL_MS : UPDATE_RETRY_MS;
      if (this.now() - this.lastAttempt < wait) return Promise.resolve();
    }
    this.lastAttempt = this.now();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    try {
      const parsed = parseLatestVersion(await this.fetchLatest());
      if (!parsed.ok) throw new Error(`bad ${parsed.error}`);
      this.latest = parsed.value;
      this.lastOk = true;
    } catch (e) {
      this.lastOk = false;
      this.log(`update check failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
}
