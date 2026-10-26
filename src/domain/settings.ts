import { parseChannelInput } from "./channel";
import { err, isRecord, ok, type Result } from "./result";

export interface Settings {
  apiKey: string;
  channel: string;
  serviceId: string;
  intervalSec: number;
  enabled: boolean;
}

export const MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 3600;

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  channel: "",
  serviceId: "",
  intervalSec: MIN_INTERVAL_SEC,
  enabled: true,
};

const API_KEY = /^[A-Za-z0-9_-]{1,200}$/;
const SERVICE_ID = /^[A-Za-z0-9-]{1,64}$/;

// 設定画面から来た値（信用しない）を検証して、今の設定に反映した新しい設定を返す。
// エラー時は不正だった項目名を返す
export function applySettingsPatch(current: Settings, patch: unknown): Result<Settings> {
  if (!isRecord(patch)) return err("body");
  const next: Settings = { ...current };

  if (patch["clearApiKey"] === true) next.apiKey = "";
  if ("apiKey" in patch) {
    const v = patch["apiKey"];
    if (typeof v !== "string") return err("apiKey");
    const key = v.trim();
    if (key !== "") {
      if (!API_KEY.test(key)) return err("apiKey");
      next.apiKey = key;
    }
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
  if ("enabled" in patch) {
    const v = patch["enabled"];
    if (typeof v !== "boolean") return err("enabled");
    next.enabled = v;
  }
  return ok(next);
}

// 保存済みの値（壊れているかもしれない）を Settings に直す
export function loadSettings(raw: unknown): Settings {
  const r = applySettingsPatch(DEFAULT_SETTINGS, raw);
  if (r.ok) return r.value;
  // 1 項目ずつ試して、使えるものだけ拾う
  let s = { ...DEFAULT_SETTINGS };
  if (isRecord(raw)) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const one = applySettingsPatch(s, { [key]: raw[key] });
      if (one.ok) s = one.value;
    }
  }
  return s;
}

export type PublicSettings = Omit<Settings, "apiKey"> & { hasApiKey: boolean };

export function publicSettings(s: Settings): PublicSettings {
  const { apiKey, ...rest } = s;
  return { ...rest, hasApiKey: apiKey !== "" };
}
