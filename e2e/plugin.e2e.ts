// E2E: ビルドした本物の plugin.js を、わんコメと同じ呼び出し方（init / request / destroy）で動かす。
// 外の世界（わんコメの API・YouTube・Google）は FakeWorld。ログインの戻り先だけは本物の 127.0.0.1 サーバーを使う
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { API_KEY, CLIENT_ID, CLIENT_SECRET, FakeWorld, REFRESH_TOKEN } from "./fake_world";

const PLUGIN_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "yt-live-autoset", "plugin.js");
const HOUR = 3600_000;

interface PluginResponse {
  code: number;
  response: Record<string, unknown>;
}
interface Plugin {
  uid: string;
  version: string;
  author: string;
  defaultState: { settings: Record<string, unknown> };
  init(api: { store: { get(k: string): unknown; set(k: string, v: unknown): void } }): void;
  destroy(): void;
  request(req: { url: string; method: string; params: Record<string, string>; body?: unknown }): Promise<PluginResponse>;
}

// わんコメと同じく CommonJS として読み込む。モジュール内の状態を持ち越さないよう、毎回別のファイルにコピーする
function loadPlugin(): Plugin {
  const dir = mkdtempSync(join(tmpdir(), "yt-live-autoset-e2e-"));
  const file = join(dir, "plugin.cjs");
  copyFileSync(PLUGIN_JS, file);
  return createRequire(file)(file) as Plugin;
}

