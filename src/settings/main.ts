// 設定画面（http://localhost:11180/plugins/<uid>/index.html）
import { AUTH_ENDPOINT } from "../domain/oauth";
import { isRecord } from "../domain/result";
import { VIDEO_ID, watchUrl } from "../domain/video_url";
import { PLUGIN_UID } from "../plugin_uid";

const PLUGIN_API = `/api/plugins/${PLUGIN_UID}`;
const SERVICES_API = "/api/services";

const FIELD_LABEL: Record<string, string> = {
  apiKey: "API キーの形式が正しくありません",
  channel: "チャンネルは「@ハンドル」かチャンネル URL で入力してください",
  oauthClientId: "OAuth クライアント ID は「〜.apps.googleusercontent.com」の形で入力してください",
  oauthClientSecret: "OAuth クライアント シークレットの形式が正しくありません",
  authMode: "配信の探し方を選んでください",
  serviceId: "枠の指定が正しくありません",
  intervalSec: "間隔は数字で入力してください",
  enabled: "オン・オフの値が正しくありません",
};

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

const ui = {
  badge: el<HTMLSpanElement>("status-badge"),
  statusMessage: el<HTMLSpanElement>("status-message"),
  statusVideo: el<HTMLAnchorElement>("status-video"),
  form: el<HTMLFormElement>("form"),
  enabled: el<HTMLInputElement>("enabled"),
  modeOauth: el<HTMLInputElement>("mode-oauth"),
  modeApiKey: el<HTMLInputElement>("mode-apiKey"),
  sectionOauth: el<HTMLDivElement>("section-oauth"),
  sectionApiKey: el<HTMLDivElement>("section-apiKey"),
  oauthClientId: el<HTMLInputElement>("oauthClientId"),
  oauthClientSecret: el<HTMLInputElement>("oauthClientSecret"),
  clearSecretRow: el<HTMLLabelElement>("clearSecret-row"),
  clearOauthClientSecret: el<HTMLInputElement>("clearOauthClientSecret"),
  loginBadge: el<HTMLSpanElement>("login-badge"),
  oauthLogin: el<HTMLButtonElement>("oauth-login"),
  oauthLogout: el<HTMLButtonElement>("oauth-logout"),
  loginMessage: el<HTMLParagraphElement>("login-message"),
  authLink: el<HTMLAnchorElement>("auth-link"),
  apiKey: el<HTMLInputElement>("apiKey"),
  clearApiKeyRow: el<HTMLLabelElement>("clearApiKey-row"),
  clearApiKey: el<HTMLInputElement>("clearApiKey"),
  channel: el<HTMLInputElement>("channel"),
  serviceId: el<HTMLSelectElement>("serviceId"),
  reloadServices: el<HTMLButtonElement>("reload-services"),
  intervalSec: el<HTMLInputElement>("intervalSec"),
  save: el<HTMLButtonElement>("save"),
  check: el<HTMLButtonElement>("check"),
  message: el<HTMLParagraphElement>("message"),
};

const STATE_LABEL: Record<string, string> = {
  stopped: "停止中",
  "needs-config": "設定が必要",
  waiting: "待機中",
  set: "セット済み",
  "already-set": "セット済み",
  error: "エラー",
};

