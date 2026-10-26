// わんコメ プラグインの入口。わんコメとの接続だけを書き、処理は app / infra に任せる
import { LiveSource } from "./app/live_source";
import { OAuthLogin } from "./app/oauth_login";
import { LiveWatcher, type Timers } from "./app/watcher";
import { isRecord } from "./domain/result";
import { applySettingsPatch, DEFAULT_SETTINGS, loadSettings, publicSettings, type Settings } from "./domain/settings";
import { GoogleOAuth } from "./infra/google_oauth";
import type { FetchLike } from "./infra/http";
import { createPkce, randomState, startLoopback } from "./infra/loopback";
import { OneCommeClient } from "./infra/onecomme_client";
import { YouTubeClient } from "./infra/youtube_client";
import { PLUGIN_UID } from "./plugin_uid";

// ビルド時に package.json の version が入る（scripts/build.mjs）
declare const PLUGIN_VERSION: string;

const SETTINGS_KEY = "settings";

// わんコメが渡す ElectronStore のうち、使う部分だけ
interface PluginStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface PluginRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  params: Record<string, string>;
  body?: unknown;
}

interface PluginResponse {
  code: number;
  response: unknown;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// 秘密の値（キー・トークン・コード）はログに渡さないこと
const log = (msg: string) => console.log(`[yt-live-autoset] ${msg}`);

let store: PluginStore | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let watcher: LiveWatcher | null = null;
let source: LiveSource | null = null;
let login: OAuthLogin | null = null;
let google: GoogleOAuth | null = null;

function save(next: Settings): void {
  settings = next;
  store?.set(SETTINGS_KEY, settings);
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function snapshot(extra: Record<string, unknown> = {}): unknown {
  return {
    settings: publicSettings(settings),
    status: watcher?.getStatus() ?? null,
    login: login?.getStatus() ?? null,
    ...extra,
  };
}

async function handlePost(body: unknown): Promise<PluginResponse> {
  const action = isRecord(body) ? body["action"] : undefined;
  switch (action) {
    case "check":
      await watcher?.checkNow();
      return { code: 200, response: snapshot() };
    case "oauthStart": {
      if (!login) return { code: 503, response: { error: "not-ready" } };
      const r = await login.start({ clientId: settings.oauthClientId, clientSecret: settings.oauthClientSecret });
      if (!r.ok) return { code: 400, response: { error: "login", message: r.error } };
      return { code: 200, response: snapshot({ authUrl: r.value }) };
    }
    case "oauthLogout": {
      login?.cancel();
      const token = settings.refreshToken;
      save({ ...settings, refreshToken: "" });
      source?.clearToken();
      if (token !== "") await google?.revoke(token);
      watcher?.start();
      return { code: 200, response: snapshot() };
    }
    default:
      return { code: 400, response: { error: "invalid" } };
  }
}

async function handle(req: PluginRequest): Promise<PluginResponse> {
  switch (req.method) {
    case "GET":
      return { code: 200, response: snapshot() };
    case "PUT": {
      const next = applySettingsPatch(settings, parseBody(req.body));
      if (!next.ok) return { code: 400, response: { error: "invalid", field: next.error } };
      save(next.value);
      watcher?.start(); // 新しい設定ですぐ確認し直す
      return { code: 200, response: snapshot() };
    }
    case "POST":
      return handlePost(parseBody(req.body));
    default:
      return { code: 404, response: {} };
  }
}

const plugin = {
  name: "YouTube 配信 URL 自動セット（非公式）",
  uid: PLUGIN_UID,
  version: PLUGIN_VERSION,
  author: "りーと",
  url: `http://localhost:11180/plugins/${PLUGIN_UID}/index.html`,
  permissions: [] as string[],
  defaultState: { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } },

  init({ store: s }: { store: PluginStore }): void {
    try {
      store = s;
      settings = loadSettings(s.get(SETTINGS_KEY));
      const fetchFn: FetchLike = (url, init) => fetch(url, init);
      google = new GoogleOAuth(fetchFn);
      const g = google;
      source = new LiveSource(new YouTubeClient(fetchFn), g, realTimers.now, () => {
        log("refresh token is no longer valid");
        save({ ...settings, refreshToken: "" });
      });
      login = new OAuthLogin({
        startServer: startLoopback,
        exchange: (client, code, verifier, redirectUri) => g.exchangeCode(client, code, verifier, redirectUri),
        pkce: createPkce,
        state: randomState,
        setTimeout: realTimers.setTimeout,
        clearTimeout: realTimers.clearTimeout,
        onToken: (refreshToken) => {
          save({ ...settings, refreshToken });
          source?.clearToken();
          watcher?.start();
        },
        log,
      });
      const src = source;
      watcher = new LiveWatcher(() => settings, { findLive: (st) => src.findLive(st) }, new OneCommeClient(fetchFn), realTimers, log);
      watcher.start();
      log("started");
    } catch (e) {
      log(`init failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  },

  destroy(): void {
    try {
      login?.cancel();
      watcher?.stop();
      watcher = null;
    } catch {
      // わんコメを止めない
    }
  },

  async request(req: PluginRequest): Promise<PluginResponse> {
    try {
      return await handle(req);
    } catch (e) {
      log(`request failed: ${e instanceof Error ? e.message : "unknown"}`);
      return { code: 500, response: { error: "internal" } };
    }
  },
};

export default plugin;
