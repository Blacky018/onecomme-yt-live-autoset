// わんコメ プラグインの入口。わんコメとの接続だけを書き、処理は app / infra に任せる
import { LiveWatcher, type Timers } from "./app/watcher";
import { isRecord } from "./domain/result";
import { applySettingsPatch, DEFAULT_SETTINGS, loadSettings, publicSettings, type Settings } from "./domain/settings";
import { OneCommeClient } from "./infra/onecomme_client";
import { YouTubeClient } from "./infra/youtube_client";
import { PLUGIN_UID } from "./plugin_uid";

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

const log = (msg: string) => console.log(`[yt-live-autoset] ${msg}`);

let store: PluginStore | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let watcher: LiveWatcher | null = null;

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function snapshot(): unknown {
  return { settings: publicSettings(settings), status: watcher?.getStatus() ?? null };
}

async function handle(req: PluginRequest): Promise<PluginResponse> {
  switch (req.method) {
    case "GET":
      return { code: 200, response: snapshot() };
    case "PUT": {
      const next = applySettingsPatch(settings, parseBody(req.body));
      if (!next.ok) return { code: 400, response: { error: "invalid", field: next.error } };
      settings = next.value;
      store?.set(SETTINGS_KEY, settings);
      watcher?.start(); // 新しい設定ですぐ確認し直す
      return { code: 200, response: snapshot() };
    }
    case "POST": {
      const body = parseBody(req.body);
      if (!isRecord(body) || body["action"] !== "check") return { code: 400, response: { error: "invalid" } };
      await watcher?.checkNow();
      return { code: 200, response: snapshot() };
    }
    default:
      return { code: 404, response: {} };
  }
}

const plugin = {
  name: "YouTube 配信 URL 自動セット（非公式）",
  uid: PLUGIN_UID,
  version: "0.1.0",
  author: "りーと",
  url: `http://localhost:11180/plugins/${PLUGIN_UID}/index.html`,
  permissions: [] as string[],
  defaultState: { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } },

  init({ store: s }: { store: PluginStore }): void {
    try {
      store = s;
      settings = loadSettings(s.get(SETTINGS_KEY));
      const fetchFn = (url: string, init?: RequestInit) => fetch(url, init);
      watcher = new LiveWatcher(
        () => settings,
        new YouTubeClient(fetchFn, () => settings.apiKey),
        new OneCommeClient(fetchFn),
        realTimers,
        log,
      );
      watcher.start();
      log("started");
    } catch (e) {
      log(`init failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  },

  destroy(): void {
    try {
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