interface Snapshot {
  settings: {
    enabled: boolean;
    authMode: "apiKey" | "oauth";
    channel: string;
    oauthClientId: string;
    serviceId: string;
    intervalSec: number;
    hasApiKey: boolean;
    hasClientSecret: boolean;
    loggedIn: boolean;
  };
  status: { state: string; message: string; videoId: string | null } | null;
  login: { state: string; message: string } | null;
  authUrl: string | null;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

// わんコメのプラグイン API の応答は { code, response } か response 部分のどちらでも受ける
function unwrap(v: unknown): unknown {
  return isRecord(v) && isRecord(v["response"]) ? v["response"] : v;
}

function toSnapshot(v: unknown): Snapshot | null {
  const body = unwrap(v);
  if (!isRecord(body) || !isRecord(body["settings"])) return null;
  const s = body["settings"];
  const st = body["status"];
  const lg = body["login"];
  const authUrl = str(body["authUrl"]);
  return {
    settings: {
      enabled: s["enabled"] === true,
      authMode: s["authMode"] === "oauth" ? "oauth" : "apiKey",
      channel: str(s["channel"]),
      oauthClientId: str(s["oauthClientId"]),
      serviceId: str(s["serviceId"]),
      intervalSec: typeof s["intervalSec"] === "number" ? s["intervalSec"] : 60,
      hasApiKey: s["hasApiKey"] === true,
      hasClientSecret: s["hasClientSecret"] === true,
      loggedIn: s["loggedIn"] === true,
    },
    status: isRecord(st)
      ? {
          state: str(st["state"]),
          message: str(st["message"]),
          videoId: typeof st["videoId"] === "string" && VIDEO_ID.test(st["videoId"]) ? st["videoId"] : null,
        }
      : null,
    login: isRecord(lg) ? { state: str(lg["state"]), message: str(lg["message"]) } : null,
    // Google のログイン画面以外は開かない
    authUrl: authUrl.startsWith(`${AUTH_ENDPOINT}?`) ? authUrl : null,
  };
}

function showMessage(text: string, isError = false): void {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

function selectedMode(): "apiKey" | "oauth" {
  return ui.modeOauth.checked ? "oauth" : "apiKey";
}

function showModeSections(): void {
  const mode = selectedMode();
  ui.sectionOauth.hidden = mode !== "oauth";
  ui.sectionApiKey.hidden = mode !== "apiKey";
}

let selectedServiceId = "";

function render(snap: Snapshot, fillForm: boolean): void {
  const st = snap.status;
  const state = st?.state ?? "stopped";
  ui.badge.className = `badge ${state}`;
  ui.badge.textContent = STATE_LABEL[state] ?? state;
  ui.statusMessage.textContent = st?.message ?? "";
  if (st?.videoId) {
    ui.statusVideo.hidden = false;
    ui.statusVideo.href = watchUrl(st.videoId);
    ui.statusVideo.textContent = st.videoId;
  } else {
    ui.statusVideo.hidden = true;
  }

  const s = snap.settings;
  ui.apiKey.placeholder = s.hasApiKey ? "設定済み（変える時だけ入力）" : "未設定";
  ui.clearApiKeyRow.hidden = !s.hasApiKey;
  ui.oauthClientSecret.placeholder = s.hasClientSecret ? "設定済み（変える時だけ入力）" : "未設定";
  ui.clearSecretRow.hidden = !s.hasClientSecret;
  ui.loginBadge.textContent = s.loggedIn ? "ログイン済み" : "未ログイン";
  ui.loginBadge.className = s.loggedIn ? "badge logged-in" : "badge";
  ui.oauthLogout.hidden = !s.loggedIn;
  ui.oauthLogin.textContent = s.loggedIn ? "ログインし直す" : "Google でログイン";
  const lg = snap.login;
  ui.loginMessage.textContent = lg && lg.state !== "idle" ? lg.message : "";
  if (lg?.state !== "waiting") ui.authLink.hidden = true;

  if (fillForm) {
    ui.enabled.checked = s.enabled;
    ui.modeOauth.checked = s.authMode === "oauth";
    ui.modeApiKey.checked = s.authMode === "apiKey";
    ui.oauthClientId.value = s.oauthClientId;
    ui.channel.value = s.channel;
    ui.intervalSec.value = String(s.intervalSec);
    selectedServiceId = s.serviceId;
    ui.serviceId.value = selectedServiceId;
    showModeSections();
  }
}

async function call(method: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(PLUGIN_API, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

async function refreshStatus(): Promise<Snapshot | null> {
  const { data } = await call("GET");
  const snap = toSnapshot(data);
  if (snap) render(snap, false);
  return snap;
}

async function loadServices(): Promise<void> {
  ui.serviceId.replaceChildren(new Option("（選んでください）", ""));
  try {
    const res = await fetch(SERVICES_API);
    const list: unknown = await res.json();
    if (!Array.isArray(list)) throw new Error("bad");
    for (const item of list as unknown[]) {
      if (!isRecord(item) || typeof item["id"] !== "string") continue;
      // Option のテキストは HTML として解釈されない
      ui.serviceId.add(new Option(`${str(item["name"])}  ${str(item["url"])}`.trim(), item["id"]));
    }
  } catch {
    showMessage("わんコメの枠一覧を取得できませんでした", true);
  }
  ui.serviceId.value = selectedServiceId;
}

async function load(): Promise<void> {
  try {
    const { ok, data } = await call("GET");
    const snap = toSnapshot(data);
    if (!ok || !snap) throw new Error("bad");
    render(snap, true);
  } catch {
    showMessage("プラグインの設定を読み込めませんでした。プラグインが有効か確認してください", true);
  }
}

function errorField(data: unknown): string {
  const body = unwrap(data);
  return isRecord(body) ? str(body["field"]) : "";
}

async function save(e: Event): Promise<void> {
  e.preventDefault();
  ui.save.disabled = true;
  try {
    const interval = Number(ui.intervalSec.value);
    const { ok, data } = await call("PUT", {
      enabled: ui.enabled.checked,
      authMode: selectedMode(),
      apiKey: ui.apiKey.value,
      clearApiKey: ui.clearApiKey.checked,
      channel: ui.channel.value,
      oauthClientId: ui.oauthClientId.value,
      oauthClientSecret: ui.oauthClientSecret.value,
      clearOauthClientSecret: ui.clearOauthClientSecret.checked,
      serviceId: ui.serviceId.value,
      intervalSec: Number.isFinite(interval) ? interval : 60,
    });
    const snap = toSnapshot(data);
    if (!ok || !snap) {
      showMessage(FIELD_LABEL[errorField(data)] ?? "保存できませんでした", true);
      return;
    }
    ui.apiKey.value = "";
    ui.oauthClientSecret.value = "";
    ui.clearApiKey.checked = false;
    ui.clearOauthClientSecret.checked = false;
    render(snap, true);
    showMessage("保存しました");
  } catch {
    showMessage("保存できませんでした", true);
  } finally {
    ui.save.disabled = false;
  }
}

async function checkNow(): Promise<void> {
  ui.check.disabled = true;
  showMessage("確認しています…");
  try {
    const { ok, data } = await call("POST", { action: "check" });
    const snap = toSnapshot(data);
    if (!ok || !snap) throw new Error("bad");
    render(snap, false);
    showMessage("確認しました");
  } catch {
    showMessage("確認できませんでした", true);
  } finally {
    ui.check.disabled = false;
  }
}

let loginPoll: ReturnType<typeof setInterval> | null = null;

async function startLogin(): Promise<void> {
  ui.oauthLogin.disabled = true;
  try {
    const { ok, data } = await call("POST", { action: "oauthStart" });
    const snap = toSnapshot(data);
    if (!ok || !snap?.authUrl) {
      const body = unwrap(data);
      showMessage(isRecord(body) ? str(body["message"], "ログインを始められませんでした") : "ログインを始められませんでした", true);
      return;
    }
    render(snap, false);
    ui.authLink.href = snap.authUrl;
    ui.authLink.hidden = false;
    window.open(snap.authUrl, "_blank", "noopener");
    // ログインが終わるまで 2 秒ごとに様子を見る
    if (loginPoll !== null) clearInterval(loginPoll);
    loginPoll = setInterval(() => {
      void refreshStatus().then((s) => {
        if (s?.login?.state !== "waiting" && loginPoll !== null) {
          clearInterval(loginPoll);
          loginPoll = null;
        }
      });
    }, 2000);
  } catch {
    showMessage("ログインを始められませんでした", true);
  } finally {
    ui.oauthLogin.disabled = false;
  }
}

async function logout(): Promise<void> {
  if (!window.confirm("ログアウトしますか？（Google 側の許可も取り消します）")) return;
  try {
    const { data } = await call("POST", { action: "oauthLogout" });
    const snap = toSnapshot(data);
    if (snap) render(snap, false);
    showMessage("ログアウトしました");
  } catch {
    showMessage("ログアウトできませんでした", true);
  }
}

ui.form.addEventListener("submit", (e) => void save(e));
ui.check.addEventListener("click", () => void checkNow());
ui.reloadServices.addEventListener("click", () => void loadServices());
ui.oauthLogin.addEventListener("click", () => void startLogin());
ui.oauthLogout.addEventListener("click", () => void logout());
ui.modeOauth.addEventListener("change", showModeSections);
ui.modeApiKey.addEventListener("change", showModeSections);
ui.serviceId.addEventListener("change", () => {
  selectedServiceId = ui.serviceId.value;
});

// 状態表示だけ 10 秒ごとに更新（入力中の値は上書きしない）
setInterval(() => void refreshStatus().catch(() => undefined), 10_000);

void load().then(loadServices);
