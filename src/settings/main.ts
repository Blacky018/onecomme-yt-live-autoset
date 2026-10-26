// 設定画面（http://localhost:11180/plugins/<uid>/index.html）
import { isRecord } from "../domain/result";
import { VIDEO_ID, watchUrl } from "../domain/video_url";
import { PLUGIN_UID } from "../plugin_uid";

const PLUGIN_API = `/api/plugins/${PLUGIN_UID}`;
const SERVICES_API = "/api/services";

const FIELD_LABEL: Record<string, string> = {
  apiKey: "API キーの形式が正しくありません",
  channel: "チャンネルは「@ハンドル」かチャンネル URL で入力してください",
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
  apiKey: el<HTMLInputElement>("apiKey"),
  apiKeyHint: el<HTMLParagraphElement>("apiKey-hint"),
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
  settings: { enabled: boolean; channel: string; serviceId: string; intervalSec: number; hasApiKey: boolean };
  status: { state: string; message: string; videoId: string | null } | null;
}

function toSnapshot(v: unknown): Snapshot | null {
  // わんコメのプラグイン API は { code, response } ではなく response 部分を返す想定。両方に対応
  const body = isRecord(v) && isRecord(v["response"]) ? v["response"] : v;
  if (!isRecord(body) || !isRecord(body["settings"])) return null;
  const s = body["settings"];
  const st = body["status"];
  return {
    settings: {
      enabled: s["enabled"] === true,
      channel: typeof s["channel"] === "string" ? s["channel"] : "",
      serviceId: typeof s["serviceId"] === "string" ? s["serviceId"] : "",
      intervalSec: typeof s["intervalSec"] === "number" ? s["intervalSec"] : 60,
      hasApiKey: s["hasApiKey"] === true,
    },
    status: isRecord(st)
      ? {
          state: typeof st["state"] === "string" ? st["state"] : "",
          message: typeof st["message"] === "string" ? st["message"] : "",
          videoId: typeof st["videoId"] === "string" && VIDEO_ID.test(st["videoId"]) ? st["videoId"] : null,
        }
      : null,
  };
}

function showMessage(text: string, isError = false): void {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
}

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
  ui.apiKey.placeholder = snap.settings.hasApiKey ? "設定済み（変える時だけ入力）" : "未設定";
  ui.clearApiKey.parentElement!.hidden = !snap.settings.hasApiKey;
  if (fillForm) {
    ui.enabled.checked = snap.settings.enabled;
    ui.channel.value = snap.settings.channel;
    ui.intervalSec.value = String(snap.settings.intervalSec);
    selectedServiceId = snap.settings.serviceId;
    ui.serviceId.value = selectedServiceId;
  }
}

let selectedServiceId = "";

async function call(method: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(PLUGIN_API, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

async function loadServices(): Promise<void> {
  ui.serviceId.replaceChildren(new Option("（選んでください）", ""));
  try {
    const res = await fetch(SERVICES_API);
    const list: unknown = await res.json();
    if (!Array.isArray(list)) throw new Error("bad");
    for (const item of list as unknown[]) {
      if (!isRecord(item) || typeof item["id"] !== "string") continue;
      const name = typeof item["name"] === "string" ? item["name"] : "";
      const url = typeof item["url"] === "string" ? item["url"] : "";
      // Option のテキストは textContent 扱いなので HTML として解釈されない
      ui.serviceId.add(new Option(`${name}  ${url}`.trim(), item["id"]));
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

async function save(e: Event): Promise<void> {
  e.preventDefault();
  ui.save.disabled = true;
  try {
    const interval = Number(ui.intervalSec.value);
    const { ok, data } = await call("PUT", {
      enabled: ui.enabled.checked,
      apiKey: ui.apiKey.value,
      clearApiKey: ui.clearApiKey.checked,
      channel: ui.channel.value,
      serviceId: ui.serviceId.value,
      intervalSec: Number.isFinite(interval) ? interval : 60,
    });
    const snap = toSnapshot(data);
    if (!ok || !snap) {
      const body = isRecord(data) && isRecord(data["response"]) ? data["response"] : data;
      const field = isRecord(body) && typeof body["field"] === "string" ? body["field"] : "";
      showMessage(FIELD_LABEL[field] ?? "保存できませんでした", true);
      return;
    }
    ui.apiKey.value = "";
    ui.clearApiKey.checked = false;
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

ui.form.addEventListener("submit", (e) => void save(e));
ui.check.addEventListener("click", () => void checkNow());
ui.reloadServices.addEventListener("click", () => void loadServices());
ui.serviceId.addEventListener("change", () => {
  selectedServiceId = ui.serviceId.value;
});

// 状態表示だけ 10 秒ごとに更新（入力中の値は上書きしない）
setInterval(() => {
  void call("GET")
    .then(({ data }) => {
      const snap = toSnapshot(data);
      if (snap) render(snap, false);
    })
    .catch(() => undefined);
}, 10_000);

void load().then(loadServices);
