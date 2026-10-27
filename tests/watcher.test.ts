import { describe, expect, it } from "vitest";
import { LiveWatcher, MAX_BACKOFF_SEC, QUOTA_WAIT_SEC, type LiveFinder, type ServiceStore, type Timers } from "../src/app/watcher";
import { err, ok, type Result } from "../src/domain/result";
import { DEFAULT_SETTINGS, type Settings } from "../src/domain/settings";
import type { OneCommeError, OneCommeService } from "../src/infra/onecomme_client";
import type { SourceError, Target } from "../src/app/live_source";

const LIVE = { videoId: "liveNow0001", kind: "live" } as const;
const CONFIGURED: Settings = { ...DEFAULT_SETTINGS, apiKey: "AIzaKEY", channel: "@me", serviceId: "svc-1", intervalSec: 60 };

class FakeYouTube implements LiveFinder {
  live: Result<Target | null, SourceError> = ok(null);
  findCalls = 0;
  async findLive() {
    this.findCalls += 1;
    return this.live;
  }
}

class FakeOneComme implements ServiceStore {
  service: OneCommeService = { id: "svc-1", name: "#", url: "https://www.youtube.com/@me/live", enabled: true };
  failUpdate: OneCommeError | null = null;
  missing = false;
  updates: Array<{ url?: string; enabled?: boolean }> = [];
  async getService(id: string) {
    if (this.missing) return err<OneCommeError>("not-found");
    expect(id).toBe("svc-1");
    return ok({ ...this.service });
  }
  async updateService(_id: string, patch: { url?: string; enabled?: boolean }) {
    if (this.failUpdate) return err(this.failUpdate);
    this.updates.push(patch);
    this.service = { ...this.service, ...patch };
    return ok(undefined);
  }
}

class FakeTimers implements Timers {
  scheduled: number[] = [];
  slept: number[] = [];
  setTimeout(_fn: () => void, ms: number) {
    this.scheduled.push(ms);
    return this.scheduled.length;
  }
  clearTimeout() {}
  now() {
    return 1000;
  }
  async sleep(ms: number) {
    this.slept.push(ms);
  }
}

function setup(settings: Settings = CONFIGURED) {
  const yt = new FakeYouTube();
  const oc = new FakeOneComme();
  const timers = new FakeTimers();
  const logs: string[] = [];
  let current = settings;
  const watcher = new LiveWatcher(() => current, yt, oc, timers, (m) => logs.push(m));
  const setSettings = (s: Settings) => {
    current = s;
  };
  return { yt, oc, timers, logs, watcher, setSettings };
}