const realFetch = globalThis.fetch;
let running: Plugin | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(world: FakeWorld, saved?: Record<string, unknown>) {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  globalThis.fetch = world.fetch as typeof fetch;
  // 最後の操作の時刻。これより後に終わった確認の結果を待つ
  let lastAction = Date.now();
  const plugin = loadPlugin();
  const data = new Map<string, unknown>([["settings", saved ?? plugin.defaultState.settings]]);
  plugin.init({ store: { get: (k) => data.get(k), set: (k, v) => data.set(k, structuredClone(v)) } });
  running = plugin;

  const call = (method: string, body?: unknown) => {
    if (method !== "GET") lastAction = Date.now();
    return plugin.request({ url: `/api/plugins/${plugin.uid}`, method, params: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  type Status = { state: string; message: string; videoId: string | null; kind: string | null; checkedAt: number | null };
  const status = (r: PluginResponse) => r.response["status"] as Status;
  const settingsOf = (r: PluginResponse) => r.response["settings"] as Record<string, unknown>;
  return {
    plugin,
    logs,
    saved: () => data.get("settings") as Record<string, unknown>,
    get: () => call("GET"),
    put: (b: unknown) => call("PUT", b),
    post: (b: unknown) => call("POST", b),
    // 1 回確認して状態を返す
    check: async () => status(await call("POST", { action: "check" })),
    // 起動・保存・ログインの直後に自動で走る確認が終わるのを待ち、その結果を返す（自分では確認を走らせない）
    settle: async (): Promise<Status> => {
      const since = lastAction;
      for (let i = 0; i < 100; i++) {
        const st = status(await call("GET"));
        if (st && st.checkedAt !== null && st.checkedAt >= since && st.state !== "stopped") return st;
        await sleep(30);
      }
      throw new Error("自動の確認が終わりませんでした");
    },
    status,
    settingsOf,
  };
}

const OAUTH_SETTINGS = {
  enabled: true,
  authMode: "oauth",
  oauthClientId: CLIENT_ID,
  oauthClientSecret: CLIENT_SECRET,
  refreshToken: REFRESH_TOKEN,
  serviceId: "svc-yt",
  intervalSec: 30,
  presetUpcoming: true,
  autoConnectLive: true,
};

beforeAll(() => {
  if (!existsSync(PLUGIN_JS)) throw new Error("先に npm run build してください（npm run test:e2e なら自動でビルドします）");
});

afterEach(() => {
  running?.destroy();
  running = null;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("E2E: 初めて使う", () => {
  it("読み込める・名前と作者が正しい", () => {
    const p = loadPlugin();
    expect(p.uid).toBe("com.riito.yt-live-autoset");
    expect(p.author).toBe("りーと");
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("設定前は「設定が必要」で、わんコメにも YouTube にも何もしない", async () => {
    const world = new FakeWorld(realFetch);
    const app = boot(world);
    expect(await app.settle()).toMatchObject({ state: "needs-config" });
    expect(world.updates).toEqual([]);
    expect(world.seenUrls.filter((u) => u.includes("googleapis"))).toEqual([]);
  });
});

describe("E2E: API キー方式", () => {
  it("設定を保存すると、公開の配信中の枠をセットして接続する", async () => {
    const world = new FakeWorld(realFetch);
    world.live("publicLive1");
    const app = boot(world);
    const saved = await app.put({ authMode: "apiKey", apiKey: API_KEY, channel: "https://www.youtube.com/@e2e", serviceId: "svc-yt", intervalSec: 60 });
    expect(saved.code).toBe(200);
    expect(await app.settle()).toMatchObject({ state: "set", videoId: "publicLive1", kind: "live" });
    expect(world.service("svc-yt")).toMatchObject({ url: "https://www.youtube.com/watch?v=publicLive1", enabled: true });
    expect(world.service("svc-tw")).toMatchObject({ url: "https://www.twitch.tv/someone", enabled: true });
  });

  it("API キーは画面への応答にもログにも出ない", async () => {
    const world = new FakeWorld(realFetch);
    world.live("publicLive1");
    const app = boot(world);
    const r = await app.put({ authMode: "apiKey", apiKey: API_KEY, channel: "@e2e", serviceId: "svc-yt" });
    await app.settle();
    expect(JSON.stringify(r.response)).not.toContain(API_KEY);
    expect(JSON.stringify((await app.get()).response)).not.toContain(API_KEY);
    expect(app.settingsOf(r)).toMatchObject({ hasApiKey: true });
    expect(app.logs.join("\n")).not.toContain(API_KEY);
  });

  it("チャンネルが見つからなければエラー表示", async () => {
    const world = new FakeWorld(realFetch);
    const app = boot(world);
    await app.put({ authMode: "apiKey", apiKey: API_KEY, channel: "@nobody", serviceId: "svc-yt" });
    expect(await app.settle()).toMatchObject({ state: "error", message: expect.stringContaining("チャンネルが見つかりません") });
  });
});

describe("E2E: Google ログイン方式", () => {
  it("ログイン（PKCE・ループバック）→ 限定公開の配信をセット → ログアウトで許可を取り消す", async () => {
    const world = new FakeWorld(realFetch);
    world.live("unlisted001");
    const app = boot(world);
    await app.put({ authMode: "oauth", oauthClientId: CLIENT_ID, oauthClientSecret: CLIENT_SECRET, serviceId: "svc-yt" });
    expect(await app.settle()).toMatchObject({ state: "needs-config", message: expect.stringContaining("Google でログイン") });

    const started = await app.post({ action: "oauthStart" });
    const authUrl = String(started.response["authUrl"]);
    expect(authUrl.startsWith("https://accounts.google.com/")).toBe(true);
    const u = new URL(authUrl);
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await world.approveLogin(authUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ログインしました");

    expect(await app.settle()).toMatchObject({ state: "set", videoId: "unlisted001", kind: "live" });
    expect(app.settingsOf(await app.get())).toMatchObject({ loggedIn: true });
    expect(app.saved()["refreshToken"]).toBe(REFRESH_TOKEN);
    expect(JSON.stringify((await app.get()).response)).not.toContain(REFRESH_TOKEN);
    expect(app.logs.join("\n")).not.toMatch(/1\/\/e2e|ya29\.|4\/e2e|GOCSPX/);

    await app.post({ action: "oauthLogout" });
    expect(world.revoked).toEqual([REFRESH_TOKEN]);
    expect(app.settingsOf(await app.get())).toMatchObject({ loggedIn: false });
    expect(app.saved()["refreshToken"]).toBe("");
  });

  it("偽の state で戻ってきてもログインしない", async () => {
    const world = new FakeWorld(realFetch);
    const app = boot(world);
    await app.put({ authMode: "oauth", oauthClientId: CLIENT_ID, oauthClientSecret: CLIENT_SECRET, serviceId: "svc-yt" });
    const authUrl = String((await app.post({ action: "oauthStart" })).response["authUrl"]);
    const forged = new URL(new URL(authUrl).searchParams.get("redirect_uri") ?? "");
    forged.searchParams.set("code", "4/e2e-auth-code");
    forged.searchParams.set("state", "forged-state");
    await realFetch(forged).catch(() => undefined);
    await sleep(100);
    expect(app.settingsOf(await app.get())).toMatchObject({ loggedIn: false });
    expect(world.tokenRequests).toEqual([]);
  });

  it("ログインが無効になったら、再ログインを促してトークンを消す", async () => {
    const world = new FakeWorld(realFetch);
    world.tokenError = "invalid_grant";
    const app = boot(world, OAUTH_SETTINGS);
    expect(await app.settle()).toMatchObject({ state: "error", message: expect.stringContaining("もう一度ログイン") });
    expect(app.settingsOf(await app.get())).toMatchObject({ loggedIn: false });
  });
});

describe("E2E: 予約枠と配信開始（配布先で起きた 11/02 のケース）", () => {
  it("前日に予約枠をセット・接続オンのまま閉じる → 翌日起動 → 配信開始で 1 回だけつなぎ直す", async () => {
    const world = new FakeWorld(realFetch);
    // 1 日目: 配信中の枠と、翌日の予約枠
    world.live("day1live001");
    world.upcoming("day2plan001", 20 * HOUR);
    world.service("svc-yt").enabled = false;
    let app = boot(world, OAUTH_SETTINGS);
    expect(await app.settle()).toMatchObject({ state: "set", videoId: "day1live001", kind: "live" });
    expect(world.service("svc-yt")).toMatchObject({ enabled: true });

    // 1 日目の配信が終わる → 翌日の予約枠を先にセット（接続オンのまま）
    world.end("day1live001");
    expect(await app.check()).toMatchObject({ state: "set", videoId: "day2plan001", kind: "upcoming" });
    expect(world.service("svc-yt")).toMatchObject({ url: "https://www.youtube.com/watch?v=day2plan001", enabled: true });

    // わんコメを閉じる（接続オンのまま）
    running?.destroy();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();

    // 2 日目: わんコメを起動。プラグインは何もしない（予約枠のまま）
    app = boot(world, OAUTH_SETTINGS);
    world.updates = [];
    expect(await app.settle()).toMatchObject({ state: "already-set", kind: "upcoming" });
    expect(world.updates).toEqual([]);

    // 配信開始 → URL はそのままで、切断 → 接続
    world.start("day2plan001");
    expect(await app.check()).toMatchObject({ state: "set", kind: "live", message: expect.stringContaining("つなぎ直しました") });
    expect(world.patchesFor("svc-yt")).toEqual([{ enabled: false }, { enabled: true }]);
    expect(app.logs.some((l) => l.includes("reconnected") && l.includes("day2plan001"))).toBe(true);

    // 2 回目以降は何もしない。配信者が手動でオフにしても戻さない
    world.updates = [];
    expect(await app.check()).toMatchObject({ state: "already-set" });
    world.service("svc-yt").enabled = false;
    expect(await app.check()).toMatchObject({ state: "already-set" });
    expect(world.updates).toEqual([]);
  }, 20_000);

  it("予約枠の先取りをオフにすると、配信が始まるまで何もしない", async () => {
    const world = new FakeWorld(realFetch);
    world.upcoming("plan0000001", HOUR);
    const app = boot(world, { ...OAUTH_SETTINGS, presetUpcoming: false });
    expect(await app.settle()).toMatchObject({ state: "waiting" });
    expect(world.updates).toEqual([]);
  });

  it("自動接続をオフにすると、接続オフの枠は URL だけ書き換える", async () => {
    const world = new FakeWorld(realFetch);
    world.live("liveNow0001");
    const app = boot(world, { ...OAUTH_SETTINGS, autoConnectLive: false });
    await app.settle();
    expect(world.service("svc-yt")).toMatchObject({ url: "https://www.youtube.com/watch?v=liveNow0001", enabled: false });
  });
});

describe("E2E: 困ったとき", () => {
  it("YouTube 以外の枠を選んでいたら書き換えない", async () => {
    const world = new FakeWorld(realFetch);
    world.live("liveNow0001");
    const app = boot(world, { ...OAUTH_SETTINGS, serviceId: "svc-tw" });
    expect(await app.settle()).toMatchObject({ state: "error", message: expect.stringContaining("YouTube の枠ではない") });
    expect(world.service("svc-tw")).toMatchObject({ url: "https://www.twitch.tv/someone" });
  });

  it("わんコメの API に届かなくても落ちず、エラー表示にする", async () => {
    const world = new FakeWorld(realFetch);
    world.live("liveNow0001");
    world.onecommeDown = true;
    const app = boot(world, OAUTH_SETTINGS);
    expect(await app.settle()).toMatchObject({ state: "error", message: expect.stringContaining("わんコメの API に接続できませんでした") });
    world.onecommeDown = false;
    expect(await app.check()).toMatchObject({ state: "set" });
  });

  it("YouTube API の利用上限ならそう表示する", async () => {
    const world = new FakeWorld(realFetch);
    world.youtubeError = { status: 403, reason: "quotaExceeded" };
    const app = boot(world, OAUTH_SETTINGS);
    expect(await app.settle()).toMatchObject({ state: "error", message: expect.stringContaining("利用上限") });
  });

  it("壊れた入力は保存しない（設定は変わらない）", async () => {
    const world = new FakeWorld(realFetch);
    const app = boot(world, OAUTH_SETTINGS);
    await app.settle();
    for (const body of [{ serviceId: "../../etc" }, { intervalSec: "abc" }, { autoConnectLive: "yes" }, { oauthClientId: "not-a-client" }]) {
      const r = await app.put(body);
      expect(r.code).toBe(400);
    }
    expect((await app.plugin.request({ url: "/", method: "PUT", params: {}, body: "{not json" })).code).toBe(400);
    expect((await app.post({ action: "unknown" })).code).toBe(400);
    expect(app.saved()).toMatchObject({ serviceId: "svc-yt", intervalSec: 30, autoConnectLive: true, oauthClientId: CLIENT_ID });
  });

  it("保存データが壊れていても起動できる（初期値で動く）", async () => {
    const world = new FakeWorld(realFetch);
    const app = boot(world, { authMode: 42, intervalSec: "x", refreshToken: { bad: true }, serviceId: null });
    expect(await app.settle()).toMatchObject({ state: "needs-config" });
  });

  it("止めた（わんコメを閉じた）あとは通信しない", async () => {
    const world = new FakeWorld(realFetch);
    world.live("liveNow0001");
    const app = boot(world, OAUTH_SETTINGS);
    await app.settle();
    app.plugin.destroy();
    running = null;
    const count = world.seenUrls.length;
    await sleep(300);
    expect(world.seenUrls.length).toBe(count);
  });
});
