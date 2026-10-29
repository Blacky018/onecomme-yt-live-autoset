import { parseChannelInput } from "./channel";
import { CLIENT_ID, CLIENT_SECRET, isStoredToken } from "./oauth";
import { err, isRecord, ok, type Result } from "./result";

export type AuthMode = "apiKey" | "oauth";

export interface Settings {
  enabled: boolean;
  authMode: AuthMode;
  apiKey: string;
  channel: string;
  oauthClientId: string;
  oauthClientSecret: string;
  // ログインで得たトークン。設定画面からは書けない
  refreshToken: string;
  serviceId: string;
  intervalSec: number;
  // 配信前に予約枠を先にセットする
  presetUpcoming: boolean;
  // 配信中の枠を見つけたら、わんコメの枠の接続がオフでもオンにする（同じ配信では 1 回だけ）
  autoConnectLive: boolean;
}

export const MIN_INTERVAL_SEC = 30;
// API キー方式は 1 回 2 units 使うので下限を長めにする
export const API_KEY_MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 3600;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  authMode: "apiKey",
  apiKey: "",
  channel: "",
  oauthClientId: "",
  oauthClientSecret: "",
  refreshToken: "",
  serviceId: "",
  intervalSec: MIN_INTERVAL_SEC,
  presetUpcoming: true,
  autoConnectLive: true,
};

// 実際に使う確認間隔（方式ごとの下限で切り上げ）
export function effectiveIntervalSec(s: Settings): number {
  return s.authMode === "apiKey" ? Math.max(s.intervalSec, API_KEY_MIN_INTERVAL_SEC) : s.intervalSec;
}

const API_KEY = /^[A-Za-z0-9_-]{1,200}$/;
const SERVICE_ID = /^[A-Za-z0-9-]{1,64}$/;

// 秘密の値: 空文字なら「変えない」、clear フラグで消す
function applySecret(
  current: string,
  patch: Record<string, unknown>,
  key: string,
  clearKey: string,
  pattern: RegExp,
): Result<string> {
  let value = patch[clearKey] === true ? "" : current;
  if (key in patch) {
    const v = patch[key];
    if (typeof v !== "string") return err(key);
    const trimmed = v.trim();
    if (trimmed !== "") {
      if (!pattern.test(trimmed)) return err(key);
      value = trimmed;
    }
  }
  return ok(value);
}

// 設定画面から来た値（信用しない）を検証して、今の設定に反映した新しい設定を返す。
// エラー時は不正だった項目名を返す。refreshToken はここでは変えられない
export function applySettingsPatch(current: Settings, patch: unknown): Result<Settings> {
  if (!isRecord(patch)) return err("body");
  const next: Settings = { ...current };

  const apiKey = applySecret(current.apiKey, patch, "apiKey", "clearApiKey", API_KEY);
  if (!apiKey.ok) return apiKey;
  next.apiKey = apiKey.value;

  const secret = applySecret(current.oauthClientSecret, patch, "oauthClientSecret", "clearOauthClientSecret", CLIENT_SECRET);
  if (!secret.ok) return secret;
  next.oauthClientSecret = secret.value;

  if ("authMode" in patch) {
    const v = patch["authMode"];
    if (v !== "apiKey" && v !== "oauth") return err("authMode");
    next.authMode = v;
  }
  if ("oauthClientId" in patch) {
    const v = patch["oauthClientId"];
    if (typeof v !== "string") return err("oauthClientId");
    const id = v.trim();
    if (id !== "" && !CLIENT_ID.test(id)) return err("oauthClientId");
    // クライアントが変わったら以前のログインは使えない
    if (id !== current.oauthClientId) next.refreshToken = "";
    next.oauthClientId = id;
  }
  if ("channel" in patch) {
    const v = patch["channel"];
    if (typeof v !== "string") return err("channel");
    const channel = v.trim();
    if (channel !== "" && !parseChannelInput(channel).ok) return err("channel");
    next.channel = channel;
  }
  if ("serviceId" in patch) {
    const v = patch["serviceId"];
    if (typeof v !== "string" || (v !== "" && !SERVICE_ID.test(v))) return err("serviceId");
    next.serviceId = v;
  }
  if ("intervalSec" in patch) {
    const v = patch["intervalSec"];
    if (typeof v !== "number" || !Number.isFinite(v)) return err("intervalSec");
    next.intervalSec = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.floor(v)));
  }
  for (const key of ["enabled", "presetUpcoming", "autoConnectLive"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (typeof v !== "boolean") return err(key);
    next[key] = v;
  }
  return ok(next);
}

// 保存済みの値（壊れているかもしれない）を Settings に直す。使える項目だけ拾う
export function loadSettings(raw: unknown): Settings {
  let s = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return s;
  // oauthClientId を先に入れると refreshToken が消えるので、トークンは最後に入れる
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === "refreshToken" || !(key in raw)) continue;
    const one = applySettingsPatch(s, { [key]: raw[key] });
    if (one.ok) s = one.value;
  }
  if (isStoredToken(raw["refreshToken"]) && s.oauthClientId !== "") s.refreshToken = raw["refreshToken"];
  return s;
}

// 設定がそろっているか。足りなければ利用者向けの説明を返す
export function missingConfig(s: Settings): string | null {
  if (s.serviceId === "") return "書き換えるわんコメの枠を選んでください";
  if (s.authMode === "apiKey") {
    if (s.apiKey === "" || s.channel === "") return "API キーとチャンネルを設定してください";
    return null;
  }
  if (s.oauthClientId === "" || s.oauthClientSecret === "") return "OAuth クライアント ID とシークレットを設定してください";
  if (s.refreshToken === "") return "「Google でログイン」を押してください";
  return null;
}

export type PublicSettings = Omit<Settings, "apiKey" | "oauthClientSecret" | "refreshToken"> & {
  hasApiKey: boolean;
  hasClientSecret: boolean;
  loggedIn: boolean;
};

export function publicSettings(s: Settings): PublicSettings {
  const { apiKey, oauthClientSecret, refreshToken, ...rest } = s;
  return { ...rest, hasApiKey: apiKey !== "", hasClientSecret: oauthClientSecret !== "", loggedIn: refreshToken !== "" };
}