describe("LiveWatcher", () => {
  it("設定が足りなければ何もしない", async () => {
    const { yt, watcher } = setup(DEFAULT_SETTINGS);
    const st = await watcher.checkNow();
    expect(st.state).toBe("needs-config");
    expect(yt.findCalls).toBe(0);
  });

  it("オフなら何もしない", async () => {
    const { yt, watcher } = setup({ ...CONFIGURED, enabled: false });
    expect((await watcher.checkNow()).state).toBe("needs-config");
    expect(yt.findCalls).toBe(0);
  });

  it("配信中の枠がなければ待つ", async () => {
    const { oc, watcher } = setup();
    const st = await watcher.checkNow();
    expect(st.state).toBe("waiting");
    expect(oc.updates).toEqual([]);
  });

  it("配信中の枠を見つけたら URL を書き換え、接続中ならつなぎ直す", async () => {
    const { yt, oc, timers, watcher } = setup();
    yt.live = ok(LIVE);
    const st = await watcher.checkNow();
    expect(st).toMatchObject({ state: "set", videoId: "liveNow0001", kind: "live", message: "配信中の枠をセットしました" });
    expect(oc.updates).toEqual([{ enabled: false }, { url: "https://www.youtube.com/watch?v=liveNow0001" }, { enabled: true }]);
    expect(timers.slept).toHaveLength(1);
  });

  it("接続していない枠はつなぎ直さない", async () => {
    const { yt, oc, watcher } = setup();
    oc.service.enabled = false;
    yt.live = ok(LIVE);
    await watcher.checkNow();
    expect(oc.updates).toEqual([{ url: "https://www.youtube.com/watch?v=liveNow0001" }]);
  });

  it("もうセット済みなら書き換えない", async () => {
    const { yt, oc, watcher } = setup();
    oc.service.url = "https://youtube.com/live/liveNow0001?feature=share";
    yt.live = ok(LIVE);
    expect((await watcher.checkNow()).state).toBe("already-set");
    expect(oc.updates).toEqual([]);
  });

  it("YouTube 以外の枠は上書きしない", async () => {
    const { yt, oc, watcher } = setup();
    oc.service.url = "https://www.twitch.tv/someone";
    yt.live = ok(LIVE);
    const st = await watcher.checkNow();
    expect(st.state).toBe("error");
    expect(oc.updates).toEqual([]);
  });

  it("枠が消えていたらエラー", async () => {
    const { yt, oc, watcher } = setup();
    oc.missing = true;
    yt.live = ok(LIVE);
    expect((await watcher.checkNow()).message).toContain("枠が見つかりません");
  });

  it("設定を変えたら次の確認から新しい設定を使う", async () => {
    const { yt, watcher, setSettings } = setup();
    setSettings({ ...CONFIGURED, serviceId: "" });
    expect((await watcher.checkNow()).state).toBe("needs-config");
    setSettings(CONFIGURED);
    expect((await watcher.checkNow()).state).toBe("waiting");
    expect(yt.findCalls).toBe(1);
  });

  it("ログイン切れは再ログインを促す", async () => {
    const { yt, watcher } = setup();
    yt.live = err<SourceError>("auth-required");
    expect((await watcher.checkNow()).message).toContain("ログイン");
  });

  it("失敗が続くと間隔を延ばす（上限あり）", async () => {
    const { yt, timers, watcher } = setup();
    yt.live = err<SourceError>("network");
    watcher.start();
    timers.scheduled = [];
    for (let i = 0; i < 6; i++) await watcher.checkNow();
    expect(timers.scheduled).toEqual([120_000, 240_000, 480_000, 600_000, 600_000, 600_000].map((x) => Math.min(x, MAX_BACKOFF_SEC * 1000)));
  });

  it("成功したら通常の間隔に戻る", async () => {
    const { yt, timers, watcher } = setup();
    yt.live = err<SourceError>("server");
    watcher.start();
    await watcher.checkNow();
    yt.live = ok(null);
    timers.scheduled = [];
    await watcher.checkNow();
    expect(timers.scheduled).toEqual([60_000]);
  });

  it("quota 超過なら 1 時間待つ", async () => {
    const { yt, timers, watcher } = setup();
    yt.live = err<SourceError>("quota");
    watcher.start();
    timers.scheduled = [];
    const st = await watcher.checkNow();
    expect(st.message).toContain("上限");
    expect(timers.scheduled).toEqual([QUOTA_WAIT_SEC * 1000]);
  });

  it("API キーをログやメッセージに出さない", async () => {
    const { yt, logs, watcher } = setup();
    yt.live = err<SourceError>("bad-key");
    const st = await watcher.checkNow();
    yt.live = ok(LIVE);
    await watcher.checkNow();
    expect(JSON.stringify([logs, st])).not.toContain("AIzaKEY");
  });

  it("停止中は次を予約しない", async () => {
    const { timers, watcher } = setup();
    watcher.start();
    watcher.stop();
    timers.scheduled = [];
    await watcher.checkNow();
    expect(timers.scheduled).toEqual([]);
  });

  it("予約枠をセットしたことを表示する", async () => {
    const { yt, oc, watcher } = setup();
    yt.live = ok({ videoId: "upcoming001", kind: "upcoming" });
    const st = await watcher.checkNow();
    expect(st).toMatchObject({ state: "set", kind: "upcoming", message: expect.stringContaining("予約枠") });
    expect(oc.updates[1]).toEqual({ url: "https://www.youtube.com/watch?v=upcoming001" });
  });

  it("予約枠から配信が始まっても同じ動画なら書き換えない", async () => {
    const { yt, oc, watcher } = setup();
    yt.live = ok({ videoId: "upcoming001", kind: "upcoming" });
    await watcher.checkNow();
    oc.updates = [];
    yt.live = ok({ videoId: "upcoming001", kind: "live" });
    expect(await watcher.checkNow()).toMatchObject({ state: "already-set", kind: "live" });
    expect(oc.updates).toEqual([]);
  });

  it("Google ログイン方式は 30 秒、API キー方式は 60 秒未満にしない", async () => {
    const oauth = setup({ ...CONFIGURED, intervalSec: 30, authMode: "oauth", oauthClientId: "1-a.apps.googleusercontent.com", oauthClientSecret: "GOCSPX-x", refreshToken: "1//t" });
    oauth.watcher.start();
    oauth.timers.scheduled = [];
    await oauth.watcher.checkNow();
    expect(oauth.timers.scheduled).toEqual([30_000]);
    const apiKey = setup({ ...CONFIGURED, intervalSec: 30 });
    apiKey.watcher.start();
    apiKey.timers.scheduled = [];
    await apiKey.watcher.checkNow();
    expect(apiKey.timers.scheduled).toEqual([60_000]);
  });

  it("想定外の例外でも落ちずにエラー状態になる", async () => {
    const { yt, watcher } = setup();
    yt.findLive = async () => {
      throw new Error("boom");
    };
    expect((await watcher.checkNow()).state).toBe("error");
  });
});
